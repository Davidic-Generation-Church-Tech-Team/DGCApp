import { prisma } from '../../infra/db';
import { buildRtcToken, isAgoraConfigured } from '../../infra/agora';
import { emitToUser, emitToAudioRoom, emitToChannelExcept, emitCallEnded, joinAudioRoom, leaveAudioRoom } from '../../infra/realtime';
import { openStation, closeStation } from './station';
import { notificationQueue } from '../../infra/queue';
import { enqueue, dropJob } from '../../infra/enqueue';
import { pushService } from '../push/push.service';
import { redis, withDeadline } from '../../infra/redis';
import { logger } from '../../infra/logger';
import { readPresence } from '../chat/chat.socket';
import { cached, cacheKeys } from '../../infra/cache';
import { BadRequest, Forbidden, NotFound, TooManyRequests } from '../../utils/errors';
import { canCreateForScope, canModerateScoped } from '../../utils/authorization';
import { env } from '../../config/env';
import type { CreateRoomInput, UpdateRoomInput } from './audio-rooms.schema';

const ROOM_SELECT = {
  id: true,
  title: true,
  description: true,
  channelId: true,
  branchId: true,
  clusterId: true,
  hostId: true,
  status: true,
  scheduledFor: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  playbackUrl: true,
} as const;

const CHANNEL_CALL_RING_TTL_MS = 30_000;
// Each new channel call rings (socket + push) every member, so one user may start at most one
// new call per channel in this window. Joining a live call is never limited.
const CHANNEL_CALL_START_COOLDOWN_S = 120;
// After a call ends, ignore new starts for as long as that ring can still be on a phone.
// A late join or a retried start must not open a second call.
const CALL_ENDED_BLOCK_S = CHANNEL_CALL_RING_TTL_MS / 1000;

const CHANNEL_CALL_SELECT = {
  id: true,
  title: true,
  channelId: true,
  hostId: true,
  branchId: true,
  clusterId: true,
  type: true,
  playbackUrl: true,
  startedAt: true,
  createdAt: true,
} as const;

const FREE_MIC_LIMIT = 3;

type CrowdScope = {
  id?: string;
  hostId: string;
  channelId?: string | null;
  branchId: string | null;
  clusterId: string | null;
  type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL';
  playbackUrl?: string | null;
};

// Starter, super admin, and anyone who can moderate this room. A member on a free mic is not in this set.
async function protectedMicIds(
  room: CrowdScope,
  people: { userId: string; globalRole?: string | null }[],
): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  for (const person of people) {
    if (person.userId === room.hostId || person.globalRole === 'SUPER_ADMIN') protectedIds.add(person.userId);
  }
  const rest = people.map((person) => person.userId).filter((id) => !protectedIds.has(id));
  if (!rest.length) return protectedIds;

  if (room.channelId) {
    const rows = await prisma.channelMembership.findMany({
      where: { channelId: room.channelId, userId: { in: rest }, role: { in: ['ADMIN', 'MODERATOR'] } },
      select: { userId: true },
    });
    for (const row of rows) protectedIds.add(row.userId);
  }

  const still = rest.filter((id) => !protectedIds.has(id));
  if (!still.length) return protectedIds;

  if (room.type === 'PRAYER_WATCH') {
    const [branchAdmins, clusterMods] = await Promise.all([
      prisma.branchMembership.findMany({ where: { userId: { in: still }, role: 'ADMIN' }, select: { userId: true } }),
      prisma.clusterMembership.findMany({ where: { userId: { in: still }, role: 'MODERATOR' }, select: { userId: true } }),
    ]);
    for (const row of [...branchAdmins, ...clusterMods]) protectedIds.add(row.userId);
  } else {
    const lookups: Promise<{ userId: string }[]>[] = [];
    if (room.branchId) {
      lookups.push(prisma.branchMembership.findMany({
        where: { branchId: room.branchId, userId: { in: still }, role: 'ADMIN' },
        select: { userId: true },
      }));
    }
    if (room.clusterId) {
      lookups.push(prisma.clusterMembership.findMany({
        where: { clusterId: room.clusterId, userId: { in: still }, role: 'MODERATOR' },
        select: { userId: true },
      }));
    }
    for (const row of (await Promise.all(lookups)).flat()) protectedIds.add(row.userId);
  }
  return protectedIds;
}

async function countFreeMics(room: CrowdScope & { id: string }): Promise<number> {
  const holders = await prisma.audioRoomParticipant.findMany({
    where: { roomId: room.id, leftAt: null, role: { in: ['HOST', 'SPEAKER'] } },
    select: { userId: true, user: { select: { globalRole: true } } },
  });
  const protectedIds = await protectedMicIds(
    room,
    holders.map((holder) => ({ userId: holder.userId, globalRole: holder.user.globalRole })),
  );
  return holders.filter((holder) => !protectedIds.has(holder.userId)).length;
}

function emitPlayback(userId: string, roomId: string, playbackUrl: string | null) {
  emitToUser(userId, 'audio-room:playback', { roomId, playbackUrl });
}

const LAST_MIC_MESSAGE = 'The last person on the call keeps the mic';

// A phone that opts into the station is not a person on the call. No row, no socket, no shout.
function listensOffTheRoll(
  preferPlayback: boolean,
  participantRole: 'HOST' | 'SPEAKER' | 'LISTENER',
  roomType: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL',
) {
  return preferPlayback && participantRole === 'LISTENER' && isOpenMicRoom(roomType);
}

function stationIsUp(room: { type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL'; playbackUrl?: string | null }) {
  return isOpenMicRoom(room.type) && !!room.playbackUrl;
}

async function onlyPersonOnTheCall(roomId: string): Promise<boolean> {
  const stillHere = await prisma.audioRoomParticipant.count({ where: { roomId, leftAt: null } });
  return stillHere <= 1;
}

// Leaves the call roll. The phone then plays the station. Mic holders still in the room hear user-left.
async function releaseFromRoll(roomId: string, userId: string, participantId: string) {
  await prisma.audioRoomParticipant.update({
    where: { id: participantId },
    data: { leftAt: new Date() },
  });
  leaveAudioRoom(userId, roomId);
  emitToAudioRoom(roomId, 'audio-room:user-left', { roomId, userId });
}

const PARTICIPANT_SELECT = {
  id: true,
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { id: true, displayName: true, avatarUrl: true } },
} as const;

export function stableUid(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 2_000_000_000) || 1;
}

function withAgoraUid<T extends { userId: string }>(p: T): T & { agoraUid: number } {
  return { ...p, agoraUid: stableUid(p.userId) };
}

function isOpenMicRoom(type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL') {
  return type === 'PRAYER_WATCH' || type === 'CHANNEL_CALL';
}

// Old phones omit preferPlayback and stay speakers. A phone that opts in leaves the mic
// for the starter and for admins. Everyone else listens on the station.
async function roleForCrowdJoin(
  userId: string,
  globalRole: string,
  room: CrowdScope,
  preferPlayback: boolean,
): Promise<'SPEAKER' | 'LISTENER'> {
  if (!preferPlayback || !isOpenMicRoom(room.type)) return 'SPEAKER';
  if (room.hostId === userId) return 'SPEAKER';
  const allowed = await canModerateRoom(userId, globalRole, {
    hostId: room.hostId,
    channelId: room.channelId,
    branchId: room.branchId,
    clusterId: room.clusterId,
    type: room.type,
  });
  return allowed ? 'SPEAKER' : 'LISTENER';
}

function isChannelModerator(globalRole: string, membershipRole?: string) {
  return globalRole === 'SUPER_ADMIN' || membershipRole === 'ADMIN' || membershipRole === 'MODERATOR';
}

function channelDisplayName(channel: {
  type: string;
  name: string | null;
  branch: { name: string } | null;
  cluster: { name: string } | null;
}) {
  if (channel.type === 'BRANCH_SECTION' && channel.branch?.name && channel.name) {
    return `${channel.branch.name} - ${channel.name}`;
  }
  return channel.name ?? channel.cluster?.name ?? channel.branch?.name ?? 'Channel';
}

function audioRoomPushData(roomId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'audio_room',
    notificationType: 'SYSTEM',
    route: 'AUDIO_ROOM',
    screen: 'AUDIO_ROOM',
    clickAction: 'OPEN_AUDIO_ROOM',
    androidChannelId: 'audio_rooms',
    roomId,
    deepLink: `dgc://audio-rooms/${roomId}`,
    ...extra,
  };
}

// Moderation gate. For general rooms it defers to canModerateScoped (super admin, room host,
// branch admin for room's branch, cluster mod for room's cluster). For Prayer Watch — which is
// org-wide with no branch/cluster of its own — it additionally accepts ANY admin/moderator
// title in the app (any branch admin, any cluster mod). This lets any admin/mod kick a
// disruptive participant from the Global Prayer Watch call. Force-end stays narrower (Prayer
// Warriors mod + super admin only, checked separately in prayer-watch.service).
async function canModerateRoom(
  userId: string,
  role: string,
  room: {
    hostId: string;
    channelId?: string | null;
    branchId: string | null;
    clusterId: string | null;
    type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL';
  },
): Promise<boolean> {
  if (await canModerateScoped(userId, role, { ownerId: room.hostId, branchId: room.branchId, clusterId: room.clusterId })) {
    return true;
  }
  if (room.channelId) {
    const membership = await prisma.channelMembership.findUnique({
      where: { userId_channelId: { userId, channelId: room.channelId } },
      select: { role: true },
    });
    if (membership?.role === 'ADMIN' || membership?.role === 'MODERATOR') return true;
  }
  if (room.type === 'PRAYER_WATCH') {
    // ANY branch admin OR any cluster moderator counts as a moderator on Prayer Watch.
    const [branchAdmin, clusterMod] = await Promise.all([
      prisma.branchMembership.findFirst({ where: { userId, role: 'ADMIN' }, select: { userId: true } }),
      prisma.clusterMembership.findFirst({ where: { userId, role: 'MODERATOR' }, select: { userId: true } }),
    ]);
    if (branchAdmin || clusterMod) return true;
  }
  return false;
}

// Branch-admin / cluster-mod scopes for the `viewer` flags on room detail. Cached briefly because
// room detail is on the join hot path (Prayer Watch rings the whole org). The flags are a UI hint:
// every moderation endpoint still re-checks live through canModerateRoom.
function viewerAdminScopes(userId: string) {
  return cached(cacheKeys.userAdminScopes(userId), 60, async () => {
    const [branches, clusters] = await Promise.all([
      prisma.branchMembership.findMany({ where: { userId, role: 'ADMIN' }, select: { branchId: true } }),
      prisma.clusterMembership.findMany({ where: { userId, role: 'MODERATOR' }, select: { clusterId: true } }),
    ]);
    return { branchIds: branches.map((b) => b.branchId), clusterIds: clusters.map((c) => c.clusterId) };
  });
}

// Same rules as canModerateRoom, evaluated from pre-fetched data (no queries).
function viewerCanModerate(
  userId: string,
  role: string,
  room: { hostId: string; branchId: string | null; clusterId: string | null; type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL' },
  scopes: { branchIds: string[]; clusterIds: string[] },
  channelRole: string | null,
): boolean {
  if (role === 'SUPER_ADMIN' || room.hostId === userId) return true;
  if (room.branchId && scopes.branchIds.includes(room.branchId)) return true;
  if (room.clusterId && scopes.clusterIds.includes(room.clusterId)) return true;
  if (channelRole === 'ADMIN' || channelRole === 'MODERATOR') return true;
  if (room.type === 'PRAYER_WATCH') return scopes.branchIds.length > 0 || scopes.clusterIds.length > 0;
  return false;
}

// Adds a participant only while the room is LIVE. FOR SHARE lets concurrent joins run in parallel
// but serialises against endIfEmpty/end (which lock the row for update), so a join can never land
// in a room that is being closed, and closing never misses a join that just committed.
export function addParticipantIfLive(roomId: string, userId: string, role: 'HOST' | 'SPEAKER' | 'LISTENER') {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "AudioRoom" WHERE "id" = ${roomId} FOR SHARE`;
    if (!rows[0]) throw NotFound('Room not found');
    if (rows[0].status !== 'LIVE') throw BadRequest('Room is not live');
    return tx.audioRoomParticipant.create({ data: { roomId, userId, role }, select: PARTICIPANT_SELECT });
  });
}

function endedCallKey(channelId: string | null, type: string) {
  if (type === 'PRAYER_WATCH') return 'call-ended:prayer-watch';
  if (type === 'CHANNEL_CALL' && channelId) return `call-ended:channel:${channelId}`;
  return null;
}

// True when this channel or Prayer Watch ended a call inside the ring window.
export async function callJustEnded(scope: { channelId?: string | null; type: 'CHANNEL_CALL' | 'PRAYER_WATCH' }) {
  const key = endedCallKey(scope.channelId ?? null, scope.type);
  if (!key) return false;
  const marked = await withDeadline(redis.get(key), 500, null as string | null);
  return Boolean(marked);
}

// Tells everyone still on the call, and everyone still ringing in the channel, that it is over.
// Also drops a ring job that has not started, and blocks a brand-new call for the ring window.
export async function publishRoomEnded(roomId: string, channelId: string | null, type: string) {
  // Prayer Watch rows do not store a channel id. The congregation is already in the global channel socket.
  let heardBy = channelId;
  if (!heardBy && type === 'PRAYER_WATCH') {
    const channel = await prisma.channel.findFirst({
      where: { type: 'GLOBAL_PRAYER_WATCH' },
      select: { id: true },
    });
    heardBy = channel?.id ?? null;
  }
  emitCallEnded(roomId, heardBy);
  await closeStation(roomId);
  const key = endedCallKey(channelId, type);
  if (key) {
    await withDeadline(redis.set(key, roomId, 'EX', CALL_ENDED_BLOCK_S), 500, null as string | null);
  }
  if (type === 'CHANNEL_CALL') dropJob(notificationQueue, `channel-call-started-${roomId}`);
  if (type === 'PRAYER_WATCH') dropJob(notificationQueue, `prayer-watch-live-${roomId}`);
}

// Ends a LIVE room when nobody is left on it. Locks the row so the count can't race a join.
// Returns true only for the caller that actually ended it (so 'ended' is emitted once).
async function endIfEmpty(roomId: string): Promise<boolean> {
  const ended = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; channelId: string | null; type: string }[]>`
      SELECT "status", "channelId", "type" FROM "AudioRoom" WHERE "id" = ${roomId} FOR UPDATE`;
    const row = rows[0];
    if (row?.status !== 'LIVE') return null;
    const remaining = await tx.audioRoomParticipant.count({ where: { roomId, leftAt: null } });
    if (remaining > 0) return null;
    await tx.audioRoom.update({ where: { id: roomId }, data: { status: 'ENDED', endedAt: new Date() } });
    return { channelId: row.channelId, type: row.type };
  });
  if (!ended) return false;
  await publishRoomEnded(roomId, ended.channelId, ended.type);
  return true;
}

async function isLastActiveParticipant(userId: string, roomId: string): Promise<boolean> {
  const active = await prisma.audioRoomParticipant.findMany({
    where: { roomId, leftAt: null },
    select: { userId: true },
    take: 2,
  });
  return active.length === 1 && active[0]?.userId === userId;
}

async function requireChannelMember(userId: string, role: string, channelId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      type: true,
      name: true,
      isReadOnly: true,
      branchId: true,
      clusterId: true,
      branch: { select: { name: true } },
      cluster: { select: { name: true } },
      memberships: {
        where: { userId },
        select: { role: true },
      },
    },
  });
  if (!channel) throw NotFound('Channel not found');
  if (channel.type === 'DM') throw BadRequest('Use DM calls for direct messages');
  if (channel.type === 'GLOBAL_PRAYER_WATCH') throw BadRequest('Use /api/v1/prayer-watch/start for Global Prayer Watch');

  const membership = channel.memberships[0] ?? null;
  if (!membership && role !== 'SUPER_ADMIN') throw Forbidden('You are not a member of this channel');
  return { channel, membership };
}

async function requireChannelCallStarter(userId: string, role: string, channelId: string) {
  const ctx = await requireChannelMember(userId, role, channelId);
  if (ctx.channel.isReadOnly && !isChannelModerator(role, ctx.membership?.role)) {
    throw Forbidden('Only moderators can start calls in read-only channels');
  }
  return ctx;
}

function liveChannelCall(channelId: string) {
  return prisma.audioRoom.findFirst({
    where: { channelId, type: 'CHANNEL_CALL', status: 'LIVE' },
    orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    select: CHANNEL_CALL_SELECT,
  });
}

function channelIncomingPayload(room: {
  id: string;
  title: string;
  channelId: string | null;
  hostId: string;
  createdAt: Date;
}, channelName: string, starter: { id: string; displayName: string | null; avatarUrl: string | null }) {
  const callerName = starter.displayName?.trim() || 'Someone';
  return {
    roomId: room.id,
    channelId: room.channelId,
    title: room.title,
    channelName,
    startedById: starter.id,
    startedByName: callerName,
    callerName,
    callerAvatarUrl: starter.avatarUrl ?? '',
    startedByAvatarUrl: starter.avatarUrl,
    createdAt: room.createdAt,
    expiresAt: new Date(room.createdAt.getTime() + CHANNEL_CALL_RING_TTL_MS),
  };
}

export const audioRoomService = {
  async channelCallStatus(userId: string, role: string, channelId: string) {
    await requireChannelMember(userId, role, channelId);
    const live = await liveChannelCall(channelId);
    if (!live) return { channelId, live: null };
    return {
      channelId,
      live: {
        id: live.id,
        title: live.title,
        channelId: live.channelId,
        hostId: live.hostId,
        playbackUrl: live.playbackUrl,
        startedAt: live.startedAt,
        createdAt: live.createdAt,
      },
    };
  },

  // Joins a call that is already live. If it ended under us, stop. Never open a replacement call.
  async joinLiveCrowdCall(
    userId: string,
    role: string,
    existing: {
      id: string;
      type?: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL';
      hostId?: string;
      channelId?: string | null;
      branchId?: string | null;
      clusterId?: string | null;
      playbackUrl?: string | null;
    },
    known?: { channelRole: string | null },
    preferPlayback = false,
  ) {
    const roomType = existing.type ?? 'CHANNEL_CALL';
    const scope: CrowdScope = {
      id: existing.id,
      hostId: existing.hostId ?? '',
      channelId: existing.channelId,
      branchId: existing.branchId ?? null,
      clusterId: existing.clusterId ?? null,
      type: roomType,
      playbackUrl: existing.playbackUrl,
    };
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId: existing.id, userId, leftAt: null },
      select: { id: true, role: true },
    });
    let participantRole: 'HOST' | 'SPEAKER' | 'LISTENER' = 'SPEAKER';
    if (!p) {
      participantRole = preferPlayback ? await roleForCrowdJoin(userId, role, scope, true) : 'SPEAKER';
      // Listeners play the station and stay out of the roll. A mic is what adds them.
      if (!listensOffTheRoll(preferPlayback, participantRole, roomType)) {
        let created;
        try {
          created = await addParticipantIfLive(existing.id, userId, participantRole);
        } catch (err) {
          if ((err as { message?: string }).message === 'Room is not live') {
            throw BadRequest('This call has ended');
          }
          throw err;
        }
        joinAudioRoom(userId, existing.id);
        emitToAudioRoom(existing.id, 'audio-room:user-joined', withAgoraUid(created));
      }
    } else if (p.role === 'LISTENER') {
      const next = preferPlayback ? await roleForCrowdJoin(userId, role, scope, true) : 'SPEAKER';
      if (next === 'SPEAKER') {
        await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { role: 'SPEAKER' } });
        emitToAudioRoom(existing.id, 'audio-room:role-changed', {
          roomId: existing.id, userId, role: 'SPEAKER',
        });
        participantRole = 'SPEAKER';
      } else if (listensOffTheRoll(preferPlayback, 'LISTENER', roomType)) {
        await releaseFromRoll(existing.id, userId, p.id);
        participantRole = 'LISTENER';
      } else {
        participantRole = 'LISTENER';
      }
    } else {
      participantRole = p.role;
    }
    const audio = this.clientAudio(
      existing.id, userId, participantRole, preferPlayback, existing.playbackUrl ?? null, roomType,
    );
    if (audio.agora) emitToUser(userId, 'audio-room:token', { roomId: existing.id, ...audio.agora });
    const detail = await this.get(userId, existing.id, role, known);
    return { ...detail, ...audio, alreadyLive: true };
  },

  async startChannelCall(userId: string, role: string, channelId: string, preferPlayback = false): Promise<unknown> {
    const { channel, membership } = await requireChannelCallStarter(userId, role, channelId);
    const known = { channelRole: membership?.role ?? null };
    const existing = await liveChannelCall(channelId);
    if (existing) return this.joinLiveCrowdCall(userId, role, existing, known, preferPlayback);

    // A ring for the call that just ended must not be turned into a new call.
    if (await callJustEnded({ channelId, type: 'CHANNEL_CALL' })) {
      throw BadRequest('This call has ended');
    }

    // Fails open if Redis is unavailable: a missed limit is better than blocking calls.
    const slot = await withDeadline(
      redis.set(`call-start:${channelId}:${userId}`, '1', 'EX', CHANNEL_CALL_START_COOLDOWN_S, 'NX'),
      500,
      'OK' as const,
    );
    if (slot !== 'OK') throw TooManyRequests('Please wait a moment before starting another call in this channel');

    const channelName = channelDisplayName(channel);
    const starter = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    if (!starter) throw NotFound('User not found');

    let room;
    try {
      room = await prisma.audioRoom.create({
        data: {
          title: `${channelName} Call`,
          description: `Live call in ${channelName}`,
          channelId,
          branchId: channel.branchId,
          clusterId: channel.clusterId,
          hostId: userId,
          type: 'CHANNEL_CALL',
          isPersistent: true,
          status: 'LIVE',
          provider: 'agora',
          startedAt: new Date(),
          participants: { create: { userId, role: 'HOST' } },
        },
        select: CHANNEL_CALL_SELECT,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const raced = await liveChannelCall(channelId);
        if (raced) return this.joinLiveCrowdCall(userId, role, raced, known, preferPlayback);
      }
      throw err;
    }

    joinAudioRoom(userId, room.id);
    const incoming = channelIncomingPayload(room, channelName, starter);
    emitToChannelExcept(channelId, userId, 'audio-room:incoming', incoming);
    enqueue(
      notificationQueue,
      'channel-call-started',
      {
        roomId: room.id,
        channelId,
        channelName,
        startedById: userId,
        startedByName: starter.displayName?.trim() || 'Someone',
        startedByAvatarUrl: starter.avatarUrl ?? '',
        createdAt: room.createdAt.toISOString(),
      },
      { jobId: `channel-call-started-${room.id}` },
    );
    await openStation(room.id, room.title);

    const detail = await this.get(userId, room.id, role, known);
    return {
      ...detail,
      role: 'HOST' as const,
      playbackUrl: detail.playbackUrl ?? null,
      agora: this.issueToken(room.id, userId, 'host'),
      alreadyLive: false,
    };
  },

  async create(userId: string, role: string, dto: CreateRoomInput) {
    // PRD §3: Super Admin (any room), Branch Admin (their branch), Cluster Moderator (their cluster).
    // An unscoped room (no branch, no cluster) is super-admin-only.
    const allowed = await canCreateForScope(userId, role, {
      branchId: dto.branchId ?? null,
      clusterId: dto.clusterId ?? null,
    });
    if (!allowed) throw Forbidden('You do not have permission to create an audio room in this scope');

    const room = await prisma.audioRoom.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        branchId: dto.branchId ?? null,
        clusterId: dto.clusterId ?? null,
        hostId: userId,
        provider: 'agora',
        status: dto.scheduledFor ? 'SCHEDULED' : 'LIVE',
        scheduledFor: dto.scheduledFor ?? null,
        startedAt: dto.scheduledFor ? null : new Date(),
        participants: {
          create: { userId, role: 'HOST' },
        },
      },
      select: { ...ROOM_SELECT, participants: { select: PARTICIPANT_SELECT } },
    });

    if (room.status === 'LIVE') {
      joinAudioRoom(userId, room.id);
      await this.notifyRoomStarted(room.id, room.title, room.branchId, room.clusterId, userId);
    }

    const { participants, ...rest } = room;
    const hostUser = participants.find((p) => p.role === 'HOST')?.user ?? null;
    return {
      ...rest,
      host: hostUser,
      speakerCount: participants.length,
      listenerCount: 0,
      totalParticipants: participants.length,
      speakers: participants.map(withAgoraUid),
      listeners: [],
      isReminding: false,
      viewer: { canModerate: true, canEnd: true }, // creator is the host
      agora: room.status === 'LIVE' ? this.issueToken(room.id, userId, 'host') : null,
    };
  },

  async update(userId: string, role: string, roomId: string, dto: UpdateRoomInput) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true, status: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(userId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to update this room');
    if (room.status === 'ENDED') throw BadRequest('Cannot update an ended room');

    return prisma.audioRoom.update({
      where: { id: roomId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.scheduledFor !== undefined ? { scheduledFor: dto.scheduledFor } : {}),
      },
      select: ROOM_SELECT,
    });
  },

  // Room cards for the Audio tab. Each card carries what the UI shows: host (name+avatar),
  // speaker count, listener count, a short avatar preview strip, and the caller's Remind-Me state.
  async list(userId: string, filter: 'live' | 'scheduled' | 'ended' = 'live', branchId?: string, clusterId?: string) {
    const where: Record<string, unknown> = {};
    if (filter === 'live') where.status = 'LIVE';
    else if (filter === 'scheduled') where.status = 'SCHEDULED';
    else where.status = 'ENDED';
    if (branchId) where.branchId = branchId;
    if (clusterId) where.clusterId = clusterId;

    const rooms = await prisma.audioRoom.findMany({
      where,
      orderBy: filter === 'scheduled' ? { scheduledFor: 'asc' } : { startedAt: 'desc' },
      take: 50,
      select: {
        ...ROOM_SELECT,
        // AudioRole enum order is HOST, SPEAKER, LISTENER — so host + speakers sort first.
        participants: {
          where: { leftAt: null },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
          take: 8,
          select: { role: true, user: { select: { id: true, displayName: true, avatarUrl: true } } },
        },
        reminders: { where: { userId }, select: { id: true } },
      },
    });
    if (!rooms.length) return [];

    // Exact per-role counts in one grouped query (the capped participant strip can't count 234 listeners).
    const counts = await prisma.audioRoomParticipant.groupBy({
      by: ['roomId', 'role'],
      where: { roomId: { in: rooms.map((r) => r.id) }, leftAt: null },
      _count: true,
    });
    const countMap = new Map<string, { speakers: number; listeners: number }>();
    for (const c of counts) {
      const entry = countMap.get(c.roomId) ?? { speakers: 0, listeners: 0 };
      if (c.role === 'LISTENER') entry.listeners += c._count;
      else entry.speakers += c._count; // HOST + SPEAKER both hold the mic
      countMap.set(c.roomId, entry);
    }

    return rooms.map((r) => {
      const { participants, reminders, ...room } = r;
      const host = participants.find((p) => p.role === 'HOST')?.user ?? null;
      const c = countMap.get(r.id) ?? { speakers: 0, listeners: 0 };
      return {
        ...room,
        host,
        speakerCount: c.speakers,
        listenerCount: c.listeners,
        participantsPreview: participants.map((p) => p.user),
        isReminding: reminders.length > 0,
      };
    });
  },

  // Room detail. All speakers (few), listeners capped at 30 + exact counts for the UI header.
  // `known` lets callers that already verified channel membership skip re-checking it.
  async get(userId: string, roomId: string, role = 'MEMBER', known?: { channelRole: string | null }) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: {
        ...ROOM_SELECT,
        type: true,
        participants: {
          where: { leftAt: null, role: { in: ['HOST', 'SPEAKER'] } },
          select: PARTICIPANT_SELECT,
          orderBy: { joinedAt: 'asc' },
        },
        reminders: { where: { userId }, select: { id: true } },
      },
    });
    if (!room) throw NotFound('Room not found');
    let channelRole = known?.channelRole ?? null;
    if (room.channelId && !known) {
      channelRole = (await requireChannelMember(userId, role, room.channelId)).membership?.role ?? null;
    }

    const [listeners, listenerCount, scopes] = await Promise.all([
      prisma.audioRoomParticipant.findMany({
        where: { roomId, leftAt: null, role: 'LISTENER' },
        select: PARTICIPANT_SELECT,
        orderBy: { joinedAt: 'asc' },
        take: 30,
      }),
      prisma.audioRoomParticipant.count({ where: { roomId, leftAt: null, role: 'LISTENER' } }),
      viewerAdminScopes(userId),
    ]);
    const canModerate = viewerCanModerate(userId, role, room, scopes, channelRole);

    const { participants, reminders, type, ...rest } = room;
    const host = participants.find((p) => p.role === 'HOST')?.user ?? null;
    const speakerCount = participants.length;
    const totalParticipants = speakerCount + listenerCount;
    // Mirrors the end() gate so clients don't have to re-derive who may end the call.
    const isLastOnCall =
      totalParticipants === 1 && (participants[0]?.userId ?? listeners[0]?.userId) === userId;
    const isLive = room.status !== 'ENDED';
    return {
      ...rest,
      host,
      speakerCount,
      listenerCount,
      totalParticipants,
      speakers: participants.map(withAgoraUid),
      listeners: listeners.map(withAgoraUid),
      isReminding: reminders.length > 0,
      viewer: {
        canModerate: isLive && canModerate,
        canEnd: isLive && (canModerate || (type === 'CHANNEL_CALL' && isLastOnCall)),
      },
    };
  },

  // "Remind Me" on a scheduled room — notified when the host actually starts it.
  async remind(userId: string, roomId: string) {
    const room = await prisma.audioRoom.findUnique({ where: { id: roomId }, select: { status: true } });
    if (!room) throw NotFound('Room not found');
    if (room.status !== 'SCHEDULED') throw BadRequest('Reminders are only for scheduled rooms');
    await prisma.audioRoomReminder.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId },
      update: {},
    });
    return { ok: true, isReminding: true };
  },

  async unremind(userId: string, roomId: string) {
    await prisma.audioRoomReminder.deleteMany({ where: { roomId, userId } });
    return { ok: true, isReminding: false };
  },

  async start(userId: string, role: string, roomId: string) {
    const room = await prisma.audioRoom.findUnique({ where: { id: roomId }, select: { hostId: true, status: true, title: true, channelId: true, branchId: true, clusterId: true, type: true } });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(userId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to start this room');
    if (room.status !== 'SCHEDULED') throw BadRequest('Room is not in SCHEDULED state');

    await prisma.audioRoom.update({
      where: { id: roomId },
      data: { status: 'LIVE', startedAt: new Date() },
    });

    joinAudioRoom(userId, roomId);
    await this.notifyRoomStarted(roomId, room.title, room.branchId, room.clusterId, userId);
    const detail = await this.get(userId, roomId, role);
    return { ...detail, agora: this.issueToken(roomId, userId, 'host') };
  },

  async end(userId: string, role: string, roomId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true, status: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    // Channel calls: whoever is the last one still on the call can end it, admin or not
    // (same outcome as them leaving, just explicit).
    const allowed =
      (await canModerateRoom(userId, role, room)) ||
      (room.type === 'CHANNEL_CALL' && (await isLastActiveParticipant(userId, roomId)));
    if (!allowed) throw Forbidden('You do not have permission to end this room');
    if (room.status === 'ENDED') throw BadRequest('Room already ended');

    // Conditional so two concurrent ends (or an end racing the last leave) end it exactly once.
    // The UPDATE's row lock also makes a concurrent addParticipantIfLive wait and then see ENDED.
    const { count } = await prisma.audioRoom.updateMany({
      where: { id: roomId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    if (count === 0) throw BadRequest('Room already ended');
    const updated = await prisma.audioRoom.findUniqueOrThrow({ where: { id: roomId }, select: ROOM_SELECT });
    await prisma.audioRoomParticipant.updateMany({
      where: { roomId, leftAt: null },
      data: { leftAt: new Date() },
    });

    await publishRoomEnded(roomId, room.channelId, room.type);
    return updated;
  },

  async join(userId: string, role: string, roomId: string, preferPlayback = false) {
    // Parallelize the two independent reads — the room lookup and the "already in room" check
    // don't depend on each other. Saves one round-trip per join, which matters when 100+ users
    // hit /join within a few seconds on the single Render instance.
    const [room, existing] = await Promise.all([
      prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { id: true, status: true, hostId: true, channelId: true, branchId: true, clusterId: true, type: true, playbackUrl: true },
      }),
      prisma.audioRoomParticipant.findFirst({
        where: { roomId, userId, leftAt: null },
        select: { id: true, role: true },
      }),
    ]);
    if (!room) throw NotFound('Room not found');
    if (room.status !== 'LIVE') throw BadRequest('Room is not live');
    const channelRole = room.channelId
      ? ((await requireChannelMember(userId, role, room.channelId)).membership?.role ?? null)
      : null;
    if (existing?.role === 'LISTENER' && preferPlayback && isOpenMicRoom(room.type)) {
      const next = await roleForCrowdJoin(userId, role, room, true);
      if (next === 'LISTENER') {
        await releaseFromRoll(roomId, userId, existing.id);
        const detail = await this.get(userId, roomId, role, { channelRole });
        return { ...detail, ...this.clientAudio(roomId, userId, 'LISTENER', true, room.playbackUrl, room.type) };
      }
    }
    if (existing) throw BadRequest('Already in this room');

    // Without preferPlayback, Prayer Watch and channel calls still hand everyone a publisher
    // token. With it, only the starter and admins hold a mic. Named rooms keep host/speaker/listener.
    let joinRole: 'SPEAKER' | 'LISTENER';
    if (isOpenMicRoom(room.type)) {
      joinRole = preferPlayback ? await roleForCrowdJoin(userId, role, room, true) : 'SPEAKER';
    } else {
      const canModerate = await canModerateRoom(userId, role, room);
      joinRole = canModerate ? 'SPEAKER' : 'LISTENER';
    }

    if (listensOffTheRoll(preferPlayback, joinRole, room.type)) {
      const detail = await this.get(userId, roomId, role, { channelRole });
      return { ...detail, ...this.clientAudio(roomId, userId, joinRole, preferPlayback, room.playbackUrl, room.type) };
    }

    const participant = await addParticipantIfLive(roomId, userId, joinRole);

    emitToAudioRoom(roomId, 'audio-room:user-joined', withAgoraUid(participant));
    joinAudioRoom(userId, roomId);

    const detail = await this.get(userId, roomId, role, { channelRole });
    const audio = this.clientAudio(roomId, userId, joinRole, preferPlayback, room.playbackUrl, room.type);
    return { ...detail, ...audio };
  },

  async leave(userId: string, roomId: string) {
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('Not in this room');

    await prisma.audioRoomParticipant.update({
      where: { id: p.id },
      data: { leftAt: new Date() },
    });

    leaveAudioRoom(userId, roomId);
    emitToAudioRoom(roomId, 'audio-room:user-left', { roomId, userId });

    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { isPersistent: true, channelId: true, type: true },
    });

    // Persistent rooms stay up when the starter leaves. If they were the only mic and
    // someone is still listening, the mic passes before we check whether the room is empty.
    if (room?.isPersistent) {
      if (isOpenMicRoom(room.type) && (p.role === 'HOST' || p.role === 'SPEAKER')) {
        await this.passMicIfNoneRemain(roomId);
      }
      await endIfEmpty(roomId);
      return { ok: true };
    }

    // Normal rooms: host leaving promotes the next speaker, or ends the room if none.
    if (p.role === 'HOST') {
      const nextSpeaker = await prisma.audioRoomParticipant.findFirst({
        where: { roomId, leftAt: null, role: 'SPEAKER' },
        orderBy: { joinedAt: 'asc' },
      });
      if (nextSpeaker) {
        await prisma.audioRoomParticipant.update({
          where: { id: nextSpeaker.id },
          data: { role: 'HOST' },
        });
        await prisma.audioRoom.update({ where: { id: roomId }, data: { hostId: nextSpeaker.userId } });
        emitToAudioRoom(roomId, 'audio-room:role-changed', {
          roomId, userId: nextSpeaker.userId, role: 'HOST',
        });
      } else {
        await prisma.audioRoom.update({
          where: { id: roomId },
          data: { status: 'ENDED', endedAt: new Date() },
        });
        await prisma.audioRoomParticipant.updateMany({
          where: { roomId, leftAt: null },
          data: { leftAt: new Date() },
        });
        await publishRoomEnded(roomId, room?.channelId ?? null, room?.type ?? 'GENERAL');
      }
    }
    return { ok: true };
  },

  // Speaker demotes themselves back to LISTENER. Distinct from promote() because it doesn't
  // require moderator permission — a speaker can always step down.
  async stepDown(userId: string, roomId: string) {
    const [p, room] = await Promise.all([
      prisma.audioRoomParticipant.findFirst({
        where: { roomId, userId, leftAt: null },
        select: { id: true, role: true },
      }),
      prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { type: true, playbackUrl: true },
      }),
    ]);
    if (!p) throw BadRequest('Not in this room');
    if (p.role !== 'SPEAKER') throw BadRequest('Only speakers can step down');

    // A crowd call with a station leaves the roll. Named rooms stay in the channel as audience.
    if (room && stationIsUp(room)) {
      if (await onlyPersonOnTheCall(roomId)) throw BadRequest(LAST_MIC_MESSAGE);
      await this.dropStationMic(roomId, userId, p.id, room.playbackUrl);
      return { ok: true, role: 'LISTENER' as const, playbackUrl: room.playbackUrl, agora: null };
    }

    await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { role: 'LISTENER' } });
    emitToAudioRoom(roomId, 'audio-room:role-changed', { roomId, userId, role: 'LISTENER' });
    const token = this.issueToken(roomId, userId, 'audience');
    emitToUser(userId, 'audio-room:token', { roomId, ...token });
    return { ok: true, ...token };
  },

  // Moderator mutes a participant. Agora doesn't offer server-forced mute in our tier, so we
  // broadcast a soft-mute event that the target client is expected to honor by calling
  // muteLocalAudioStream(true). If a rogue client ignores it, moderators still have kick.
  // Applies to HOST/SPEAKER (LISTENERs already can't publish).
  async mute(hostUserId: string, role: string, roomId: string, targetUserId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, channelId: true, branchId: true, clusterId: true, type: true, playbackUrl: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to mute users in this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('User is not in this room');
    if (p.role === 'LISTENER') throw BadRequest('Listener has no active mic to mute');

    if (isOpenMicRoom(room.type)) {
      const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { globalRole: true } });
      const protectedIds = await protectedMicIds(room, [{ userId: targetUserId, globalRole: target?.globalRole }]);
      if (protectedIds.has(targetUserId)) throw Forbidden('You cannot take this mic');
      if (room.playbackUrl) {
        if (await onlyPersonOnTheCall(roomId)) throw BadRequest(LAST_MIC_MESSAGE);
        await this.dropStationMic(roomId, targetUserId, p.id, room.playbackUrl);
      }
    }

    emitToUser(targetUserId, 'audio-room:muted', { roomId, mutedBy: hostUserId });
    emitToAudioRoom(roomId, 'audio-room:user-muted', { roomId, userId: targetUserId, mutedBy: hostUserId });
    return { ok: true, playbackUrl: room.playbackUrl ?? null };
  },

  async muteAll(actorUserId: string, role: string, roomId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, channelId: true, branchId: true, clusterId: true, type: true, playbackUrl: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(actorUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to mute users in this room');

    const speakers = await prisma.audioRoomParticipant.findMany({
      where: { roomId, leftAt: null, role: { in: ['SPEAKER', 'HOST'] }, userId: { not: actorUserId } },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, userId: true, user: { select: { globalRole: true } } },
    });
    // On a crowd call, protected mics stay. Only free mics are taken, and the actor keeps theirs.
    let dropping = speakers;
    if (isOpenMicRoom(room.type)) {
      const protectedIds = await protectedMicIds(
        room,
        speakers.map((speaker) => ({ userId: speaker.userId, globalRole: speaker.user.globalRole })),
      );
      dropping = speakers.filter((speaker) => !protectedIds.has(speaker.userId));
      if (room.playbackUrl && dropping.length > 0) {
        const active = await prisma.audioRoomParticipant.count({ where: { roomId, leftAt: null } });
        if (active - dropping.length < 1) dropping = dropping.slice(1);
      }
    }

    for (const speaker of dropping) {
      if (stationIsUp(room)) {
        await releaseFromRoll(roomId, speaker.userId, speaker.id);
        emitPlayback(speaker.userId, roomId, room.playbackUrl ?? null);
      }
      emitToUser(speaker.userId, 'audio-room:muted', { roomId, mutedBy: actorUserId });
    }
    if (stationIsUp(room) && dropping.length > 0) await this.settleStationRoll(roomId);
    emitToAudioRoom(roomId, 'audio-room:all-muted', {
      roomId, mutedBy: actorUserId, userIds: dropping.map((speaker) => speaker.userId),
    });
    return { ok: true, mutedCount: dropping.length };
  },

  async unmute(actorUserId: string, role: string, roomId: string, targetUserId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');

    const isSelfUnmute = actorUserId === targetUserId;
    const allowed = isSelfUnmute || (await canModerateRoom(actorUserId, role, room));
    if (!allowed) throw Forbidden('You do not have permission to unmute users in this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { role: true },
    });
    if (!p) throw BadRequest('User is not in this room');
    if (p.role === 'LISTENER') throw BadRequest('Listener has no active mic to unmute');

    emitToAudioRoom(roomId, 'audio-room:user-unmuted', { roomId, userId: targetUserId });
    return { ok: true };
  },

  async raiseHand(userId: string, roomId: string) {
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('Not in this room');
    if (p.role !== 'LISTENER') throw BadRequest('Only listeners can raise hand');

    emitToAudioRoom(roomId, 'audio-room:hand-raised', { roomId, userId });
    return { ok: true };
  },

  // Mirror of raiseHand: same participant check, opposite broadcast. Hand state is client-side
  // (a Set the host UI maintains), so we just need to tell everyone the listener took it back.
  async lowerHand(userId: string, roomId: string) {
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('Not in this room');
    if (p.role !== 'LISTENER') throw BadRequest('Only listeners can lower hand');

    emitToAudioRoom(roomId, 'audio-room:hand-lowered', { roomId, userId });
    return { ok: true };
  },

  async promote(hostUserId: string, role: string, roomId: string, targetUserId: string, targetRole: 'SPEAKER' | 'LISTENER') {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { id: true, hostId: true, status: true, channelId: true, branchId: true, clusterId: true, type: true, playbackUrl: true },
    });
    if (!room) throw NotFound('Room not found');
    if (room.status !== 'LIVE') throw BadRequest('Room is not live');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to change roles in this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('User is not in this room');

    if (isOpenMicRoom(room.type)) {
      const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { globalRole: true } });
      const protectedIds = await protectedMicIds(room, [{ userId: targetUserId, globalRole: target?.globalRole }]);
      const targetProtected = protectedIds.has(targetUserId);
      if (targetRole === 'LISTENER' && targetProtected) throw Forbidden('You cannot take this mic');
      if (targetRole === 'SPEAKER' && p.role === 'LISTENER' && !targetProtected && room.playbackUrl) {
        if (await countFreeMics(room) >= FREE_MIC_LIMIT) throw BadRequest('All free mics are in use');
      }
    }

    if (targetRole === 'LISTENER' && stationIsUp(room)) {
      if (await onlyPersonOnTheCall(roomId)) throw BadRequest(LAST_MIC_MESSAGE);
      await this.dropStationMic(roomId, targetUserId, p.id, room.playbackUrl);
      return { ok: true };
    }

    await prisma.audioRoomParticipant.update({
      where: { id: p.id },
      data: { role: targetRole },
    });

    emitToAudioRoom(roomId, 'audio-room:role-changed', {
      roomId, userId: targetUserId, role: targetRole,
    });

    if (targetRole === 'SPEAKER') {
      const token = this.issueToken(roomId, targetUserId, 'host');
      emitToUser(targetUserId, 'audio-room:token', { roomId, ...token });
    }

    return { ok: true };
  },

  async kick(hostUserId: string, role: string, roomId: string, targetUserId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true, channelId: true, branchId: true, clusterId: true, type: true, isPersistent: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to remove users from this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('User is not in this room');

    await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { leftAt: new Date() } });
    emitToUser(targetUserId, 'audio-room:kicked', { roomId });
    leaveAudioRoom(targetUserId, roomId);
    emitToAudioRoom(roomId, 'audio-room:user-left', { roomId, userId: targetUserId });
    if (room.isPersistent && isOpenMicRoom(room.type) && (p.role === 'HOST' || p.role === 'SPEAKER')) {
      await this.passMicIfNoneRemain(roomId);
      await endIfEmpty(roomId);
    }
    return { ok: true };
  },

  // Grab or return a free mic on a crowd call. Named rooms keep raise-hand and promote.
  async setMic(userId: string, role: string, roomId: string, hold: boolean) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: {
        id: true, status: true, hostId: true, channelId: true, branchId: true,
        clusterId: true, type: true, playbackUrl: true,
      },
    });
    if (!room) throw NotFound('Room not found');
    if (!isOpenMicRoom(room.type)) throw BadRequest('This room does not use station mics');
    if (room.status !== 'LIVE') throw BadRequest('Room is not live');

    const participant = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { id: true, role: true },
    });

    if (!hold) {
      if (!participant || participant.role === 'LISTENER') {
        if (participant && stationIsUp(room) && !(await onlyPersonOnTheCall(roomId))) {
          await releaseFromRoll(roomId, userId, participant.id);
        }
        return { ok: true, role: 'LISTENER' as const, playbackUrl: room.playbackUrl, agora: null };
      }
      if (await onlyPersonOnTheCall(roomId)) throw BadRequest(LAST_MIC_MESSAGE);
      if (stationIsUp(room)) {
        await this.dropStationMic(roomId, userId, participant.id, room.playbackUrl);
        return { ok: true, role: 'LISTENER' as const, playbackUrl: room.playbackUrl, agora: null };
      }
      await prisma.audioRoomParticipant.update({ where: { id: participant.id }, data: { role: 'LISTENER' } });
      emitToAudioRoom(roomId, 'audio-room:role-changed', { roomId, userId, role: 'LISTENER' });
      emitPlayback(userId, roomId, room.playbackUrl);
      return { ok: true, role: 'LISTENER' as const, playbackUrl: room.playbackUrl, agora: null };
    }

    if (participant?.role === 'HOST' || participant?.role === 'SPEAKER') {
      const agora = this.issueToken(roomId, userId, 'host');
      return { ok: true, role: participant.role, playbackUrl: room.playbackUrl, agora };
    }

    if (room.channelId) await requireChannelMember(userId, role, room.channelId);
    const self = await prisma.user.findUnique({ where: { id: userId }, select: { globalRole: true } });
    const protectedIds = await protectedMicIds(room, [{ userId, globalRole: self?.globalRole ?? role }]);
    if (!protectedIds.has(userId) && await countFreeMics({ ...room, id: roomId }) >= FREE_MIC_LIMIT) {
      throw BadRequest('All free mics are in use');
    }

    if (!participant) {
      let created;
      try {
        created = await addParticipantIfLive(roomId, userId, 'SPEAKER');
      } catch (err) {
        if ((err as { message?: string }).message === 'Room is not live') throw BadRequest('This call has ended');
        throw err;
      }
      joinAudioRoom(userId, roomId);
      emitToAudioRoom(roomId, 'audio-room:user-joined', withAgoraUid(created));
    } else {
      await prisma.audioRoomParticipant.update({ where: { id: participant.id }, data: { role: 'SPEAKER' } });
      emitToAudioRoom(roomId, 'audio-room:role-changed', { roomId, userId, role: 'SPEAKER' });
    }
    const agora = this.issueToken(roomId, userId, 'host');
    emitToUser(userId, 'audio-room:token', { roomId, ...agora });
    return { ok: true, role: 'SPEAKER' as const, playbackUrl: room.playbackUrl, agora };
  },

  // Mic left the roll. Pass it on if nobody is holding one, then end the service if the roll is empty.
  async dropStationMic(roomId: string, userId: string, participantId: string, playbackUrl: string | null) {
    await releaseFromRoll(roomId, userId, participantId);
    emitPlayback(userId, roomId, playbackUrl);
    await this.settleStationRoll(roomId);
  },

  async settleStationRoll(roomId: string) {
    await this.passMicIfNoneRemain(roomId);
    await endIfEmpty(roomId);
  },

  async refreshToken(userId: string, roomId: string) {
    const [p, room] = await Promise.all([
      prisma.audioRoomParticipant.findFirst({
        where: { roomId, userId, leftAt: null },
        select: { role: true },
      }),
      prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { type: true, playbackUrl: true },
      }),
    ]);
    if (!p) throw BadRequest('Not in this room');

    if (p.role === 'LISTENER' && room && isOpenMicRoom(room.type) && room.playbackUrl) {
      return {
        appId: null,
        token: null,
        channel: roomId,
        uid: stableUid(userId),
        playbackUrl: room.playbackUrl,
        role: 'LISTENER' as const,
      };
    }
    const agoraRole = p.role === 'LISTENER' ? 'audience' : 'host';
    return {
      ...this.issueToken(roomId, userId, agoraRole),
      playbackUrl: room?.playbackUrl ?? null,
      role: p.role,
    };
  },

  // The only mic holder left. Pass it to the longest-present admin, else the longest-present member.
  async passMicIfNoneRemain(roomId: string): Promise<void> {
    const chosen = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{
        hostId: string;
        channelId: string | null;
        branchId: string | null;
        clusterId: string | null;
        type: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL';
        status: string;
      }[]>`
        SELECT "hostId", "channelId", "branchId", "clusterId", "type", "status"
        FROM "AudioRoom" WHERE "id" = ${roomId} FOR UPDATE`;
      const room = rows[0];
      if (!room || room.status !== 'LIVE' || !isOpenMicRoom(room.type)) return null;
      const holders = await tx.audioRoomParticipant.count({
        where: { roomId, leftAt: null, role: { in: ['HOST', 'SPEAKER'] } },
      });
      if (holders > 0) return null;
      const remaining = await tx.audioRoomParticipant.findMany({
        where: { roomId, leftAt: null },
        orderBy: { joinedAt: 'asc' },
        select: { id: true, userId: true, user: { select: { globalRole: true } } },
      });
      if (!remaining.length) return null;
      const protectedIds = await protectedMicIds(
        room,
        remaining.map((person) => ({ userId: person.userId, globalRole: person.user.globalRole })),
      );
      const next = remaining.find((person) => protectedIds.has(person.userId)) ?? remaining[0];
      if (!next) return null;
      await tx.audioRoomParticipant.update({ where: { id: next.id }, data: { role: 'SPEAKER' } });
      return { userId: next.userId };
    });
    if (!chosen) return;
    emitToAudioRoom(roomId, 'audio-room:role-changed', { roomId, userId: chosen.userId, role: 'SPEAKER' });
    const token = this.issueToken(roomId, chosen.userId, 'host');
    emitToUser(chosen.userId, 'audio-room:token', { roomId, ...token });
  },

  issueToken(roomId: string, userId: string, agoraRole: 'host' | 'audience') {
    if (!isAgoraConfigured()) {
      return { appId: null, token: null, channel: roomId, uid: stableUid(userId) };
    }
    const uid = stableUid(userId);
    const token = buildRtcToken(roomId, uid, agoraRole);
    return { appId: env.AGORA_APP_ID!, token, channel: roomId, uid };
  },

  // Listeners who opted into the station get no Agora token. Everyone else still does,
  // including old phones that did not send preferPlayback.
  clientAudio(
    roomId: string,
    userId: string,
    participantRole: 'HOST' | 'SPEAKER' | 'LISTENER',
    preferPlayback: boolean,
    playbackUrl: string | null,
    roomType: 'GENERAL' | 'PRAYER_WATCH' | 'CHANNEL_CALL',
  ) {
    const stationListener = preferPlayback && participantRole === 'LISTENER' && isOpenMicRoom(roomType);
    return {
      role: participantRole,
      playbackUrl,
      agora: stationListener ? null : this.issueToken(roomId, userId, participantRole === 'LISTENER' ? 'audience' : 'host'),
    };
  },

  async notifyRoomStarted(roomId: string, title: string, branchId: string | null, clusterId: string | null, hostId: string) {
    const userIds = new Set<string>();

    // Everyone who tapped "Remind Me" gets notified, regardless of channel membership.
    const reminders = await prisma.audioRoomReminder.findMany({ where: { roomId }, select: { userId: true } });
    for (const r of reminders) userIds.add(r.userId);

    if (branchId || clusterId) {
      const channelWhere: Record<string, unknown> = {};
      if (branchId) channelWhere.branchId = branchId;
      if (clusterId) channelWhere.clusterId = clusterId;
      const channel = await prisma.channel.findFirst({ where: channelWhere, select: { id: true } });
      if (channel) {
        const members = await prisma.channelMembership.findMany({
          where: { channelId: channel.id, mutedAt: null },
          select: { userId: true },
        });
        for (const m of members) userIds.add(m.userId);
      }
    }

    userIds.delete(hostId);
    if (userIds.size) {
      const host = await prisma.user.findUnique({
        where: { id: hostId },
        select: { displayName: true, avatarUrl: true },
      });
      enqueue(notificationQueue, 'audio-room-started', {
        roomId,
        title,
        hostId,
        hostName: host?.displayName?.trim() || 'Someone',
        hostAvatarUrl: host?.avatarUrl ?? '',
        userIds: [...userIds],
      });
    }
    // Reminders are one-shot — clear them once fired.
    if (reminders.length) await prisma.audioRoomReminder.deleteMany({ where: { roomId } });
  },

  // Repeatable scan (notification worker, every 5 min): "starting soon" push for scheduled rooms.
  // Notifies Remind-Me users + nudges the host to go live. Same reminderSentAt pattern as events.
  // Reminder rows are kept — they fire again as "room is live" when the host actually starts it.
  async sendDueRoomReminders(windowMs = 15 * 60 * 1000) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowMs);
    const rooms = await prisma.audioRoom.findMany({
      where: { status: 'SCHEDULED', reminderSentAt: null, scheduledFor: { gt: now, lte: windowEnd } },
      select: {
        id: true,
        title: true,
        scheduledFor: true,
        hostId: true,
        reminders: { select: { userId: true } },
      },
    });

    let notified = 0;
    for (const room of rooms) {
      const startsAt = room.scheduledFor!.toISOString();

      // Attendees who tapped Remind Me
      const attendeeIds = room.reminders.map((r) => r.userId).filter((id) => id !== room.hostId);
      if (attendeeIds.length) {
        const payload = {
          title: `Starting soon: ${room.title}`,
          body: 'The room goes live in a few minutes — tap to be ready.',
          data: audioRoomPushData(room.id, { startsAt }),
        };
        for (let i = 0; i < attendeeIds.length; i += 1000) {
          const res = await prisma.notification.createMany({
            data: attendeeIds.slice(i, i + 1000).map((userId) => ({
              userId,
              type: 'SYSTEM' as const,
              ...payload,
            })),
          });
          notified += res.count;
        }
        await pushService.sendToUsers(attendeeIds, { ...payload, threadId: `audio-room:${room.id}` });
      }

      // Host nudge — they're the one who has to press Start
      const hostPayload = {
        title: `Your room starts soon: ${room.title}`,
        body: 'Open the app and tap Start when you are ready to go live.',
        data: audioRoomPushData(room.id, { startsAt, hostAction: 'START_ROOM' }),
      };
      await prisma.notification.create({
        data: { userId: room.hostId, type: 'SYSTEM', ...hostPayload },
      });
      await pushService.sendToUser(room.hostId, { ...hostPayload, threadId: `audio-room:${room.id}` });
      notified += 1;

      await prisma.audioRoom.update({ where: { id: room.id }, data: { reminderSentAt: new Date() } });
    }
    return { rooms: rooms.length, notified };
  },

  // Phantom-participant sweep for persistent rooms (Prayer Watch). Runs on a scheduler; marks
  // participants whose user has been offline for > presence TTL as "left" so the room's list
  // eventually reflects reality without needing every client to call /leave explicitly. If a
  // room ends up empty after the sweep, close it (same rule as the last-participant-leaves
  // branch in leave()).
  //
  // Safety: we abort if Redis isn't confidently answering, because a false "everyone offline"
  // read would sweep the entire room. Presence is authoritative only when Redis is healthy.
  async sweepPhantomParticipants() {
    const ping = await withDeadline(redis.ping(), 500, null as string | null);
    if (ping !== 'PONG') {
      return { skipped: 'redis-unhealthy', rooms: 0, swept: 0, ended: 0 };
    }

    const rooms = await prisma.audioRoom.findMany({
      where: { status: 'LIVE', isPersistent: true },
      select: { id: true },
    });
    if (!rooms.length) return { rooms: 0, swept: 0, ended: 0 };

    const roomIds = rooms.map((r) => r.id);
    const participants = await prisma.audioRoomParticipant.findMany({
      where: { roomId: { in: roomIds }, leftAt: null },
      select: { id: true, userId: true, roomId: true },
    });
    if (!participants.length) return { rooms: rooms.length, swept: 0, ended: 0 };

    const userIds = [...new Set(participants.map((p) => p.userId))];
    // A slow read means presence is unknown — never treat that as "everyone offline", which would
    // remove every participant and end the call.
    const presence = await readPresence(userIds, 5000);
    if (!presence) {
      logger.warn({ rooms: rooms.length, participants: participants.length }, 'Phantom sweep skipped: presence read timed out');
      return { skipped: 'presence-unavailable', rooms: rooms.length, swept: 0, ended: 0 };
    }
    const stale = participants.filter((p) => presence[p.userId] === 'offline');
    if (!stale.length) return { rooms: rooms.length, swept: 0, ended: 0 };

    await prisma.audioRoomParticipant.updateMany({
      where: { id: { in: stale.map((p) => p.id) } },
      data: { leftAt: new Date() },
    });

    // Emit user-left per stale participant so live observers reconcile their UI.
    for (const p of stale) {
      emitToAudioRoom(p.roomId, 'audio-room:user-left', { roomId: p.roomId, userId: p.userId });
    }

    // A swept mic holder must not leave the room with nobody who can speak.
    let ended = 0;
    const affectedRoomIds = [...new Set(stale.map((p) => p.roomId))];
    for (const roomId of affectedRoomIds) {
      await this.passMicIfNoneRemain(roomId);
      if (await endIfEmpty(roomId)) ended += 1;
    }

    logger.info({ rooms: rooms.length, swept: stale.length, ended }, 'Phantom participant sweep complete');
    return { rooms: rooms.length, swept: stale.length, ended };
  },
};

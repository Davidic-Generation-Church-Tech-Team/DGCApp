import { prisma } from '../../infra/db';
import { buildRtcToken, isAgoraConfigured } from '../../infra/agora';
import { emitToUser, emitToAudioRoom, emitToChannel, joinAudioRoom, leaveAudioRoom, closeAudioRoom } from '../../infra/realtime';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { pushService } from '../push/push.service';
import { redis, withDeadline } from '../../infra/redis';
import { logger } from '../../infra/logger';
import { getBulkPresence } from '../chat/chat.socket';
import { BadRequest, Forbidden, NotFound } from '../../utils/errors';
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
} as const;

const CHANNEL_CALL_RING_TTL_MS = 30_000;

const CHANNEL_CALL_SELECT = {
  id: true,
  title: true,
  channelId: true,
  hostId: true,
  startedAt: true,
  createdAt: true,
} as const;

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
  return {
    roomId: room.id,
    channelId: room.channelId,
    title: room.title,
    channelName,
    startedById: starter.id,
    startedByName: starter.displayName ?? 'Someone',
    startedByAvatarUrl: starter.avatarUrl,
    createdAt: room.createdAt,
    expiresAt: new Date(room.createdAt.getTime() + CHANNEL_CALL_RING_TTL_MS),
  };
}

export const audioRoomService = {
  async channelCallStatus(userId: string, role: string, channelId: string) {
    await requireChannelMember(userId, role, channelId);
    return { channelId, live: await liveChannelCall(channelId) };
  },

  async startChannelCall(userId: string, role: string, channelId: string): Promise<unknown> {
    const { channel } = await requireChannelCallStarter(userId, role, channelId);
    const existing = await liveChannelCall(channelId);
    if (existing) {
      const p = await prisma.audioRoomParticipant.findFirst({
        where: { roomId: existing.id, userId, leftAt: null },
        select: { id: true, role: true },
      });
      if (!p) {
        const created = await prisma.audioRoomParticipant.create({
          data: { roomId: existing.id, userId, role: 'SPEAKER' },
          select: PARTICIPANT_SELECT,
        });
        joinAudioRoom(userId, existing.id);
        emitToAudioRoom(existing.id, 'audio-room:user-joined', withAgoraUid(created));
      } else if (p.role === 'LISTENER') {
        await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { role: 'SPEAKER' } });
        emitToAudioRoom(existing.id, 'audio-room:role-changed', {
          roomId: existing.id, userId, role: 'SPEAKER',
        });
      }
      const token = this.issueToken(existing.id, userId, 'host');
      emitToUser(userId, 'audio-room:token', { roomId: existing.id, ...token });
      const detail = await this.get(userId, existing.id, role);
      return { ...detail, agora: token, alreadyLive: true };
    }

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
        if (raced) return this.startChannelCall(userId, role, channelId);
      }
      throw err;
    }

    joinAudioRoom(userId, room.id);
    const incoming = channelIncomingPayload(room, channelName, starter);
    emitToChannel(channelId, 'audio-room:incoming', incoming);
    enqueue(
      notificationQueue,
      'channel-call-started',
      {
        roomId: room.id,
        channelId,
        channelName,
        startedById: userId,
        startedByName: starter.displayName ?? 'Someone',
        startedByAvatarUrl: starter.avatarUrl ?? '',
        createdAt: room.createdAt.toISOString(),
      },
      { jobId: `channel-call-started-${room.id}` },
    );

    const detail = await this.get(userId, room.id, role);
    return { ...detail, agora: this.issueToken(room.id, userId, 'host'), alreadyLive: false };
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
  async get(userId: string, roomId: string, role = 'MEMBER') {
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
    if (room.channelId) await requireChannelMember(userId, role, room.channelId);

    const [listeners, listenerCount, canModerate] = await Promise.all([
      prisma.audioRoomParticipant.findMany({
        where: { roomId, leftAt: null, role: 'LISTENER' },
        select: PARTICIPANT_SELECT,
        orderBy: { joinedAt: 'asc' },
        take: 30,
      }),
      prisma.audioRoomParticipant.count({ where: { roomId, leftAt: null, role: 'LISTENER' } }),
      canModerateRoom(userId, role, room),
    ]);

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

    const updated = await prisma.audioRoom.update({
      where: { id: roomId },
      data: { status: 'ENDED', endedAt: new Date() },
      select: ROOM_SELECT,
    });
    await prisma.audioRoomParticipant.updateMany({
      where: { roomId, leftAt: null },
      data: { leftAt: new Date() },
    });

    emitToAudioRoom(roomId, 'audio-room:ended', { roomId });
    closeAudioRoom(roomId);
    return updated;
  },

  async join(userId: string, role: string, roomId: string) {
    // Parallelize the two independent reads — the room lookup and the "already in room" check
    // don't depend on each other. Saves one round-trip per join, which matters when 100+ users
    // hit /join within a few seconds on the single Render instance.
    const [room, existing] = await Promise.all([
      prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { id: true, status: true, hostId: true, channelId: true, branchId: true, clusterId: true, type: true },
      }),
      prisma.audioRoomParticipant.findFirst({
        where: { roomId, userId, leftAt: null },
        select: { id: true },
      }),
    ]);
    if (!room) throw NotFound('Room not found');
    if (room.status !== 'LIVE') throw BadRequest('Room is not live');
    if (room.channelId) await requireChannelMember(userId, role, room.channelId);
    if (existing) throw BadRequest('Already in this room');

    // PRAYER_WATCH rooms are Telegram-style: everyone joins as SPEAKER (no LISTENER role at all,
    // publisher token for everyone). Regular rooms: auto-promote to SPEAKER only if the caller
    // has moderation power for this scope (super admin, room host, branch admin for the room's
    // branch, cluster mod for the room's cluster); everyone else joins as LISTENER.
    let joinRole: 'SPEAKER' | 'LISTENER';
    if (isOpenMicRoom(room.type)) {
      joinRole = 'SPEAKER';
    } else {
      const canModerate = await canModerateRoom(userId, role, room);
      joinRole = canModerate ? 'SPEAKER' : 'LISTENER';
    }
    const agoraRole: 'host' | 'audience' = joinRole === 'LISTENER' ? 'audience' : 'host';

    const participant = await prisma.audioRoomParticipant.create({
      data: { roomId, userId, role: joinRole },
      select: PARTICIPANT_SELECT,
    });

    emitToAudioRoom(roomId, 'audio-room:user-joined', withAgoraUid(participant));
    joinAudioRoom(userId, roomId);

    const detail = await this.get(userId, roomId, role);
    return { ...detail, agora: this.issueToken(roomId, userId, agoraRole) };
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
      select: { isPersistent: true },
    });

    // Persistent rooms (Prayer Watch call): NO host promotion, NO auto-end on host leave.
    // The call stays live as long as anyone is on it — moderators come and go, participants
    // drift in and out. Auto-end fires ONLY when the last active participant leaves.
    if (room?.isPersistent) {
      const remaining = await prisma.audioRoomParticipant.count({
        where: { roomId, leftAt: null },
      });
      if (remaining === 0) {
        await prisma.audioRoom.update({
          where: { id: roomId },
          data: { status: 'ENDED', endedAt: new Date() },
        });
        emitToAudioRoom(roomId, 'audio-room:ended', { roomId });
        closeAudioRoom(roomId);
      }
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
        emitToAudioRoom(roomId, 'audio-room:ended', { roomId });
        closeAudioRoom(roomId);
      }
    }
    return { ok: true };
  },

  // Speaker demotes themselves back to LISTENER. Distinct from promote() because it doesn't
  // require moderator permission — a speaker can always step down.
  async stepDown(userId: string, roomId: string) {
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { id: true, role: true },
    });
    if (!p) throw BadRequest('Not in this room');
    if (p.role !== 'SPEAKER') throw BadRequest('Only speakers can step down');

    await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { role: 'LISTENER' } });
    emitToAudioRoom(roomId, 'audio-room:role-changed', { roomId, userId, role: 'LISTENER' });
    // New audience-role token so the client's Agora session updates its publish/subscribe posture.
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
      select: { hostId: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to mute users in this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { role: true },
    });
    if (!p) throw BadRequest('User is not in this room');
    if (p.role === 'LISTENER') throw BadRequest('Listener has no active mic to mute');

    emitToUser(targetUserId, 'audio-room:muted', { roomId, mutedBy: hostUserId });
    emitToAudioRoom(roomId, 'audio-room:user-muted', { roomId, userId: targetUserId, mutedBy: hostUserId });
    return { ok: true };
  },

  async muteAll(actorUserId: string, role: string, roomId: string) {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(actorUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to mute users in this room');

    const speakers = await prisma.audioRoomParticipant.findMany({
      where: { roomId, leftAt: null, role: { in: ['SPEAKER', 'HOST'] }, userId: { not: actorUserId } },
      select: { userId: true },
    });

    for (const s of speakers) {
      emitToUser(s.userId, 'audio-room:muted', { roomId, mutedBy: actorUserId });
    }
    emitToAudioRoom(roomId, 'audio-room:all-muted', {
      roomId, mutedBy: actorUserId, userIds: speakers.map((s) => s.userId),
    });
    return { ok: true, mutedCount: speakers.length };
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
      select: { hostId: true, status: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    if (room.status !== 'LIVE') throw BadRequest('Room is not live');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to change roles in this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { id: true },
    });
    if (!p) throw BadRequest('User is not in this room');

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
      select: { hostId: true, channelId: true, branchId: true, clusterId: true, type: true },
    });
    if (!room) throw NotFound('Room not found');
    const allowed = await canModerateRoom(hostUserId, role, room);
    if (!allowed) throw Forbidden('You do not have permission to remove users from this room');

    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId, leftAt: null },
      select: { id: true },
    });
    if (!p) throw BadRequest('User is not in this room');

    await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { leftAt: new Date() } });
    emitToUser(targetUserId, 'audio-room:kicked', { roomId });
    leaveAudioRoom(targetUserId, roomId);
    emitToAudioRoom(roomId, 'audio-room:user-left', { roomId, userId: targetUserId });
    return { ok: true };
  },

  async refreshToken(userId: string, roomId: string) {
    const p = await prisma.audioRoomParticipant.findFirst({
      where: { roomId, userId, leftAt: null },
      select: { role: true },
    });
    if (!p) throw BadRequest('Not in this room');

    const agoraRole = p.role === 'LISTENER' ? 'audience' : 'host';
    return this.issueToken(roomId, userId, agoraRole as 'host' | 'audience');
  },

  issueToken(roomId: string, userId: string, agoraRole: 'host' | 'audience') {
    if (!isAgoraConfigured()) {
      return { appId: null, token: null, channel: roomId, uid: stableUid(userId) };
    }
    const uid = stableUid(userId);
    const token = buildRtcToken(roomId, uid, agoraRole);
    return { appId: env.AGORA_APP_ID!, token, channel: roomId, uid };
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
      enqueue(notificationQueue, 'audio-room-started', { roomId, title, userIds: [...userIds] });
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
    const presence = await getBulkPresence(userIds);
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

    // Any room now empty → end it (persistent-room rule from leave()).
    let ended = 0;
    const affectedRoomIds = [...new Set(stale.map((p) => p.roomId))];
    for (const roomId of affectedRoomIds) {
      const remaining = await prisma.audioRoomParticipant.count({
        where: { roomId, leftAt: null },
      });
      if (remaining === 0) {
        await prisma.audioRoom.update({
          where: { id: roomId },
          data: { status: 'ENDED', endedAt: new Date() },
        });
        emitToAudioRoom(roomId, 'audio-room:ended', { roomId });
        closeAudioRoom(roomId);
        ended += 1;
      }
    }

    logger.info({ rooms: rooms.length, swept: stale.length, ended }, 'Phantom participant sweep complete');
    return { rooms: rooms.length, swept: stale.length, ended };
  },
};

import { prisma } from '../../infra/db';
import { joinAudioRoom, emitToAudioRoom, emitToUser } from '../../infra/realtime';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { redis, withDeadline } from '../../infra/redis';
import { addParticipantIfLive, audioRoomService, callJustEnded, publishRoomEnded, stableUid } from '../audio-rooms/audio-rooms.service';
import { isClusterModerator } from '../../utils/authorization';
import { BadRequest, Forbidden, NotFound } from '../../utils/errors';

// Shape must match audio-rooms.service.PARTICIPANT_SELECT so all clients render the same fields.
const PARTICIPANT_SELECT = {
  id: true,
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { id: true, displayName: true, avatarUrl: true } },
} as const;

// PRD clarification: Global Prayer Watch is a singleton channel every user is auto-joined to.
// It works as an ordinary chat channel PLUS members can spin up a live prayer audio call inside
// it. Only one live call at a time. The call is a persistent AudioRoom (type=PRAYER_WATCH) that
// stays live even if the starter leaves — it only ends when the last participant leaves, or when
// a Prayer Warriors cluster moderator / super admin force-ends it.
const PRAYER_WARRIORS_CLUSTER_SLUG = 'prayer-warriors';
const PRAYER_WATCH_ROOM_TITLE = 'Global Prayer Watch';

async function findGlobalPrayerWatchChannel() {
  const channel = await prisma.channel.findFirst({
    where: { type: 'GLOBAL_PRAYER_WATCH' },
    select: { id: true },
  });
  if (!channel) throw NotFound('Global Prayer Watch channel is not configured');
  return channel;
}

// Force-end permission: NARROW — super admin, or a moderator of the Prayer Warriors cluster
// specifically. Force-ending kicks everyone off the call so it stays a small trusted group.
async function canForceEndPrayerWatch(userId: string, role: string): Promise<boolean> {
  if (role === 'SUPER_ADMIN') return true;
  const cluster = await prisma.cluster.findUnique({
    where: { slug: PRAYER_WARRIORS_CLUSTER_SLUG },
    select: { id: true },
  });
  if (!cluster) return false;
  return isClusterModerator(userId, cluster.id);
}

async function requireForceEndPermission(userId: string, role: string) {
  if (!(await canForceEndPrayerWatch(userId, role))) {
    throw Forbidden('Only Prayer Warriors moderators or super admins can force-end the Prayer Watch call');
  }
}

async function findLiveRoom() {
  return prisma.audioRoom.findFirst({
    where: { type: 'PRAYER_WATCH', status: 'LIVE' },
    orderBy: { startedAt: 'desc' },
    select: { id: true, title: true, hostId: true, startedAt: true, createdAt: true },
  });
}

export const prayerWatchService = {
  // What the client polls on Home. Returns the GPW channel id + the currently-live call (if any).
  // channelId lets the client also fetch chat messages / send messages via the standard endpoints.
  async status() {
    const channel = await findGlobalPrayerWatchChannel();
    const live = await findLiveRoom();
    return { channelId: channel.id, live };
  },

  // Any authenticated user can start a call — but only when none is currently live. If a call
  // is already live, we attach the caller. Prayer Watch is Telegram-voice-chat style: every
  // participant is a SPEAKER by default, with a publisher Agora token, and can unmute and
  // speak immediately. There is no LISTENER role in a Prayer Watch call. Admins/moderators
  // can KICK disruptive participants (see audio-rooms.service.kick — canModerateRoom broadened
  // for PRAYER_WATCH to include any admin/mod).
  async start(userId: string, _role: string) {
    const channel = await findGlobalPrayerWatchChannel(); // ensures the channel exists — catches misconfigured envs

    // Cross-request mutex so two simultaneous starters don't both create a live room. The
    // check-then-create window at findLiveRoom() → audioRoom.create() is a classic TOCTOU
    // race — under "everyone tap now" pressure two callers would both see no live room and
    // both create one, splitting participants across two Agora channels. Lock covers the
    // check + create; auto-releases at 10s so a crashed request can't wedge the endpoint.
    const LOCK_KEY = 'lock:prayer-watch:start';
    let holdsLock = false;

    let existing = await findLiveRoom();
    if (!existing) {
      const acquired = await withDeadline(
        redis.set(LOCK_KEY, userId, 'PX', 10_000, 'NX'),
        500,
        null,
      );
      holdsLock = acquired === 'OK';
      if (!holdsLock) {
        // Another request holds the lock — brief wait, then re-check. The other request
        // will have created the room by then.
        await new Promise((r) => setTimeout(r, 400));
        existing = await findLiveRoom();
        if (!existing) {
          // Still nothing — lock holder may have crashed. Fall through and try to acquire
          // once more with a shorter TTL. If it fails again, give up cleanly.
          const retryAcquired = await withDeadline(
            redis.set(LOCK_KEY, userId, 'PX', 10_000, 'NX'),
            500,
            null,
          );
          holdsLock = retryAcquired === 'OK';
          if (!holdsLock) throw BadRequest('Another prayer call is being started, please try again');
        }
      } else {
        // We got the lock — re-check inside the lock in case another request created a
        // room after our first read but before we acquired.
        existing = await findLiveRoom();
      }
    }

    if (existing) {
      if (holdsLock) {
        redis.del(LOCK_KEY).catch(() => {}); // best-effort release
      }
      const p = await prisma.audioRoomParticipant.findFirst({
        where: { roomId: existing.id, userId, leftAt: null },
        select: { id: true, role: true },
      });
      if (!p) {
        // Fresh join → SPEAKER for everyone.
        // If the last person ended it under us, do not open a replacement call.
        let created;
        try {
          created = await addParticipantIfLive(existing.id, userId, 'SPEAKER');
        } catch (err) {
          if ((err as { message?: string }).message === 'Room is not live') {
            throw BadRequest('This call has ended');
          }
          throw err;
        }
        joinAudioRoom(userId, existing.id);
        emitToAudioRoom(existing.id, 'audio-room:user-joined', { ...created, agoraUid: stableUid(userId) });
      } else if (p.role === 'LISTENER') {
        // Transitional: anyone already in the room as a LISTENER (from a previous deploy's
        // rules) is upgraded to SPEAKER on their next rejoin so they can speak.
        await prisma.audioRoomParticipant.update({ where: { id: p.id }, data: { role: 'SPEAKER' } });
        emitToAudioRoom(existing.id, 'audio-room:role-changed', {
          roomId: existing.id, userId, role: 'SPEAKER',
        });
      }
      // Everyone in Prayer Watch is a publisher — always issue a host-role Agora token.
      const token = audioRoomService.issueToken(existing.id, userId, 'host');
      // Push the fresh token through the socket too, so a mid-call upgrade renews without an
      // extra REST call — client can just engine.renewToken().
      emitToUser(userId, 'audio-room:token', { roomId: existing.id, ...token });
      const detail = await audioRoomService.get(userId, existing.id);
      return { ...detail, agora: token, alreadyLive: true };
    }

    // No live call — create one. Starter is HOST; room is persistent so it survives the starter
    // leaving. isPersistent + type=PRAYER_WATCH together instruct leave() to end the room only
    // when the LAST participant leaves.
    // A phone still showing the call that just ended must not open a new one.
    if (await callJustEnded({ type: 'PRAYER_WATCH' })) {
      if (holdsLock) redis.del(LOCK_KEY).catch(() => {});
      throw BadRequest('This call has ended');
    }

    let room;
    try {
      room = await prisma.audioRoom.create({
        data: {
          title: PRAYER_WATCH_ROOM_TITLE,
          description: 'Live prayer call in the Global Prayer Watch channel',
          hostId: userId,
          type: 'PRAYER_WATCH',
          isPersistent: true,
          status: 'LIVE',
          provider: 'agora',
          startedAt: new Date(),
          participants: { create: { userId, role: 'HOST' } },
        },
        select: { id: true, title: true },
      });
    } finally {
      if (holdsLock) redis.del(LOCK_KEY).catch(() => {}); // release ASAP once the row exists
    }

    joinAudioRoom(userId, room.id);

    // Fan out "Prayer Watch call is live" push to every registered user (worker pages the User
    // table). Fire-and-forget so a Redis blip or BullMQ validation error can't 500 the starter
    // — the room already exists, the enqueue is a side-effect.
    const starter = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, avatarUrl: true },
    });
    enqueue(
      notificationQueue,
      'prayer-watch-live-fanout',
      {
        roomId: room.id,
        title: room.title,
        startedById: userId,
        startedByName: starter?.displayName?.trim() || 'Someone',
        startedByAvatarUrl: starter?.avatarUrl ?? '',
        channelId: channel.id,
      },
      { jobId: `prayer-watch-live-${room.id}` },
    );

    const detail = await audioRoomService.get(userId, room.id);
    return { ...detail, agora: audioRoomService.issueToken(room.id, userId, 'host'), alreadyLive: false };
  },

  // Force-end: Prayer Warriors moderator or super admin. Ends the call for everyone still on it.
  // Regular participants leaving just call the standard /audio-rooms/:id/leave and the room
  // auto-ends when the last one leaves (see audio-rooms.service.leave for persistent-room rules).
  async end(userId: string, role: string, roomId: string) {
    await requireForceEndPermission(userId, role);
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { type: true, status: true },
    });
    if (!room || room.type !== 'PRAYER_WATCH') throw NotFound('Prayer Watch call not found');
    if (room.status === 'ENDED') throw BadRequest('Prayer Watch call already ended');

    await prisma.audioRoom.update({
      where: { id: roomId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    await prisma.audioRoomParticipant.updateMany({
      where: { roomId, leftAt: null },
      data: { leftAt: new Date() },
    });

    const channel = await prisma.channel.findFirst({
      where: { type: 'GLOBAL_PRAYER_WATCH' },
      select: { id: true },
    });
    await publishRoomEnded(roomId, channel?.id ?? null, 'PRAYER_WATCH');
    return { ok: true };
  },
};

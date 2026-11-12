import { prisma } from '../../infra/db';
import { joinAudioRoom } from '../../infra/realtime';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { redis, withDeadline } from '../../infra/redis';
import { audioRoomService, callJustEnded, publishRoomEnded } from '../audio-rooms/audio-rooms.service';
import { openStation } from '../audio-rooms/station';
import { isClusterModerator } from '../../utils/authorization';
import { BadRequest, Forbidden, NotFound } from '../../utils/errors';

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
    select: {
      id: true,
      title: true,
      hostId: true,
      channelId: true,
      branchId: true,
      clusterId: true,
      type: true,
      playbackUrl: true,
      startedAt: true,
      createdAt: true,
    },
  });
}

export const prayerWatchService = {
  // What the client polls on Home. Returns the GPW channel id + the currently-live call (if any).
  // channelId lets the client also fetch chat messages / send messages via the standard endpoints.
  async status() {
    const channel = await findGlobalPrayerWatchChannel();
    const live = await findLiveRoom();
    if (!live) return { channelId: channel.id, live: null };
    return {
      channelId: channel.id,
      live: {
        id: live.id,
        title: live.title,
        hostId: live.hostId,
        playbackUrl: live.playbackUrl,
        startedAt: live.startedAt,
        createdAt: live.createdAt,
      },
    };
  },

  // Any authenticated user can start a call — but only when none is currently live. If a call
  // is already live, we attach the caller. Phones that omit preferPlayback still join as
  // speakers with a publisher token. A phone that sends it keeps a mic for the starter and
  // for admins. Everyone else gets the station link and is not added to the call roll.
  async start(userId: string, role: string, preferPlayback = false) {
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
      return audioRoomService.joinLiveCrowdCall(userId, role, existing, undefined, preferPlayback);
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
    await openStation(room.id, room.title);

    const detail = await audioRoomService.get(userId, room.id);
    return {
      ...detail,
      role: 'HOST' as const,
      playbackUrl: detail.playbackUrl ?? null,
      agora: audioRoomService.issueToken(room.id, userId, 'host'),
      alreadyLive: false,
    };
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

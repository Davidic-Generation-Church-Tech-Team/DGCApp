import type { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../../utils/jwt';
import { prisma } from '../../infra/db';
import { redis, withDeadline } from '../../infra/redis';
import { logger } from '../../infra/logger';
import { stableUid } from '../audio-rooms/audio-rooms.service';
import { getIo } from '../../infra/realtime';

const PRESENCE_TTL = 120; // seconds — refreshed every heartbeat; expires = offline
const PRESENCE_KEY = (uid: string) => `presence:${uid}`;
// Everyone currently online/away, scored by last heartbeat (ms). Lets admins list/count who is
// online without scanning presence:* keys, and lets the sweep find users whose TTL lapsed.
const ONLINE_SET = 'presence:online';
// Super-admin sockets join this room for the live online list (snapshot + per-change updates).
const PRESENCE_ADMIN_ROOM = 'presence:admins';
const SNAPSHOT_LIMIT = 5000;

type PresenceStatus = 'online' | 'away' | 'offline';

// Presence reads race a short deadline: if Redis is slow/unreachable, everyone reads as
// 'offline' and the request proceeds — an online dot is never worth stalling the chat list for.
export async function getUserPresence(userId: string): Promise<PresenceStatus> {
  const val = await withDeadline(redis.get(PRESENCE_KEY(userId)), 300, null);
  return (val as PresenceStatus) || 'offline';
}

export async function getBulkPresence(userIds: string[]): Promise<Record<string, PresenceStatus>> {
  if (!userIds.length) return {};
  const pipeline = redis.pipeline();
  for (const id of userIds) pipeline.get(PRESENCE_KEY(id));
  const results = await withDeadline(pipeline.exec(), 300, null);
  const out: Record<string, PresenceStatus> = {};
  userIds.forEach((id, i) => {
    const val = results?.[i]?.[1] as string | null;
    out[id] = (val as PresenceStatus) || 'offline';
  });
  return out;
}

export async function getOnlineCount(): Promise<number> {
  return withDeadline(redis.zcard(ONLINE_SET), 500, 0);
}

// Online/away users, most recently active first. `lastActiveAt` is the last heartbeat/connect.
export async function getOnlineUsers(offset = 0, limit = 50) {
  const [onlineCount, raw] = await Promise.all([
    getOnlineCount(),
    withDeadline(redis.zrevrange(ONLINE_SET, offset, offset + limit - 1, 'WITHSCORES'), 1000, [] as string[]),
  ]);
  const entries: { userId: string; lastActiveAt: Date }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({ userId: raw[i]!, lastActiveAt: new Date(Number(raw[i + 1])) });
  }
  const statuses = await getBulkPresence(entries.map((e) => e.userId));
  // A lapsed TTL reads as offline until the sweep removes it from the set — hide those rows.
  const users = entries
    .filter((e) => statuses[e.userId] !== 'offline')
    .map((e) => ({ ...e, status: statuses[e.userId] as PresenceStatus }));
  return { onlineCount, users, hasMore: offset + limit < onlineCount };
}

function notifyPresenceAdmins(userId: string, status: PresenceStatus, onlineCount: number, lastSeenAt?: Date) {
  getIo()?.to(PRESENCE_ADMIN_ROOM).emit('presence:admin-update', {
    userId,
    status,
    onlineCount,
    ...(lastSeenAt ? { lastSeenAt } : {}),
  });
}

// Single exit path to "offline": clears Redis, stamps User.lastSeenAt, and tells everyone.
// Used by socket disconnect and by the sweep for users whose heartbeat TTL lapsed.
async function markOffline(userId: string, lastSeenAt: Date) {
  const results = await withDeadline(
    redis.pipeline().del(PRESENCE_KEY(userId)).zrem(ONLINE_SET, userId).zcard(ONLINE_SET).exec(),
    500,
    null,
  );
  await prisma.user
    .updateMany({ where: { id: userId }, data: { lastSeenAt } })
    .catch((err) => logger.warn({ err, userId }, 'Failed to record lastSeenAt'));
  if (!results) return;
  // Only announce if they were actually visible as online/away (TTL may have expired already).
  const wasVisible = Number(results[0]?.[1] ?? 0) > 0 || Number(results[1]?.[1] ?? 0) > 0;
  if (!wasVisible) return;
  getIo()?.emit('presence', { userId, status: 'offline', lastSeenAt });
  notifyPresenceAdmins(userId, 'offline', Number(results[2]?.[1] ?? 0), lastSeenAt);
}

// Scheduled: users who stopped heart-beating without a clean disconnect (app killed, network
// lost, server restart) never fire 'disconnect'. Their presence key expires silently — this
// finds them via the online set, records last seen as their final heartbeat, and broadcasts.
export async function sweepExpiredPresence() {
  const ping = await withDeadline(redis.ping(), 500, null as string | null);
  if (ping !== 'PONG') return { skipped: 'redis-unhealthy', swept: 0 };

  const cutoff = Date.now() - PRESENCE_TTL * 1000;
  const raw = await redis.zrangebyscore(ONLINE_SET, '-inf', cutoff, 'WITHSCORES');
  let swept = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const userId = raw[i]!;
    // Heartbeat refreshes key and score together; a live key means the score write was lost.
    if (await redis.exists(PRESENCE_KEY(userId))) continue;
    await markOffline(userId, new Date(Number(raw[i + 1])));
    swept += 1;
  }
  return { swept };
}

export function registerSocketHandlers(io: Server) {
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.['token'] as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // Refresh the presence TTL and report whether the visible status changed. Callers broadcast
  // only on change — re-broadcasting every heartbeat is an O(users²) storm for zero information.
  async function setPresence(userId: string, status: PresenceStatus): Promise<boolean> {
    const results = await withDeadline(
      redis
        .pipeline()
        .get(PRESENCE_KEY(userId))
        .set(PRESENCE_KEY(userId), status, 'EX', PRESENCE_TTL)
        .zadd(ONLINE_SET, Date.now(), userId)
        .zcard(ONLINE_SET)
        .exec(),
      500,
      null,
    );
    if (!results) return false; // Redis unreachable — skip the broadcast, don't stall the socket
    const previous = (results[0]?.[1] as string | null) ?? 'offline';
    if (previous === status) return false;
    notifyPresenceAdmins(userId, status, Number(results[3]?.[1] ?? 0));
    return true;
  }

  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.user.sub as string;
    socket.join(`user:${userId}`);

    // --- Presence: mark online (broadcast only on an actual offline/away → online change) ---
    if (await setPresence(userId, 'online')) {
      socket.broadcast.emit('presence', { userId, status: 'online' });
    }

    // Super admins get the live online list: a snapshot now, then presence:admin-update deltas.
    if (socket.data.user.role === 'SUPER_ADMIN') {
      socket.join(PRESENCE_ADMIN_ROOM);
      void getOnlineUsers(0, SNAPSHOT_LIMIT).then((snapshot) => socket.emit('presence:online-snapshot', snapshot));
    }

    // Fetch display name (for typing indicators) alongside channel/room memberships in one round.
    let displayName: string | null = null;
    try {
      const [user, memberships, audioRooms] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
        prisma.channelMembership.findMany({ where: { userId }, select: { channelId: true } }),
        prisma.audioRoomParticipant.findMany({
          where: { userId, leftAt: null, room: { status: 'LIVE' } },
          select: { roomId: true },
        }),
      ]);
      displayName = user?.displayName ?? null;
      for (const m of memberships) socket.join(`channel:${m.channelId}`);
      for (const r of audioRooms) socket.join(`audio-room:${r.roomId}`);

      // Catch-up state: for every active audio room the user is a participant in, emit the
      // current live participant list to THIS socket. Guards against the socket-reconnect race
      // where a user-joined event fires during the ~200-500ms window between the handshake
      // completing and this handler joining the audio-room socket room — that event would
      // otherwise be missed forever, leaving the observer with a stale participant list.
      if (audioRooms.length) {
        const roomIds = audioRooms.map((r) => r.roomId);
        const participants = await prisma.audioRoomParticipant.findMany({
          where: { roomId: { in: roomIds }, leftAt: null },
          select: {
            id: true,
            roomId: true,
            userId: true,
            role: true,
            joinedAt: true,
            user: { select: { id: true, displayName: true, avatarUrl: true } },
          },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        });
        const byRoom = new Map<string, typeof participants>();
        for (const p of participants) {
          const arr = byRoom.get(p.roomId) ?? [];
          arr.push(p);
          byRoom.set(p.roomId, arr);
        }
        for (const roomId of roomIds) {
          const roomParticipants = (byRoom.get(roomId) ?? []).map((p) => ({ ...p, agoraUid: stableUid(p.userId) }));
          socket.emit('audio-room:state', { roomId, participants: roomParticipants });
        }
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to join channel rooms');
    }

    // --- Presence heartbeat: frontend sends every 60s to stay online ---
    socket.on('presence:heartbeat', async (payload?: { status?: string }) => {
      const status: PresenceStatus = payload?.status === 'away' ? 'away' : 'online';
      if (await setPresence(userId, status)) {
        socket.broadcast.emit('presence', { userId, status });
      }
    });

    // --- Typing indicators ---
    socket.on('typing:start', (payload: { channelId?: string }) => {
      if (payload?.channelId) {
        socket.to(`channel:${payload.channelId}`).emit('typing:start', {
          channelId: payload.channelId,
          userId,
          displayName,
        });
      }
    });

    socket.on('typing:stop', (payload: { channelId?: string }) => {
      if (payload?.channelId) {
        socket.to(`channel:${payload.channelId}`).emit('typing:stop', {
          channelId: payload.channelId,
          userId,
          displayName,
        });
      }
    });

    // Legacy alias
    socket.on('channel:typing', (payload: { channelId?: string }) => {
      if (payload?.channelId) {
        socket.to(`channel:${payload.channelId}`).emit('typing:start', {
          channelId: payload.channelId,
          userId,
          displayName,
        });
      }
    });

    // --- Mark channel as read via socket (no REST call needed) ---
    socket.on('channel:markRead', async (payload: { channelId?: string }) => {
      if (!payload?.channelId) return;
      try {
        await prisma.channelMembership.updateMany({
          where: { userId, channelId: payload.channelId },
          data: { lastReadAt: new Date() },
        });
      } catch { /* silently ignore if not a member */ }
    });

    // Join a room for a channel created after connect (e.g. a freshly opened DM).
    socket.on('channel:join', async (payload: { channelId?: string }) => {
      if (!payload?.channelId) return;
      const m = await prisma.channelMembership.findUnique({
        where: { userId_channelId: { userId, channelId: payload.channelId } },
      });
      if (m) socket.join(`channel:${payload.channelId}`);
    });

    // --- Disconnect: mark offline ---
    socket.on('disconnect', async () => {
      // Check if user has other active sockets (multi-device)
      const rooms = await io.in(`user:${userId}`).fetchSockets();
      if (rooms.length === 0) await markOffline(userId, new Date());
    });
  });

  logger.info('Socket.io handlers registered');
}

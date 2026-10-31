import type { Server, Socket } from 'socket.io';
import { Prisma } from '@prisma/client';
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
// Sockets watching one user's status join that user's watch room. Status changes go only to
// watchers — a global broadcast is O(online²) messages as everyone's status churns.
const PRESENCE_WATCH_ROOM = (uid: string) => `presence-of:${uid}`;
const MAX_PRESENCE_WATCHES = 500;
const SNAPSHOT_LIMIT = 5000;
const PRESENCE_READ_CHUNK = 500;
const SWEEP_BATCH = 500;
const SWEEP_MAX_ROUNDS = 20;
const SWEEP_LOCK = 'presence:sweep-lock';
// Caps concurrent connect-time DB work. After a deploy every client reconnects at once; without
// a cap those queries flood Prisma's small pool and starve HTTP requests until they time out.
const CONNECT_INIT_CONCURRENCY = 20;

type PresenceStatus = 'online' | 'away' | 'offline';

// Bulk presence read via chunked MGET. Returns null when Redis doesn't answer in time — that means
// "unknown", NOT "everyone offline". Anything that acts on offline-ness (removing call participants,
// filtering lists) must treat null as "skip", never as offline.
export async function readPresence(
  userIds: string[],
  deadlineMs: number,
): Promise<Record<string, PresenceStatus> | null> {
  if (!userIds.length) return {};
  const chunks: Promise<(string | null)[]>[] = [];
  for (let i = 0; i < userIds.length; i += PRESENCE_READ_CHUNK) {
    chunks.push(redis.mget(...userIds.slice(i, i + PRESENCE_READ_CHUNK).map(PRESENCE_KEY)));
  }
  const results = await withDeadline(Promise.all(chunks), deadlineMs, null);
  if (!results) return null;
  const values = results.flat();
  const out: Record<string, PresenceStatus> = {};
  userIds.forEach((id, i) => {
    out[id] = (values[i] as PresenceStatus | null) || 'offline';
  });
  return out;
}

// Presence reads race a short deadline: if Redis is slow/unreachable, everyone reads as
// 'offline' and the request proceeds — an online dot is never worth stalling the chat list for.
// Display-only: background jobs must use readPresence and handle null.
export async function getUserPresence(userId: string): Promise<PresenceStatus> {
  const val = await withDeadline(redis.get(PRESENCE_KEY(userId)), 300, null);
  return (val as PresenceStatus) || 'offline';
}

export async function getBulkPresence(userIds: string[]): Promise<Record<string, PresenceStatus>> {
  const presence = await readPresence(userIds, 300);
  return presence ?? Object.fromEntries(userIds.map((id) => [id, 'offline' as const]));
}

export async function getOnlineCount(): Promise<number> {
  return withDeadline(redis.zcard(ONLINE_SET), 500, 0);
}

// Online/away users, most recently active first. `lastActiveAt` is the last heartbeat/connect.
export async function getOnlineUsers(offset = 0, limit = 50) {
  const [onlineCount, raw] = await Promise.all([
    getOnlineCount(),
    withDeadline(redis.zrevrange(ONLINE_SET, offset, offset + limit - 1, 'WITHSCORES'), 2000, [] as string[]),
  ]);
  const entries: { userId: string; lastActiveAt: Date }[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({ userId: raw[i]!, lastActiveAt: new Date(Number(raw[i + 1])) });
  }
  const statuses = await readPresence(entries.map((e) => e.userId), 2000);
  // Statuses unknown (slow Redis): everyone in the set heart-beat recently, so show them as
  // online rather than returning an empty list.
  if (!statuses) {
    return { onlineCount, users: entries.map((e) => ({ ...e, status: 'online' as PresenceStatus })), hasMore: offset + limit < onlineCount };
  }
  // A lapsed TTL reads as offline until the sweep removes it from the set — hide those rows.
  const users = entries
    .filter((e) => statuses[e.userId] !== 'offline')
    .map((e) => ({ ...e, status: statuses[e.userId] as PresenceStatus }));
  return { onlineCount, users, hasMore: offset + limit < onlineCount };
}

function emitPresence(userId: string, status: PresenceStatus, lastSeenAt?: Date) {
  getIo()?.to(PRESENCE_WATCH_ROOM(userId)).emit('presence', {
    userId,
    status,
    ...(lastSeenAt ? { lastSeenAt } : {}),
  });
}

function notifyPresenceAdmins(userId: string, status: PresenceStatus, onlineCount: number, lastSeenAt?: Date) {
  getIo()?.to(PRESENCE_ADMIN_ROOM).emit('presence:admin-update', {
    userId,
    status,
    onlineCount,
    ...(lastSeenAt ? { lastSeenAt } : {}),
  });
}

// Called when a user's global role changes. Sockets keep the role from their connect-time JWT,
// so without this a demoted admin would keep receiving the live online list until reconnect.
export async function refreshPresenceAdminAccess(userId: string, isSuperAdmin: boolean) {
  const io = getIo();
  if (!io) return;
  if (!isSuperAdmin) {
    io.in(`user:${userId}`).socketsLeave(PRESENCE_ADMIN_ROOM);
    return;
  }
  io.in(`user:${userId}`).socketsJoin(PRESENCE_ADMIN_ROOM);
  io.to(`user:${userId}`).emit('presence:online-snapshot', await getOnlineUsers(0, SNAPSHOT_LIMIT));
}

// One batched UPDATE for many users' last-seen times (the sweep can mark hundreds at once).
async function recordLastSeen(rows: { userId: string; at: Date }[]) {
  if (!rows.length) return;
  const values = Prisma.join(rows.map((r) => Prisma.sql`(${r.userId}::text, ${r.at}::timestamp(3))`));
  await prisma
    .$executeRaw`UPDATE "User" AS u SET "lastSeenAt" = v.ts FROM (VALUES ${values}) AS v(id, ts) WHERE u."id" = v.id`
    .catch((err) => logger.warn({ err, count: rows.length }, 'Failed to record lastSeenAt'));
}

// Socket disconnect path to "offline": clears Redis, stamps User.lastSeenAt, tells watchers.
async function markOffline(userId: string, lastSeenAt: Date) {
  const results = await withDeadline(
    redis.pipeline().del(PRESENCE_KEY(userId)).zrem(ONLINE_SET, userId).zcard(ONLINE_SET).exec(),
    500,
    null,
  );
  await recordLastSeen([{ userId, at: lastSeenAt }]);
  if (!results) return;
  // Only announce if they were actually visible as online/away (TTL may have expired already).
  const wasVisible = Number(results[0]?.[1] ?? 0) > 0 || Number(results[1]?.[1] ?? 0) > 0;
  if (!wasVisible) return;
  emitPresence(userId, 'offline', lastSeenAt);
  notifyPresenceAdmins(userId, 'offline', Number(results[2]?.[1] ?? 0), lastSeenAt);
}

// Atomically removes candidates whose score is still stale AND whose presence key is gone, so a
// user who reconnects between the scan and the removal is never dropped. Candidates whose key is
// alive (their score write was lost) are re-scored so they stop matching the sweep.
// Returns [userId, score, userId, score, ...] for the removed users.
const SWEEP_SCRIPT = `
local removed = {}
for i = 3, #ARGV do
  local id = ARGV[i]
  local score = redis.call('ZSCORE', KEYS[1], id)
  if score and tonumber(score) <= tonumber(ARGV[1]) then
    if redis.call('EXISTS', 'presence:' .. id) == 0 then
      redis.call('ZREM', KEYS[1], id)
      table.insert(removed, id)
      table.insert(removed, score)
    else
      redis.call('ZADD', KEYS[1], ARGV[2], id)
    end
  end
end
return removed
`;

// Scheduled: users who stopped heart-beating without a clean disconnect (app killed, network
// lost, server restart) never fire 'disconnect'. Their presence key expires silently — this
// finds them via the online set, records last seen as their final heartbeat, and notifies.
// Batched and locked: after a crash every online user is stale at once.
export async function sweepExpiredPresence() {
  const ping = await withDeadline(redis.ping(), 500, null as string | null);
  if (ping !== 'PONG') return { skipped: 'redis-unhealthy', swept: 0 };
  const lock = await redis.set(SWEEP_LOCK, '1', 'EX', 55, 'NX');
  if (lock !== 'OK') return { skipped: 'already-running', swept: 0 };

  let swept = 0;
  try {
    for (let round = 0; round < SWEEP_MAX_ROUNDS; round++) {
      const now = Date.now();
      const cutoff = now - PRESENCE_TTL * 1000;
      const candidates = await redis.zrangebyscore(ONLINE_SET, '-inf', cutoff, 'LIMIT', 0, SWEEP_BATCH);
      if (!candidates.length) break;

      const removed = (await redis.eval(SWEEP_SCRIPT, 1, ONLINE_SET, cutoff, now, ...candidates)) as string[];
      const stale: { userId: string; at: Date }[] = [];
      for (let i = 0; i < removed.length; i += 2) {
        stale.push({ userId: removed[i]!, at: new Date(Number(removed[i + 1])) });
      }
      await recordLastSeen(stale);
      const onlineCount = await getOnlineCount();
      for (const s of stale) {
        emitPresence(s.userId, 'offline', s.at);
        notifyPresenceAdmins(s.userId, 'offline', onlineCount, s.at);
      }
      swept += stale.length;
      if (candidates.length < SWEEP_BATCH) break;
    }
  } finally {
    await redis.del(SWEEP_LOCK).catch(() => {});
  }
  return { swept };
}

// Set during graceful shutdown: sockets closing because THIS process is stopping must not mark
// their users offline (they reconnect to the next instance in seconds). If a user doesn't come
// back, the sweep marks them offline with lastSeenAt = their last heartbeat.
let shuttingDown = false;
export function beginPresenceShutdown() {
  shuttingDown = true;
}

let activeInits = 0;
const initQueue: (() => void)[] = [];
async function withConnectSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeInits >= CONNECT_INIT_CONCURRENCY) {
    await new Promise<void>((resolve) => initQueue.push(resolve)); // slot is handed over on release
  } else {
    activeInits += 1;
  }
  try {
    return await fn();
  } finally {
    const next = initQueue.shift();
    if (next) next();
    else activeInits -= 1;
  }
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

  // Refresh the presence TTL and report whether the visible status changed. Callers notify
  // watchers only on change — re-sending every heartbeat carries no information.
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
    if (!results) return false; // Redis unreachable — skip the notification, don't stall the socket
    const previous = (results[0]?.[1] as string | null) ?? 'offline';
    if (previous === status) return false;
    notifyPresenceAdmins(userId, status, Number(results[3]?.[1] ?? 0));
    return true;
  }

  io.on('connection', async (socket: Socket) => {
    const userId = socket.data.user.sub as string;
    socket.join(`user:${userId}`);

    // Handlers are registered before any await so no event (disconnect especially) is missed
    // while connect-time setup waits for a DB slot.
    let displayName: string | null = null;

    // --- Presence heartbeat: frontend sends every 60s to stay online ---
    socket.on('presence:heartbeat', async (payload?: { status?: string }) => {
      const status: PresenceStatus = payload?.status === 'away' ? 'away' : 'online';
      if (await setPresence(userId, status)) emitPresence(userId, status);
    });

    // --- Presence watch: client says whose status it is showing; acked with current statuses ---
    socket.on('presence:subscribe', async (payload: { userIds?: unknown }, ack?: (r: unknown) => void) => {
      const ids = Array.isArray(payload?.userIds)
        ? [...new Set(payload.userIds.filter((id): id is string => typeof id === 'string'))]
        : [];
      const watching = [...socket.rooms].filter((r) => r.startsWith('presence-of:')).length;
      const allowed = ids.slice(0, Math.max(0, MAX_PRESENCE_WATCHES - watching));
      socket.join(allowed.map(PRESENCE_WATCH_ROOM));
      if (typeof ack === 'function') ack({ statuses: await getBulkPresence(allowed) });
    });

    socket.on('presence:unsubscribe', (payload: { userIds?: unknown }) => {
      if (!Array.isArray(payload?.userIds)) return;
      for (const id of payload.userIds) {
        if (typeof id === 'string') socket.leave(PRESENCE_WATCH_ROOM(id));
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
      if (shuttingDown) return;
      // Check if user has other active sockets (multi-device)
      const rooms = await io.in(`user:${userId}`).fetchSockets();
      if (rooms.length === 0) await markOffline(userId, new Date());
    });

    // --- Presence: mark online (notify watchers only on an actual offline/away → online change) ---
    if (await setPresence(userId, 'online')) emitPresence(userId, 'online');

    // Super admins get the live online list: a snapshot now, then presence:admin-update deltas.
    if (socket.data.user.role === 'SUPER_ADMIN') {
      socket.join(PRESENCE_ADMIN_ROOM);
      void getOnlineUsers(0, SNAPSHOT_LIMIT).then((snapshot) => socket.emit('presence:online-snapshot', snapshot));
    }

    // Fetch display name (for typing indicators) alongside channel/room memberships and DM peers
    // (auto-watched so chat-list presence dots work without an explicit subscribe).
    await withConnectSlot(async () => {
      if (!socket.connected) return;
      try {
        const [user, memberships, audioRooms, dmPeers] = await Promise.all([
          prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
          prisma.channelMembership.findMany({ where: { userId }, select: { channelId: true } }),
          prisma.audioRoomParticipant.findMany({
            where: { userId, leftAt: null, room: { status: 'LIVE' } },
            select: { roomId: true },
          }),
          prisma.channelMembership.findMany({
            where: { userId: { not: userId }, channel: { type: 'DM', memberships: { some: { userId } } } },
            select: { userId: true },
            take: MAX_PRESENCE_WATCHES,
          }),
        ]);
        displayName = user?.displayName ?? null;
        for (const m of memberships) socket.join(`channel:${m.channelId}`);
        for (const r of audioRooms) socket.join(`audio-room:${r.roomId}`);
        socket.join(dmPeers.map((p) => PRESENCE_WATCH_ROOM(p.userId)));

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
    });
  });

  logger.info('Socket.io handlers registered');
}

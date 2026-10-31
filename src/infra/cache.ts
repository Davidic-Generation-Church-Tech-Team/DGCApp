import { redis, withDeadline } from './redis';
import { logger } from './logger';

// Read-through JSON cache over the shared Redis client. For read-heavy, rarely-written data
// (member lists, channel meta, profiles, branch/cluster catalogues). Safety rules:
//   1. A cache failure must never break OR SLOW a request — reads race a 300ms deadline and
//      fall back to the loader, so a Redis outage degrades to DB speed instead of hanging.
//   2. Per-user fields (myRole, isMuted, presence, isMember) are NEVER cached — callers cache
//      the shared payload and merge user-specific bits live.
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  opts?: { skipCacheIfEmpty?: boolean },
): Promise<T> {
  const hit = await withDeadline(redis.get(key), 300, null);
  if (hit !== null) {
    try {
      const parsed = JSON.parse(hit) as T;
      // Poisoned-cache safeguard: if the cached value is empty AND the caller opted into
      // skip-if-empty, ignore the cached entry and re-fetch. Also delete it so it can't come
      // back on the next read. Guards against a brief empty DB response getting stuck for 300s.
      if (opts?.skipCacheIfEmpty && isEmpty(parsed)) {
        redis.del(key).catch(() => {});
      } else {
        return parsed;
      }
    } catch {
      // corrupt entry — fall through to the loader, which overwrites it
    }
  }
  const fresh = await load();
  // Fire-and-forget: the response must not wait on the cache write. If Redis is briefly down,
  // ioredis queues the command and flushes it on reconnect.
  if (!opts?.skipCacheIfEmpty || !isEmpty(fresh)) {
    redis.set(key, JSON.stringify(fresh), 'EX', ttlSeconds).catch((err) => {
      logger.warn({ err, key }, 'cache write failed');
    });
  }
  return fresh;
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export async function invalidate(...keys: string[]) {
  if (!keys.length) return;
  // Fire-and-forget for the same reason: a mutation response must not block on Redis. Queued
  // deletes flush on reconnect; worst case a stale entry lives out its short TTL.
  redis.del(...keys).catch((err) => {
    logger.warn({ err, keys }, 'cache invalidate failed');
  });
}

// Single place for key shapes so services and invalidators can't drift apart.
export const cacheKeys = {
  channelMeta: (channelId: string) => `cache:channel:${channelId}:meta`,
  channelMembers: (channelId: string) => `cache:channel:${channelId}:members`,
  userProfile: (userId: string) => `cache:user:${userId}:profile`,
  userAdminScopes: (userId: string) => `cache:user:${userId}:admin-scopes`,
  branches: 'cache:branches',
  branch: (id: string) => `cache:branch:${id}`,
  clusters: 'cache:clusters',
  adminDashboard: (scope: string) => `cache:admin:dashboard:${scope}`,
  adminAnalytics: 'cache:admin:analytics',
};

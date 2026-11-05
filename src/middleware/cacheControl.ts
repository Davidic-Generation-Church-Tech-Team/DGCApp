import type { RequestHandler } from 'express';

// Device-side HTTP caching for stable GETs. `private` = only the requesting device may cache
// (never a shared proxy/CDN — these responses are authenticated). Within max-age the phone's
// native HTTP cache serves the response with ZERO network — instant, and it works offline.
// stale-while-revalidate lets clients that support it show the cached copy immediately while
// refreshing in the background.
//
// Only for data where a briefly stale view is harmless (branch list, cluster catalogue, events).
// Never for chat, notifications, or anything with unread counts.
export const cacheControl =
  (maxAgeSeconds: number): RequestHandler =>
  (_req, res, next) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
    next();
  };

// Events change the moment an admin creates or deletes one. A cached list still shows
// the old row, and the next delete then says the event is missing.
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
};

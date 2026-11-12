# SCALE.md — scaling DGC backend to the target load

> Target (CLAUDE.md §1): **~10k registered → ~1,000–3,000 peak concurrent connections.** Not 10k
> simultaneous. "Do not over-engineer for hyperscale." This checklist takes the current single-instance
> deployment to that target. The architecture already supports it — these are provisioning + a couple of
> query optimizations, **not** a redesign.

## Already scale-friendly (no work needed)

- Stateless REST + JWT (verified locally, no per-request DB hit) → horizontal scale by adding instances.
- Socket.io + `@socket.io/redis-adapter` already wired → cross-instance broadcast works.
- Slow/fan-out work on BullMQ (email; push/growth later) → off the request path.
- Read state = `ChannelMembership.lastReadAt` (one row per member/channel), not per-message receipts.
- Keyset pagination on messages (O(limit), not O(offset)).
- Signed Cloudinary uploads (media bytes never touch the server).

## Pre-scale checklist (do in this order before going past a few hundred concurrent)

1. **PgBouncer / pooled Postgres (the #1 crash risk).**
   - Provision a pooled connection (Render external pooler or PgBouncer in transaction mode).
   - `DATABASE_URL` → **pooled** URL (runtime); `DIRECT_URL` → **direct** URL (migrations only).
   - Transaction-mode pooling can't use prepared statements — append `?pgbouncer=true` (or set
     the pg adapter accordingly) so Prisma disables them.
   - Point `prisma.config.ts` migrations at `DIRECT_URL`; runtime client (`db.ts`) at `DATABASE_URL`.

2. **Multiple web instances.**
   - Bump the Render plan and run ≥2–3 instances. The Redis adapter handles socket fan-out across them.
   - Socket.io: force `transports: ['websocket']` on the client (or enable sticky sessions on Render) so
     the HTTP-polling handshake doesn't bounce between instances.

3. **Right-size Redis.**
   - Paid Render Key Value in Oregon, same region as the web service. Leave eviction at "do not evict."
   - Queues drop finished jobs and keep 20 failures and 100 event-log lines (`src/infra/queue.ts`).
     A full Redis rejects the script that would delete old jobs, so the queues can never drain.
   - If logs show `OOM command not allowed when used memory > 'maxmemory'`, run
     `scripts/clear-stuck-queues.ts` on the Render shell. It removes `bull:*` keys only.

4. **Scale the one web service sideways.**
   - Workers stay inside the web process. Extra copies compete for the same BullMQ jobs.
     Schedulers use a fixed id, so copies do not double-send reminders.
   - `render.yaml` keeps `numInstances: 1`. Raise that number to add copies. Set `DB_POOL_MAX`
     so copies × pool stays under the Postgres connection limit.
   - Socket rooms already go through the Redis adapter. Before `numInstances` is greater than 1,
     the phone must connect with websocket only. Render spreads requests, and a polling handshake
     is not pinned to one copy.

5. **Query hotspots.**
   - [x] `GET /channels` unread counts + last message — batched into ~4 queries (was N+1). _(done)_
   - [x] Church-wide fan-outs (announcements, chat, channel calls, event reminders, new events) read members in pages of 1,000 and look up device tokens in the same size. A new-event push saves the last finished page on the job, so a retry continues there. A push never loads the whole church into one query.
   - [x] One Agora Media Push per live Prayer Watch or channel call. Members who join with the station are in the call, muted, and are not Agora participants. The speaker socket receives a listener count, not one shout per listener. `POST /mic` unmutes and mutes.
   - If channels get very large, denormalize unread via a counter only if profiling demands it (a naive
     per-member counter reintroduces N×M writes — avoid; the batched query is usually enough).

6. **Separate dev and prod databases** (§10) before real traffic — never share.

7. **Load test before launch.**
   - REST: k6 / Artillery to target p99 under load. Sockets: a connection swarm (e.g. artillery
     socketio engine) to ~3k concurrent. Find the real ceiling per instance; size instance count from it.

8. **Observability.**
   - [x] Structured logs with request IDs and secret/header redaction.
   - [x] `/metrics` exposes request-duration/error-rate metrics, socket connection gauges, BullMQ queue
         depth, worker job counts/durations, process memory, uptime, and event-loop delay.
   - [x] `/ready` checks database + Redis separately from cheap `/health` liveness.
   - [x] Sentry SDK wired for Express 500s, worker failures, release/environment tagging, and PII redaction.
   - In Sentry, create alerts for: new production issue, error-rate spike, slow transaction spike, and repeated
     worker failures.

## Cost note

This target is modest — a handful of small Render instances + a paid Redis + pooled Postgres. Don't
provision for 10k _concurrent_ (a 3–10× harder bar) unless real numbers justify it.

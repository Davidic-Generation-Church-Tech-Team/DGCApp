import type { Queue, JobsOptions } from 'bullmq';
import { logger } from './logger';

// Fire-and-forget enqueue: never let a background job failure crash the primary request.
// The one production incident so far (BullMQ "Custom Id cannot contain :") turned an
// async push into a 500 because the enqueue was awaited raw. Every enqueue that follows
// a successful primary write should go through this helper — the write already succeeded,
// the notification is a side-effect.
//
// Default options: 3 attempts with exponential backoff + auto-cleanup. Callers can override
// per job (e.g. delay for scheduled call-timeout).
const DEFAULT_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { count: 20 },
};

export function enqueue(queue: Queue, name: string, data: unknown, opts?: JobsOptions): void {
  queue
    .add(name, data as object, { ...DEFAULT_OPTS, ...opts })
    .catch((err) => logger.warn({ err, queue: queue.name, name, jobId: opts?.jobId }, 'enqueue failed'));
}

// Best-effort. An active worker ignores the remove and must notice the call is no longer live.
export function dropJob(queue: Queue, jobId: string): void {
  queue
    .getJob(jobId)
    .then((job) => job?.remove())
    .catch((err) => logger.warn({ err, queue: queue.name, jobId }, 'could not drop queued job'));
}

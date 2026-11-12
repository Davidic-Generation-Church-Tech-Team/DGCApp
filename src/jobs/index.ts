import { logger } from '../infra/logger';
import { notificationQueue } from '../infra/queue';
import './workers/email.worker';
import './workers/sms.worker';
import './workers/notification.worker';
import './workers/growth.worker';

export function startWorkers() {
  // Each copy of the web service runs these workers. BullMQ hands a job to one copy.
  // upsertJobScheduler uses a fixed id, so extra copies refresh the same schedule.
  // Repeatable scan (every 15 min) that sends pre-event reminders. Idempotent across restarts.
  notificationQueue
    .upsertJobScheduler('event-reminders', { every: 15 * 60 * 1000 }, { name: 'event-reminders-scan' })
    .then(() => logger.info('Event-reminder scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register reminder scheduler'));
  // Repeatable scan (every 5 min) for scheduled audio rooms — 15-min "starting soon" window,
  // so the tighter cadence keeps reminders close to the actual start time.
  notificationQueue
    .upsertJobScheduler('audio-room-reminders', { every: 5 * 60 * 1000 }, { name: 'audio-room-reminders-scan' })
    .then(() => logger.info('Audio-room-reminder scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register audio-room reminder scheduler'));
  // Safety net for ringing DM calls. Each call also gets its own delayed timeout job; this scan
  // catches anything left ringing after a worker restart or failed delayed job.
  notificationQueue
    .upsertJobScheduler('call-timeouts', { every: 30 * 1000 }, { name: 'call-timeout-scan' })
    .then(() => logger.info('Call-timeout scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register call-timeout scheduler'));
  // Phantom-participant sweep for persistent audio rooms (Prayer Watch). Combined with the
  // 120s presence TTL, users who leave the app without calling /leave are cleaned up in
  // roughly 2-5 minutes. Skips itself if Redis is unhealthy (safety guard).
  notificationQueue
    .upsertJobScheduler('audio-room-phantom-sweep', { every: 3 * 60 * 1000 }, { name: 'audio-room-phantom-sweep' })
    .then(() => logger.info('Audio-room phantom-sweep scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register phantom-sweep scheduler'));
  // Bunny ends one live stream at 12 hours. Refresh a crowd-call station before that.
  notificationQueue
    .upsertJobScheduler('station-refresh', { every: 60 * 60 * 1000 }, { name: 'station-refresh' })
    .then(() => logger.info('Station-refresh scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register station-refresh scheduler'));
  // Presence sweep: users whose heartbeat lapsed without a clean socket disconnect are marked
  // offline (broadcast + lastSeenAt). With the 120s TTL, they show offline within ~3 minutes.
  notificationQueue
    .upsertJobScheduler('presence-sweep', { every: 60 * 1000 }, { name: 'presence-sweep' })
    .then(() => logger.info('Presence-sweep scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register presence-sweep scheduler'));
  // Birthday wishes: every hour from 7am to 8pm in Lagos. Each person is wished once that year.
  notificationQueue
    .upsertJobScheduler(
      'birthday-wishes',
      { pattern: '5 7-20 * * *', tz: 'Africa/Lagos' },
      { name: 'birthday-scan' },
    )
    .then(() => logger.info('Birthday-wish scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register birthday-wish scheduler'));
  // Daily janitor: wipes expired OTPs, aged notifications, and stale reminders.
  notificationQueue
    .upsertJobScheduler('janitor', { every: 24 * 60 * 60 * 1000 }, { name: 'janitor-scan' })
    .then(() => logger.info('Janitor scheduler registered'))
    .catch((err) => logger.error({ err }, 'Failed to register janitor scheduler'));
  logger.info('Workers started (in-process)');
}

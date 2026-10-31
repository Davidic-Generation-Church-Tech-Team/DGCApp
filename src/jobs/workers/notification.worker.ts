import { Worker } from 'bullmq';
import { prisma } from '../../infra/db';
import { logger } from '../../infra/logger';
import { instrumentWorker } from '../../infra/metrics';
import { workerOptions } from '../../infra/queue';
import { captureJobException } from '../../instrument';
import { eventService } from '../../modules/events/events.service';
import { audioRoomService } from '../../modules/audio-rooms/audio-rooms.service';
import { sweepExpiredPresence } from '../../modules/chat/chat.socket';
import { callService } from '../../modules/calls/calls.service';
import { notificationService } from '../../modules/notifications/notifications.service';
import { pushService } from '../../modules/push/push.service';

const BATCH = 1000;

function channelDisplayName(channel: {
  type: string;
  name: string | null;
  branch: { name: string } | null;
  cluster: { name: string } | null;
} | null) {
  if (!channel) return 'Channel';
  if (channel.type === 'BRANCH_SECTION' && channel.branch?.name && channel.name) {
    return `${channel.branch.name} - ${channel.name}`;
  }
  return channel.name ?? channel.cluster?.name ?? channel.branch?.name ?? 'Channel';
}

function messagePushData(input: {
  channelId: string;
  messageId: string;
  senderName?: string;
  channelName?: string;
  notificationType?: 'MESSAGE' | 'MENTION' | 'ANNOUNCEMENT';
  mentionEveryone?: boolean;
}) {
  const canQuickReply = input.notificationType !== 'ANNOUNCEMENT';
  return {
    type: 'message',
    notificationType: input.notificationType ?? 'MESSAGE',
    route: 'CHAT',
    screen: 'CHAT',
    clickAction: 'OPEN_CHAT',
    androidChannelId: 'messages',
    channelId: input.channelId,
    messageId: input.messageId,
    deepLink: `dgc://channels/${input.channelId}/messages/${input.messageId}`,
    ...(canQuickReply ? { quickReplyAction: 'MESSAGE_REPLY', notificationCategory: 'MESSAGE_REPLY' } : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.channelName ? { channelName: input.channelName } : {}),
    ...(input.mentionEveryone !== undefined ? { mentionEveryone: input.mentionEveryone ? 'true' : 'false' } : {}),
  };
}

function prayerWatchPushData(roomId: string, channelId?: string | null) {
  return {
    type: 'prayer_watch',
    notificationType: 'SYSTEM',
    route: 'PRAYER_WATCH',
    screen: 'PRAYER_WATCH',
    clickAction: 'OPEN_PRAYER_WATCH',
    androidChannelId: 'audio_rooms',
    roomId,
    ...(channelId ? { channelId } : {}),
    deepLink: `dgc://prayer-watch/rooms/${roomId}`,
  };
}

function audioRoomPushData(roomId: string) {
  return {
    type: 'audio_room',
    notificationType: 'SYSTEM',
    route: 'AUDIO_ROOM',
    screen: 'AUDIO_ROOM',
    clickAction: 'OPEN_AUDIO_ROOM',
    androidChannelId: 'audio_rooms',
    roomId,
    deepLink: `dgc://audio-rooms/${roomId}`,
  };
}

export const notificationWorker = new Worker(
  'notification',
  async (job) => {
    // Scheduled scan: send pre-event reminders to attendees (PRD §9).
    if (job.name === 'event-reminders-scan') {
      const result = await eventService.sendDueEventReminders();
      logger.info({ jobId: job.id, ...result }, 'Event reminders processed');
      return;
    }

    // Scheduled scan: "starting soon" reminders for scheduled audio rooms (PRD §8/§12).
    if (job.name === 'audio-room-reminders-scan') {
      const result = await audioRoomService.sendDueRoomReminders();
      if (result.rooms > 0) logger.info({ jobId: job.id, ...result }, 'Audio room reminders processed');
      return;
    }

    // Scheduled scan: mark participants as left when their user has been offline for > 120s (the
    // presence TTL). Applies only to persistent rooms (Prayer Watch) since non-persistent rooms
    // clean up naturally when the host leaves. Ends the room when the last participant is swept.
    if (job.name === 'audio-room-phantom-sweep') {
      const result = await audioRoomService.sweepPhantomParticipants();
      if (result.swept && result.swept > 0) logger.info({ jobId: job.id, ...result }, 'Phantom sweep swept participants');
      return;
    }

    if (job.name === 'presence-sweep') {
      const result = await sweepExpiredPresence();
      if (result.swept > 0) logger.info({ jobId: job.id, ...result }, 'Presence sweep marked users offline');
      return;
    }

    if (job.name === 'call-incoming-push') {
      const { callId } = job.data as { callId: string };
      await callService.sendIncomingPush(callId);
      return;
    }

    if (job.name === 'call-timeout') {
      const { callId } = job.data as { callId: string };
      await callService.markMissed(callId);
      return;
    }

    if (job.name === 'call-timeout-scan') {
      const result = await callService.markExpiredRingingCalls();
      if (result.missed > 0) logger.info({ jobId: job.id, ...result }, 'Expired DM calls marked missed');
      return;
    }

    if (job.name === 'channel-call-started') {
      const {
        roomId,
        channelId,
        channelName,
        startedById,
        startedByName,
        startedByAvatarUrl,
        createdAt,
      } = job.data as {
        roomId: string;
        channelId: string;
        channelName: string;
        startedById: string;
        startedByName: string;
        startedByAvatarUrl?: string;
        createdAt: string;
      };
      const startedAtMs = Date.parse(createdAt);
      const expiresAt = new Date(startedAtMs + 30_000);
      const ttlMs = expiresAt.getTime() - Date.now();
      if (Number.isNaN(startedAtMs) || ttlMs <= 0) return;

      const room = await prisma.audioRoom.findUnique({
        where: { id: roomId },
        select: { status: true, channelId: true, type: true },
      });
      if (!room || room.status !== 'LIVE' || room.type !== 'CHANNEL_CALL' || room.channelId !== channelId) return;

      const members = await prisma.channelMembership.findMany({
        where: {
          channelId,
          userId: { not: startedById },
          mutedAt: null,
          user: { deletedAt: null, suspendedAt: null },
        },
        select: { userId: true },
      });
      const userIds = members.map((m) => m.userId);
      if (!userIds.length) return;

      const ringPayload = {
        title: channelName,
        body: `${startedByName} started a group call`,
        ttlMs,
        data: {
          type: 'call',
          notificationType: 'CALL',
          route: 'CALL',
          screen: 'CHANNEL_CALL',
          callAction: 'incoming',
          callKind: 'CHANNEL_AUDIO_ROOM',
          clickAction: 'INCOMING_CALL',
          androidChannelId: 'calls',
          callId: roomId,
          roomId,
          channelId,
          channelName,
          callType: 'AUDIO',
          agoraChannel: roomId,
          callerId: startedById,
          callerName: startedByName,
          callerAvatarUrl: startedByAvatarUrl ?? '',
          createdAt,
          expiresAt: expiresAt.toISOString(),
          deepLink: `dgc://channels/${channelId}/calls/${roomId}`,
        },
      };
      // Batched like the other fan-outs so a large cluster doesn't load every device token at once.
      for (let i = 0; i < userIds.length; i += BATCH) {
        await pushService.sendIncomingCallToUsers(userIds.slice(i, i + BATCH), ringPayload);
      }
      logger.info({ jobId: job.id, roomId, channelId, notified: userIds.length }, 'Channel call ring fan-out complete');
      return;
    }

    // Prayer Watch fan-out: page every registered user (not deleted, not suspended) and push
    // "Prayer Watch is live — tap to join". Also drops a notification row so it appears in the
    // in-app notification center. Batched at BATCH so a 100k-user org doesn't OOM.
    if (job.name === 'prayer-watch-live-fanout') {
      const { roomId, title, startedById, channelId: queuedChannelId } = job.data as {
        roomId: string;
        title: string;
        startedById: string;
        channelId?: string;
      };
      const channelId = queuedChannelId ?? (await prisma.channel.findFirst({
        where: { type: 'GLOBAL_PRAYER_WATCH' },
        select: { id: true },
      }))?.id;
      const payload = {
        title: 'Prayer Watch is live',
        body: `${title} — tap to join the ongoing prayer`,
        data: prayerWatchPushData(roomId, channelId),
      };
      let cursor: string | undefined;
      let notified = 0;
      // Keyset paginate over User.id — stable even with concurrent inserts.
      for (;;) {
        const users = await prisma.user.findMany({
          where: {
            deletedAt: null,
            suspendedAt: null,
            id: { ...(cursor ? { gt: cursor } : {}), not: startedById },
          },
          orderBy: { id: 'asc' },
          take: BATCH,
          select: { id: true },
        });
        if (!users.length) break;
        const ids = users.map((u) => u.id);
        await prisma.notification.createMany({
          data: ids.map((userId) => ({ userId, type: 'SYSTEM' as const, ...payload })),
          skipDuplicates: true,
        });
        await pushService.sendToUsers(ids, { ...payload, threadId: `prayer-watch:${roomId}` });
        notified += ids.length;
        cursor = users[users.length - 1]!.id;
        if (users.length < BATCH) break;
      }
      logger.info({ jobId: job.id, roomId, notified }, 'Prayer Watch fan-out complete');
      return;
    }

    // Announcement fan-out (§4/§12): one Notification row per channel member, batched so a 10k-member
    // broadcast never blocks the request path. FCM push delivery will hook in here next.
    if (job.name === 'announcement-fanout') {
      const { channelId, messageId, title, body, excludeUserId } = job.data as {
        channelId: string;
        messageId: string;
        title: string;
        body?: string | null;
        excludeUserId?: string;
      };
      const members = await prisma.channelMembership.findMany({
        where: { channelId, mutedAt: null, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
        select: { userId: true },
      });
      let created = 0;
      for (let i = 0; i < members.length; i += BATCH) {
        const chunk = members.slice(i, i + BATCH).map((m) => ({
          userId: m.userId,
          type: 'ANNOUNCEMENT' as const,
          title,
          body: body ?? null,
          data: messagePushData({ channelId, messageId, notificationType: 'ANNOUNCEMENT' }),
        }));
        const res = await prisma.notification.createMany({ data: chunk });
        created += res.count;
      }
      await pushService.sendToUsers(
        members.map((m) => m.userId),
        {
          title,
          body: body ?? null,
          data: messagePushData({ channelId, messageId, notificationType: 'ANNOUNCEMENT' }),
          threadId: `channel:${channelId}`,
        },
      );
      logger.info({ jobId: job.id, channelId, created }, 'Announcement fan-out complete');
      return;
    }

    // Group/channel message fan-out: FCM push ONLY to non-muted members — no Notification rows.
    // Persisting a row per member per group message would grow the table by thousands of rows a
    // day for one busy channel; in-app notification entries are reserved for DMs, mentions,
    // announcements, and events (WhatsApp semantics).
    if (job.name === 'message-fanout') {
      const { channelId, messageId, senderId, senderName, body } = job.data as {
        channelId: string;
        messageId: string;
        senderId: string;
        senderName: string;
        body: string | null;
      };
      const [members, channel] = await Promise.all([
        prisma.channelMembership.findMany({
          where: { channelId, userId: { not: senderId }, mutedAt: null },
          select: { userId: true },
        }),
        prisma.channel.findUnique({
          where: { id: channelId },
          select: {
            type: true,
            name: true,
            branch: { select: { name: true } },
            cluster: { select: { name: true } },
          },
        }),
      ]);
      if (!members.length) return;
      const channelName = channelDisplayName(channel);
      const displaySender = senderName || 'Someone';
      await pushService.sendToUsers(
        members.map((m) => m.userId),
        {
          title: channelName,
          body: `${displaySender}: ${body || 'Sent a message'}`,
          data: messagePushData({ channelId, messageId, channelName, senderName: displaySender }),
          category: 'MESSAGE_REPLY',
          threadId: `channel:${channelId}`,
        },
      );
      return;
    }

    // DM notification — the recipient lookup, mute check, row insert, socket emit and push all
    // happen here instead of inside the sender's request.
    if (job.name === 'dm-notify') {
      const { channelId, messageId, senderId, senderName, body } = job.data as {
        channelId: string;
        messageId: string;
        senderId: string;
        senderName: string;
        body: string | null;
      };
      const other = await prisma.channelMembership.findFirst({
        where: { channelId, userId: { not: senderId } },
        select: { userId: true, mutedAt: true },
      });
      if (!other || other.mutedAt) return;
      await notificationService.notify(other.userId, {
        type: 'MESSAGE',
        title: senderName,
        body: body ?? 'Sent you a message',
        data: messagePushData({ channelId, messageId, senderName }),
        category: 'MESSAGE_REPLY',
        threadId: `channel:${channelId}`,
      });
      return;
    }

    // @mention notifications. Two modes:
    //   - targets[]  : notify those specific users (filtered to non-muted channel members).
    //   - everyone   : notify every non-muted member of the channel except the sender.
    // In both modes the title reflects the mode so the recipient's UI knows how to render it.
    if (job.name === 'mention-fanout') {
      const { channelId, messageId, senderName, body, targets, everyone, excludeUserId } = job.data as {
        channelId: string;
        messageId: string;
        senderName: string;
        body: string | null;
        targets?: string[];
        everyone?: boolean;
        excludeUserId?: string;
      };
      const where = everyone
        ? { channelId, mutedAt: null, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) }
        : { channelId, userId: { in: targets ?? [] }, mutedAt: null };
      const members = await prisma.channelMembership.findMany({ where, select: { userId: true } });
      const title = everyone ? `${senderName} mentioned @everyone` : `${senderName} mentioned you`;
      for (const m of members) {
        await notificationService.notify(m.userId, {
          type: 'MENTION',
          title,
          body: body ?? '',
          data: messagePushData({
            channelId,
            messageId,
            senderName,
            notificationType: 'MENTION',
            mentionEveryone: everyone,
          }),
          category: 'MESSAGE_REPLY',
          threadId: `channel:${channelId}`,
        });
      }
      return;
    }

    if (job.name === 'audio-room-started') {
      const { roomId, title, userIds } = job.data as {
        roomId: string;
        title: string;
        userIds: string[];
      };
      for (let i = 0; i < userIds.length; i += BATCH) {
        const chunk = userIds.slice(i, i + BATCH).map((userId) => ({
          userId,
          type: 'SYSTEM' as const,
          title: 'Audio room is live',
          body: title,
          data: audioRoomPushData(roomId),
        }));
        await prisma.notification.createMany({ data: chunk });
      }
      await pushService.sendToUsers(userIds, {
        title: 'Audio room is live',
        body: title,
        data: audioRoomPushData(roomId),
        threadId: `audio-room:${roomId}`,
      });
      logger.info({ jobId: job.id, roomId, notified: userIds.length }, 'Audio room start notification complete');
      return;
    }

    // Daily janitor — keeps hot tables lean. Everything deleted here is already invisible to users.
    if (job.name === 'janitor-scan') {
      const now = new Date();
      const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
      const [otps, readNotifs, oldNotifs, reminders, staleTokens] = await Promise.all([
        prisma.otp.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.notification.deleteMany({ where: { readAt: { not: null, lt: days(30) } } }),
        prisma.notification.deleteMany({ where: { createdAt: { lt: days(90) } } }),
        prisma.audioRoomReminder.deleteMany({ where: { room: { status: 'ENDED' } } }),
        // Rotated refresh tokens are kept briefly (revokedAt) for the flaky-network retry grace
        // window; rows older than a day — or past the 30d JWT lifetime — are dead weight.
        prisma.refreshToken.deleteMany({
          where: { OR: [{ revokedAt: { lt: days(1) } }, { createdAt: { lt: days(31) } }] },
        }),
      ]);
      logger.info(
        {
          jobId: job.id,
          expiredOtps: otps.count,
          readNotifications: readNotifs.count,
          oldNotifications: oldNotifs.count,
          staleReminders: reminders.count,
          staleRefreshTokens: staleTokens.count,
        },
        'Janitor scan complete',
      );
      return;
    }

    logger.info({ jobId: job.id, name: job.name }, 'Notification job received (no handler)');
  },
  workerOptions,
);

notificationWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Notification job failed');
  captureJobException('notification', job, err);
});

instrumentWorker(notificationWorker, 'notification');

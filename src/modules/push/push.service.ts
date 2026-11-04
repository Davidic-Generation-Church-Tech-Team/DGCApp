import { prisma } from '../../infra/db';
import { fcm, isPushConfigured } from '../../infra/fcm';
import { sendApnsAlerts, isApnsConfigured } from '../../infra/apns';
import { logger } from '../../infra/logger';
import { looksLikeRawApnsToken } from '../../utils/pushToken';
import type { Message } from 'firebase-admin/messaging';

type Platform = 'ANDROID' | 'IOS' | 'WEB';
type PushPayload = {
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  data?: Record<string, unknown>;
  category?: string;
  threadId?: string;
  androidChannelId?: string;
  clickAction?: string;
  tag?: string;
};
type IncomingCallPushPayload = PushPayload & { ttlMs?: number };
type TokenMessage = Extract<Message, { token: string }>;
type StoredDeviceToken = { token: string; platform: Platform };
type ApnsOptions = { ttlMs?: number; category?: string; threadId?: string };

// FCM data values must all be strings.
function stringifyDataValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function toStringMap(data?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    const value = stringifyDataValue(v);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function httpsImage(url: string | null | undefined): string | undefined {
  return url && url.startsWith('https://') ? url : undefined;
}

function pushData(p: PushPayload): Record<string, string> {
  return toStringMap({
    ...(p.category ? { notificationCategory: p.category } : {}),
    ...(p.threadId ? { threadId: p.threadId } : {}),
    ...(httpsImage(p.imageUrl) ? { imageUrl: httpsImage(p.imageUrl) } : {}),
    ...p.data,
  });
}

function defaultAndroidChannelId(data: Record<string, string>, p: PushPayload): string | undefined {
  if (p.androidChannelId) return p.androidChannelId;
  if (data['androidChannelId']) return data['androidChannelId'];
  if (p.category === 'MESSAGE_REPLY' || data['route'] === 'CHAT') return 'messages';
  if (data['route'] === 'AUDIO_ROOM' || data['route'] === 'PRAYER_WATCH') return 'audio_rooms';
  if (data['route'] === 'EVENT') return 'events';
  if (data['route'] === 'CALL') return 'calls';
  return undefined;
}

function androidClickAction(data: Record<string, string>, p: PushPayload): string | undefined {
  return p.clickAction ?? data['clickAction'] ?? data['click_action'];
}

function androidTag(data: Record<string, string>, p: PushPayload): string | undefined {
  return p.tag ?? data['notificationTag'] ?? data['callId'] ?? data['roomId'] ?? data['eventId'] ?? data['messageId'];
}

function isDeadTokenError(code?: string, message?: string): boolean {
  if (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/mismatched-credential'
  ) {
    return true;
  }
  if (code !== 'messaging/invalid-argument') return false;
  return /registration token|token is not a valid|invalid registration/i.test(message ?? '');
}

function isApnsRow(row: StoredDeviceToken): boolean {
  return row.platform === 'IOS' && looksLikeRawApnsToken(row.token);
}

function isAnyPushConfigured() {
  return isPushConfigured() || isApnsConfigured();
}

async function sendApnsRows(rows: StoredDeviceToken[], p: PushPayload, options: ApnsOptions = {}) {
  if (!rows.length) return;
  if (!isApnsConfigured()) {
    logger.warn({ iosApnsTokens: rows.length }, 'APNs push not configured; skipping raw iOS APNs tokens');
    return;
  }
  const tokens = rows.map((row) => row.token);
  const res = await sendApnsAlerts(tokens, {
    title: p.title,
    body: p.body,
    imageUrl: p.imageUrl,
    data: pushData(p),
    ttlMs: options.ttlMs,
    category: options.category ?? p.category,
    threadId: options.threadId ?? p.threadId,
  });
  const dead: string[] = [];
  for (const r of res) {
    if (!r.success) {
      logger.warn(
        {
          platform: 'IOS',
          tokenLength: r.token.length,
          status: r.status,
          reason: r.reason,
          apnsId: r.apnsId,
        },
        'APNs push delivery failed',
      );
      if (r.status === 410 && r.reason === 'Unregistered') dead.push(r.token);
    }
  }
  logger.info(
    {
      total: res.length,
      success: res.filter((r) => r.success).length,
      failure: res.filter((r) => !r.success).length,
    },
    'APNs push batch result',
  );
  if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
}

async function sendFcmRows(rows: StoredDeviceToken[], p: PushPayload) {
  if (!rows.length) return;
  if (!isPushConfigured()) {
    logger.warn({ fcmTokens: rows.length }, 'FCM push not configured; skipping FCM tokens');
    return;
  }
  const tokens = rows.map((row) => row.token);
  const data = pushData(p);
  const clickAction = androidClickAction(data, p);
  const channelId = defaultAndroidChannelId(data, p);
  const tag = androidTag(data, p);
  const imageUrl = httpsImage(p.imageUrl);
  const res = await fcm().sendEachForMulticast({
    tokens,
    notification: { title: p.title, ...(p.body ? { body: p.body } : {}), ...(imageUrl ? { imageUrl } : {}) },
    data,
    android: {
      priority: 'high',
      data,
      notification: {
        title: p.title,
        ...(p.body ? { body: p.body } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(channelId ? { channelId } : {}),
        ...(clickAction ? { clickAction } : {}),
        ...(tag ? { tag } : {}),
        priority: 'high',
        defaultSound: true,
        visibility: 'private',
      },
    },
    apns: {
      headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
      ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
      payload: {
        aps: {
          alert: { title: p.title, ...(p.body ? { body: p.body } : {}) },
          sound: 'default',
          ...(p.category ? { category: p.category } : {}),
          ...(p.threadId ? { threadId: p.threadId } : {}),
          mutableContent: true,
        },
      },
    },
  });
  const dead: string[] = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code;
      logger.warn(
        {
          platform: rows[i]?.platform,
          tokenLength: tokens[i]?.length,
          errorCode: code,
          message: r.error?.message,
        },
        'push delivery failed',
      );
      if (isDeadTokenError(code, r.error?.message)) {
        dead.push(tokens[i]!);
      }
    }
  });
  logger.info({
    total: tokens.length,
    ios: rows.filter((row) => row.platform === 'IOS').length,
    android: rows.filter((row) => row.platform === 'ANDROID').length,
    web: rows.filter((row) => row.platform === 'WEB').length,
    success: res.successCount,
    failure: res.failureCount,
  }, 'push batch result');
  if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
}

// Push to a set of tokens. Android/Web and FCM-shaped iOS tokens go through Firebase; raw iOS
// APNs tokens go directly to Apple because React Native Firebase Messaging is blocked for this app.
async function sendToTokens(rows: StoredDeviceToken[], p: PushPayload, options: ApnsOptions = {}) {
  if (!rows.length) return;
  const apnsRows = rows.filter(isApnsRow);
  const fcmRows = rows.filter((row) => !isApnsRow(row));
  await Promise.all([sendFcmRows(fcmRows, p), sendApnsRows(apnsRows, p, options)]);
}

async function sendTokenMessages(messages: TokenMessage[]) {
  if (!messages.length) return;
  if (!isPushConfigured()) {
    logger.warn({ fcmTokens: messages.length }, 'FCM push not configured; skipping FCM token messages');
    return;
  }
  for (let i = 0; i < messages.length; i += 500) {
    const chunk = messages.slice(i, i + 500);
    if (!chunk.length) continue;
    const res = await fcm().sendEach(chunk);
    const dead: string[] = [];
    res.responses.forEach((r, index) => {
      const token = chunk[index]?.token;
      if (!r.success && token) {
        const code = r.error?.code;
        logger.warn({ tokenLength: token.length, errorCode: code, message: r.error?.message }, 'push delivery failed');
        if (isDeadTokenError(code, r.error?.message)) {
          dead.push(token);
        }
      }
    });
    if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  }
}

function incomingCallMessage(token: string, p: IncomingCallPushPayload): TokenMessage {
  const ttl = Math.max(1_000, Math.min(p.ttlMs ?? 30_000, 30_000));
  const title = p.title;
  const body = p.body ?? 'Incoming call';
  const data = toStringMap({
    ...p.data,
    priority: 'high',
    clickAction: 'INCOMING_CALL',
    androidChannelId: 'calls',
    androidFullScreenIntent: true,
    androidForegroundService: true,
    iosCallKit: true,
    iosPushType: 'voip',
  });
  const callId = data['callId'] ?? 'incoming-call';

  return {
    token,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      ttl,
      directBootOk: true,
      data,
      notification: {
        title,
        body,
        channelId: 'calls',
        priority: 'max',
        sound: 'default',
        tag: callId,
        clickAction: 'INCOMING_CALL',
        sticky: true,
        visibility: 'public',
        localOnly: true,
        defaultSound: true,
        defaultVibrateTimings: true,
        eventTimestamp: new Date(),
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-expiration': String(Math.floor((Date.now() + ttl) / 1000)),
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: 'default',
          category: 'INCOMING_CALL',
          threadId: `call:${callId}`,
          contentAvailable: true,
          mutableContent: true,
        },
        call: data,
      },
    },
    webpush: {
      headers: { Urgency: 'high', TTL: String(Math.ceil(ttl / 1000)) },
      notification: { title, body, tag: callId, requireInteraction: true, data },
    },
    fcmOptions: { analyticsLabel: 'incoming_call' },
  };
}

export const pushService = {
  async registerDevice(userId: string, token: string, platform: Platform, voipToken?: string) {
    await prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform, voipToken: voipToken ?? null },
      update: { userId, platform, voipToken: voipToken ?? undefined },
    });
    logger.info(
      {
        userId,
        platform,
        tokenLength: token.length,
        tokenKind: platform === 'IOS' && looksLikeRawApnsToken(token) ? 'APNS' : 'FCM',
      },
      'device token registered',
    );
    return { ok: true };
  },

  async removeDevice(userId: string, token: string) {
    await prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  },

  // Fire-and-forget helpers — a push failure must never break the thing that triggered it.
  async sendToUser(userId: string, p: PushPayload) {
    if (!isAnyPushConfigured()) return;
    const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true, platform: true } });
    await sendToTokens(rows, p).catch((err) => logger.error({ err, userId }, 'push send failed'));
  },

  async sendToUsers(userIds: string[], p: PushPayload) {
    if (!isAnyPushConfigured() || !userIds.length) return;
    const rows = await prisma.deviceToken.findMany({ where: { userId: { in: userIds } }, select: { token: true, platform: true } });
    // FCM multicast caps at 500 tokens per call. Batches ran sequentially before — a 10k-user
    // fan-out took ~30s (10k / 500 = 20 batches × ~1.5s). Bounded concurrency of 5 cuts that
    // to ~6s without swamping the single Render instance's HTTP pool. Each batch still swallows
    // its own error so one FCM failure doesn't abort the whole fan-out.
    const CONCURRENCY = 5;
    const batches: StoredDeviceToken[][] = [];
    for (let i = 0; i < rows.length; i += 500) batches.push(rows.slice(i, i + 500));
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      await Promise.all(
        batches.slice(i, i + CONCURRENCY).map((batch) =>
          sendToTokens(batch, p).catch((err) => logger.error({ err }, 'push batch failed')),
        ),
      );
    }
  },

  async sendIncomingCallToUser(userId: string, p: IncomingCallPushPayload) {
    if (!isAnyPushConfigured()) return;
    const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true, platform: true } });
    const data = toStringMap(p.data);
    const callId = data['callId'] ?? 'incoming-call';
    const apnsRows = rows.filter(isApnsRow);
    const fcmMessages = rows.filter((row) => !isApnsRow(row)).map((row) => incomingCallMessage(row.token, p));
    await Promise.all([
      sendTokenMessages(fcmMessages),
      sendApnsRows(apnsRows, p, { ttlMs: p.ttlMs, category: 'INCOMING_CALL', threadId: `call:${callId}` }),
    ]).catch((err) => logger.error({ err, userId }, 'incoming call push failed'));
  },

  async sendIncomingCallToUsers(userIds: string[], p: IncomingCallPushPayload) {
    if (!isAnyPushConfigured() || !userIds.length) return;
    const rows = await prisma.deviceToken.findMany({ where: { userId: { in: userIds } }, select: { token: true, platform: true } });
    const data = toStringMap(p.data);
    const callId = data['callId'] ?? 'incoming-call';
    const apnsRows = rows.filter(isApnsRow);
    const fcmMessages = rows.filter((row) => !isApnsRow(row)).map((row) => incomingCallMessage(row.token, p));
    await Promise.all([
      sendTokenMessages(fcmMessages),
      sendApnsRows(apnsRows, p, { ttlMs: p.ttlMs, category: 'INCOMING_CALL', threadId: `call:${callId}` }),
    ]).catch((err) => logger.error({ err }, 'incoming group call push failed'));
  },
};

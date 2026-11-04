import { connect, constants, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from './logger';

type ApnsEnvironment = 'sandbox' | 'production';
type ApnsPayload = {
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  data?: Record<string, string>;
  ttlMs?: number;
  category?: string;
  threadId?: string;
};

export type ApnsSendResult = {
  token: string;
  success: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
};

type ApnsConfig = {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  environment: ApnsEnvironment;
};

const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedProviderToken: { value: string; createdAt: number } | null = null;

function readPrivateKey(): string | undefined {
  if (env.APNS_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.APNS_PRIVATE_KEY_BASE64, 'base64').toString('utf8').trim();
  }
  return env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
}

function readConfig(): ApnsConfig | null {
  const privateKey = readPrivateKey();
  if (!env.APNS_KEY_ID && !env.APNS_TEAM_ID && !env.APNS_BUNDLE_ID && !privateKey) return null;
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_BUNDLE_ID || !privateKey) {
    logger.warn('APNs config is incomplete; direct iOS push disabled');
    return null;
  }
  return {
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.APNS_BUNDLE_ID,
    privateKey,
    environment: env.APNS_ENV ?? (env.NODE_ENV === 'production' ? 'production' : 'sandbox'),
  };
}

const config = readConfig();
if (config) logger.info({ environment: config.environment, bundleId: config.bundleId }, 'APNs push initialised');

export const isApnsConfigured = () => config !== null;

function apnsHost() {
  if (!config) throw new Error('APNs not configured');
  return config.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
}

function providerToken() {
  if (!config) throw new Error('APNs not configured');
  const now = Date.now();
  if (cachedProviderToken && now - cachedProviderToken.createdAt < TOKEN_TTL_MS) {
    return cachedProviderToken.value;
  }
  const token = jwt.sign(
    { iss: config.teamId, iat: Math.floor(now / 1000) },
    config.privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: config.keyId } },
  );
  cachedProviderToken = { value: token, createdAt: now };
  return token;
}

function apnsPayload(p: ApnsPayload) {
  const imageUrl = p.imageUrl && p.imageUrl.startsWith('https://') ? p.imageUrl : undefined;
  const aps: Record<string, unknown> = {
    alert: { title: p.title, ...(p.body ? { body: p.body } : {}) },
    sound: 'default',
  };
  if (p.category) aps.category = p.category;
  if (p.threadId) aps['thread-id'] = p.threadId;
  // iOS only downloads a notification picture when the app's extension sees this flag.
  if (imageUrl) aps['mutable-content'] = 1;
  return { ...(p.data ?? {}), ...(imageUrl ? { imageUrl } : {}), aps };
}

function apnsExpiration(ttlMs?: number) {
  const ttl = ttlMs ?? 60 * 60 * 1000;
  return String(Math.floor((Date.now() + ttl) / 1000));
}

function headerString(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseReason(body: string) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

function sendOne(session: ClientHttp2Session, token: string, p: ApnsPayload): Promise<ApnsSendResult> {
  if (!config) throw new Error('APNs not configured');
  const body = JSON.stringify(apnsPayload(p));
  const req = session.request({
    [constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_POST,
    [constants.HTTP2_HEADER_SCHEME]: 'https',
    [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
    [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${providerToken()}`,
    'apns-topic': config.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': apnsExpiration(p.ttlMs),
  });

  return new Promise((resolve) => {
    let status = 0;
    let apnsId: string | undefined;
    let responseBody = '';

    req.setEncoding('utf8');
    req.on('response', (headers) => {
      const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
      status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
      apnsId = headerString(headers, 'apns-id');
    });
    req.on('data', (chunk) => {
      responseBody += String(chunk);
    });
    req.on('end', () => {
      resolve({
        token,
        success: status === 200,
        status,
        apnsId,
        reason: status === 200 ? undefined : parseReason(responseBody),
      });
    });
    req.on('error', (err) => {
      resolve({ token, success: false, status: 0, reason: err.message });
    });
    req.end(body);
  });
}

export async function sendApnsAlerts(tokens: string[], p: ApnsPayload): Promise<ApnsSendResult[]> {
  if (!tokens.length) return [];
  if (!config) throw new Error('APNs not configured');
  const session = connect(`https://${apnsHost()}`);
  session.on('error', (err) => logger.error({ err }, 'APNs HTTP/2 session failed'));
  try {
    return await Promise.all(tokens.map((token) => sendOne(session, token, p)));
  } finally {
    session.close();
  }
}

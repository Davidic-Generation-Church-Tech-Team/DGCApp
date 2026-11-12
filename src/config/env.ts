import 'dotenv/config';
import { z } from 'zod';

const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());
const sampleRate = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().min(0).max(1).default(0.05),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  SERVICE_NAME: z.string().default('dgc-backend'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  // Connections this one process may hold. Copies of the service each open their own pool,
  // so DB_POOL_MAX × instance count must stay under the Postgres connection limit.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(10),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // 1h balances security vs. connectivity: short enough that suspension bites within the hour,
  // long enough that a poor connection isn't forced through a refresh round trip every 15 min.
  JWT_ACCESS_TTL: z.string().default('1h'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BREVO_API_KEY: z.string().min(1),
  BREVO_SENDER_EMAIL: z.string().email(),
  BREVO_SENDER_NAME: z.string().default('DGC'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  CLOUDINARY_URL: z.string().optional(),
  // FCM push — base64-encoded Firebase service-account JSON. Push stays disabled until this is set.
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  // APNs push — direct iOS delivery for apps that register raw APNs tokens instead of FCM tokens.
  APNS_KEY_ID: optionalString,
  APNS_TEAM_ID: optionalString,
  APNS_BUNDLE_ID: optionalString,
  APNS_PRIVATE_KEY: optionalString,
  APNS_PRIVATE_KEY_BASE64: optionalString,
  APNS_ENV: z.enum(['sandbox', 'production']).optional(),
  // SMS (phone OTP) — optional; phone sign-in stays disabled until set. Termii (NG) by default.
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default('DGC'),
  TERMII_BASE_URL: z.string().default('https://api.ng.termii.com'),
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
  // Media Push (server REST). Mixes the mic table into one RTMP stream. Unused until set.
  AGORA_CUSTOMER_KEY: optionalString,
  AGORA_CUSTOMER_SECRET: optionalString,
  // Converter region: cn, ap, eu, or na. Empty follows the Bunny ingest region.
  AGORA_MEDIA_PUSH_REGION: optionalString,
  // Bunny Stream library where live ingest is enabled. The API key is that library's AccessKey.
  BUNNY_STREAM_LIBRARY_ID: optionalString,
  BUNNY_STREAM_API_KEY: optionalString,
  CORS_ORIGIN: z.string().default('*'),
  METRICS_TOKEN: z.string().optional(),
  SENTRY_DSN: optionalUrl,
  SENTRY_ENVIRONMENT: optionalString,
  SENTRY_RELEASE: optionalString,
  SENTRY_TRACES_SAMPLE_RATE: sampleRate,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;

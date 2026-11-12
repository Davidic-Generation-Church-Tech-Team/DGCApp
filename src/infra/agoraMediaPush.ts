import { env } from '../config/env';

const AGORA_REGIONS = new Set(['cn', 'ap', 'eu', 'na']);

const INGEST_TO_AGORA: Record<string, string> = {
  de: 'eu',
  eu: 'eu',
  falkenstein: 'eu',
  frankfurt: 'eu',
  uk: 'eu',
  ny: 'na',
  la: 'na',
  us: 'na',
  na: 'na',
  br: 'na',
  sg: 'ap',
  hk: 'ap',
  syd: 'ap',
  sy: 'ap',
  ap: 'ap',
};

export type ConverterRef = { region: string; id: string };

export function isMediaPushConfigured(): boolean {
  return !!(env.AGORA_APP_ID && env.AGORA_CUSTOMER_KEY && env.AGORA_CUSTOMER_SECRET);
}

/** Agora runs the converter in one region. Prefer an explicit setting, then the Bunny ingest region. */
export function agoraRegionForIngest(ingestRegion: string | null): string {
  const override = env.AGORA_MEDIA_PUSH_REGION?.toLowerCase();
  if (override && AGORA_REGIONS.has(override)) return override;
  const key = (ingestRegion ?? '').trim().toLowerCase();
  return INGEST_TO_AGORA[key] ?? 'eu';
}

export function packConverterRef(ref: ConverterRef): string {
  return `${ref.region}:${ref.id}`;
}

export function splitConverterRef(stored: string | null | undefined): ConverterRef | null {
  if (!stored) return null;
  const idx = stored.indexOf(':');
  if (idx <= 0) return { region: 'eu', id: stored };
  const region = stored.slice(0, idx);
  const id = stored.slice(idx + 1);
  if (!id || !AGORA_REGIONS.has(region)) return { region: 'eu', id: stored };
  return { region, id };
}

function authHeader(): string {
  const raw = `${env.AGORA_CUSTOMER_KEY}:${env.AGORA_CUSTOMER_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function converterUrl(region: string, converterId?: string): string {
  const base = `https://api.agora.io/${region}/v1/projects/${env.AGORA_APP_ID}/rtmp-converters`;
  return converterId ? `${base}/${encodeURIComponent(converterId)}` : base;
}

async function agora(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  if (method === 'DELETE' && (response.status === 404 || response.status === 200 || response.status === 204)) {
    return {};
  }
  if (!response.ok) {
    throw new Error(`Agora Media Push request failed (${response.status})`);
  }
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function converterIdFrom(body: unknown): string {
  if (!body || typeof body !== 'object') throw new Error('Agora Media Push did not return a converter');
  const root = body as { id?: unknown; converter?: { id?: unknown } };
  const id = root.converter?.id ?? root.id;
  if (typeof id !== 'string' || !id) throw new Error('Agora Media Push did not return a converter');
  return id;
}

/**
 * One mix of every publisher in the channel, plus a still 640×360 picture.
 * Bunny's live door expects H.264 and AAC. Listeners are not in this channel.
 * Audio is every publisher (rtcStreamUids omitted). The picture is a black canvas, not a camera.
 */
export async function createConverter(input: {
  channel: string;
  rtmpUrl: string;
  region: string;
  name: string;
}): Promise<ConverterRef> {
  if (!isMediaPushConfigured()) throw new Error('Agora Media Push is not configured');
  const body = {
    converter: {
      name: input.name.slice(0, 64),
      transcodeOptions: {
        rtcChannel: input.channel,
        audioOptions: {
          codecProfile: 'LC-AAC',
          sampleRate: 48000,
          bitrate: 48,
          audioChannels: 1,
        },
        videoOptions: {
          canvas: { width: 640, height: 360, color: 0 },
          codecProfile: 'baseline',
          frameRate: 5,
          gop: 10,
          bitrate: 600,
        },
      },
      rtmpUrl: input.rtmpUrl,
      idleTimeout: 300,
    },
  };
  const created = await agora('POST', converterUrl(input.region), body);
  return { region: input.region, id: converterIdFrom(created) };
}

export async function retargetConverter(ref: ConverterRef, rtmpUrl: string): Promise<void> {
  await agora('PATCH', converterUrl(ref.region, ref.id), {
    converter: { rtmpUrl },
    fields: 'rtmpUrl',
  });
}

export async function deleteConverter(ref: ConverterRef): Promise<void> {
  await agora('DELETE', converterUrl(ref.region, ref.id));
}

import { env } from '../config/env';

const BUNNY_STREAM = 'https://video.bunnycdn.com';

export type BunnyLiveStream = {
  id: string;
  streamKey: string;
  playbackUrl: string;
  /** Full RTMP URL Agora can push to. Includes the stream key. Never log this. */
  rtmpUrl: string;
  ingestRegion: string | null;
};

export function isBunnyStreamConfigured(): boolean {
  return !!(env.BUNNY_STREAM_LIBRARY_ID && env.BUNNY_STREAM_API_KEY);
}

function libraryId(): string {
  if (!env.BUNNY_STREAM_LIBRARY_ID || !env.BUNNY_STREAM_API_KEY) {
    throw new Error('Bunny Stream is not configured');
  }
  return env.BUNNY_STREAM_LIBRARY_ID;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The create and play responses wrap the stream differently. Use the inner object when present. */
function streamRecord(body: unknown): Record<string, unknown> {
  const root = asRecord(body) ?? {};
  return asRecord(root.liveStream) ?? asRecord(root.live) ?? root;
}

export function rtmpPublishUrl(ingestUrl: string, streamKey: string): string {
  const base = ingestUrl.trim().replace(/\/$/, '');
  if (!base || !streamKey) throw new Error('Bunny live stream did not return an ingest address');
  if (base.endsWith(`/${streamKey}`)) return base;
  const safe = /^[A-Za-z0-9._~-]+$/.test(streamKey) ? streamKey : encodeURIComponent(streamKey);
  return `${base}/${safe}`;
}

function toLiveStream(body: unknown): BunnyLiveStream {
  const row = streamRecord(body);
  const id = pickString(row, ['guid', 'id', 'streamId']);
  const streamKey = pickString(row, ['streamKey']);
  const playbackUrl = pickString(row, ['playbackUrlHls', 'playbackUrl', 'hlsUrl']);
  const ingest = pickString(row, ['primaryIngestUrl', 'ingestUrl', 'rtmpIngestUrl', 'rtmpUrl']);
  if (!id || !streamKey || !playbackUrl || !ingest) {
    throw new Error('Bunny live stream response was missing the play link or the ingest address');
  }
  return {
    id,
    streamKey,
    playbackUrl,
    rtmpUrl: rtmpPublishUrl(ingest, streamKey),
    ingestRegion: pickString(row, ['ingestRegion']),
  };
}

async function bunny(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BUNNY_STREAM}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      AccessKey: env.BUNNY_STREAM_API_KEY!,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // Status only. The body can echo the stream key.
    throw new Error(`Bunny live request failed (${response.status})`);
  }
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

export async function createLiveStream(title: string): Promise<BunnyLiveStream> {
  const id = encodeURIComponent(libraryId());
  const created = await bunny('POST', `/library/${id}/live`, { title, public: true });
  return toLiveStream(created);
}

/** Start has no body. A thin response is fine; the create call already returned the play link. */
export async function startLiveStream(streamId: string): Promise<void> {
  const id = encodeURIComponent(libraryId());
  await bunny('PUT', `/library/${id}/live/${encodeURIComponent(streamId)}/start`);
}

export async function stopLiveStream(streamId: string): Promise<void> {
  const id = encodeURIComponent(libraryId());
  await bunny('PUT', `/library/${id}/live/${encodeURIComponent(streamId)}/stop`);
}

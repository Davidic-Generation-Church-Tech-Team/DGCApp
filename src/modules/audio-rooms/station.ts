import { prisma } from '../../infra/db';
import { logger } from '../../infra/logger';
import { emitPlaybackToCrowd } from '../../infra/realtime';
import { isBunnyStreamConfigured, createLiveStream, startLiveStream, stopLiveStream } from '../../infra/bunnyStream';
import {
  isMediaPushConfigured,
  agoraRegionForIngest,
  createConverter,
  retargetConverter,
  deleteConverter,
  packConverterRef,
  splitConverterRef,
} from '../../infra/agoraMediaPush';

/** Bunny ends a live stream at 12 hours. Open a fresh one before that. */
export const STATION_REFRESH_AFTER_MS = 11 * 60 * 60 * 1000;

export function stationConfigured(): boolean {
  return isBunnyStreamConfigured() && isMediaPushConfigured();
}

function scrub(err: unknown): string {
  const message = err instanceof Error ? err.message : 'station request failed';
  return message.replace(/rtmp:\/\/\S+/gi, 'rtmp://[redacted]');
}

async function bestEffortStop(bunnyStreamId: string | null, converterRef: string | null) {
  const ref = splitConverterRef(converterRef);
  if (ref) {
    try {
      await deleteConverter(ref);
    } catch (err) {
      logger.warn({ err: scrub(err) }, 'Agora converter delete failed');
    }
  }
  if (bunnyStreamId) {
    try {
      await stopLiveStream(bunnyStreamId);
    } catch (err) {
      logger.warn({ err: scrub(err) }, 'Bunny live stop failed');
    }
  }
}

/**
 * Opens one Bunny live stream and one Agora mix pointed at it.
 * Returns the play link, or null when the station cannot come up. Never throws.
 * The stream key stays inside the RTMP URL sent to Agora and is not saved.
 */
export async function openStation(roomId: string, title: string): Promise<string | null> {
  if (!stationConfigured()) {
    logger.info({ roomId }, 'Live station skipped: Bunny or Agora Media Push is not configured');
    return null;
  }

  let bunnyStreamId: string | null = null;
  let converterRef: string | null = null;
  try {
    const created = await createLiveStream(title.slice(0, 120));
    bunnyStreamId = created.id;
    await startLiveStream(created.id);
    const region = agoraRegionForIngest(created.ingestRegion);
    const converter = await createConverter({
      channel: roomId,
      rtmpUrl: created.rtmpUrl,
      region,
      name: `dgc${roomId}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 64),
    });
    converterRef = packConverterRef(converter);
    await prisma.audioRoom.update({
      where: { id: roomId },
      data: {
        playbackUrl: created.playbackUrl,
        bunnyStreamId: created.id,
        agoraConverterId: converterRef,
        stationStartedAt: new Date(),
      },
    });
    return created.playbackUrl;
  } catch (err) {
    logger.warn({ roomId, err: scrub(err) }, 'Live station did not start');
    await bestEffortStop(bunnyStreamId, converterRef);
    return null;
  }
}

/** Stops the push and the Bunny stream for a room that is ending. Never throws. */
export async function closeStation(roomId: string): Promise<void> {
  try {
    const room = await prisma.audioRoom.findUnique({
      where: { id: roomId },
      select: { bunnyStreamId: true, agoraConverterId: true },
    });
    if (!room?.bunnyStreamId && !room?.agoraConverterId) return;
    await bestEffortStop(room.bunnyStreamId, room.agoraConverterId);
  } catch (err) {
    logger.warn({ roomId, err: scrub(err) }, 'Live station teardown failed');
  }
}

async function crowdChannelId(room: { channelId: string | null; type: string }): Promise<string | null> {
  if (room.channelId) return room.channelId;
  if (room.type !== 'PRAYER_WATCH') return null;
  const channel = await prisma.channel.findFirst({
    where: { type: 'GLOBAL_PRAYER_WATCH' },
    select: { id: true },
  });
  return channel?.id ?? null;
}

async function refreshOne(room: {
  id: string;
  title: string;
  channelId: string | null;
  type: string;
  bunnyStreamId: string | null;
  agoraConverterId: string | null;
}): Promise<boolean> {
  const created = await createLiveStream(room.title.slice(0, 120));
  await startLiveStream(created.id);
  const rtmpUrl = created.rtmpUrl;
  const playbackUrl = created.playbackUrl;
  const region = agoraRegionForIngest(created.ingestRegion);
  let converterRef = room.agoraConverterId;
  const existing = splitConverterRef(room.agoraConverterId);
  try {
    if (!existing) throw new Error('missing converter');
    await retargetConverter(existing, rtmpUrl);
  } catch (err) {
    logger.warn({ roomId: room.id, err: scrub(err) }, 'Retarget failed, opening a new converter');
    const fresh = await createConverter({
      channel: room.id,
      rtmpUrl,
      region,
      name: `dgc${room.id}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 64),
    });
    converterRef = packConverterRef(fresh);
    if (existing) await deleteConverter(existing).catch((deleteErr) => {
      logger.warn({ roomId: room.id, err: scrub(deleteErr) }, 'Old Agora converter delete failed');
    });
  }

  const saved = await prisma.audioRoom.updateMany({
    where: { id: room.id, status: 'LIVE', bunnyStreamId: room.bunnyStreamId },
    data: {
      playbackUrl,
      bunnyStreamId: created.id,
      agoraConverterId: converterRef,
      stationStartedAt: new Date(),
    },
  });
  if (saved.count === 0) {
    await stopLiveStream(created.id).catch(() => {});
    return false;
  }
  emitPlaybackToCrowd(room.id, await crowdChannelId(room), playbackUrl);
  if (room.bunnyStreamId) await stopLiveStream(room.bunnyStreamId).catch(() => {});
  return true;
}

/** Rooms whose station has been up for 11 hours get a new Bunny stream. Mic holders stay on Agora. */
export async function refreshDueStations(now = new Date()): Promise<{ checked: number; refreshed: number }> {
  if (!stationConfigured()) return { checked: 0, refreshed: 0 };
  const cutoff = new Date(now.getTime() - STATION_REFRESH_AFTER_MS);
  const rooms = await prisma.audioRoom.findMany({
    where: {
      status: 'LIVE',
      type: { in: ['PRAYER_WATCH', 'CHANNEL_CALL'] },
      bunnyStreamId: { not: null },
      stationStartedAt: { lte: cutoff },
    },
    select: { id: true, title: true, channelId: true, type: true, bunnyStreamId: true, agoraConverterId: true },
    take: 20,
  });
  let refreshed = 0;
  for (const room of rooms) {
    try {
      if (await refreshOne(room)) refreshed += 1;
    } catch (err) {
      logger.warn({ roomId: room.id, err: scrub(err) }, 'Live station refresh failed');
    }
  }
  return { checked: rooms.length, refreshed };
}

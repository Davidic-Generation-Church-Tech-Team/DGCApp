import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '99');
vi.stubEnv('BUNNY_STREAM_API_KEY', 'bunny-test-key');
vi.stubEnv('AGORA_CUSTOMER_KEY', 'customer-key');
vi.stubEnv('AGORA_CUSTOMER_SECRET', 'customer-secret');
vi.stubEnv('AGORA_APP_ID', 'app-id');
vi.stubEnv('AGORA_APP_CERTIFICATE', 'cert');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const canModerateScoped = vi.fn();
const emitToUser = vi.fn();
const emitToAudioRoom = vi.fn();
const emitPlaybackToCrowd = vi.fn();
const joinAudioRoom = vi.fn();
const leaveAudioRoom = vi.fn();
const redis = { get: vi.fn(), set: vi.fn(), del: vi.fn() };

function model() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
    deleteMany: vi.fn(),
  };
}

const prisma = {
  channel: model(),
  audioRoom: model(),
  audioRoomParticipant: model(),
  user: model(),
  branchMembership: model(),
  clusterMembership: model(),
  channelMembership: model(),
  audioRoomReminder: model(),
  $queryRaw: vi.fn(),
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

vi.mock('../src/infra/db', () => ({ prisma }));
vi.mock('../src/infra/redis', () => ({
  redis,
  withDeadline: async (promise: Promise<unknown>, _ms: number, fallback: unknown) => {
    try {
      return await promise;
    } catch {
      return fallback;
    }
  },
}));
vi.mock('../src/infra/queue', () => ({ notificationQueue: { name: 'notification', getJob: vi.fn() } }));
vi.mock('../src/infra/enqueue', () => ({ enqueue: vi.fn(), dropJob: vi.fn() }));
vi.mock('../src/infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/infra/realtime', () => ({
  emitToUser,
  emitToAudioRoom,
  emitPlaybackToCrowd,
  emitToChannel: vi.fn(),
  emitToChannelExcept: vi.fn(),
  emitCallEnded: vi.fn(),
  joinAudioRoom,
  leaveAudioRoom,
  closeAudioRoom: vi.fn(),
}));
vi.mock('../src/modules/push/push.service', () => ({
  pushService: { sendToUsers: vi.fn(), sendToUser: vi.fn(), sendIncomingCallToUser: vi.fn(), sendIncomingCallToUsers: vi.fn() },
}));
vi.mock('../src/modules/notifications/notifications.service', () => ({ notificationService: { notify: vi.fn() } }));
vi.mock('../src/modules/chat/chat.socket', () => ({ readPresence: vi.fn() }));
vi.mock('../src/infra/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  cacheKeys: { userAdminScopes: (id: string) => id },
}));
vi.mock('../src/utils/authorization', () => ({
  canCreateForScope: vi.fn(),
  canModerateScoped,
  isClusterModerator: vi.fn(),
}));
vi.mock('../src/infra/agora', () => ({
  buildRtcToken: vi.fn(() => 'publisher-token'),
  isAgoraConfigured: () => true,
}));

const { prayerWatchService } = await import('../src/modules/prayer-watch/prayer-watch.service');
const { audioRoomService } = await import('../src/modules/audio-rooms/audio-rooms.service');
const { refreshDueStations } = await import('../src/modules/audio-rooms/station');
const { rtmpPublishUrl } = await import('../src/infra/bunnyStream');
const { agoraRegionForIngest } = await import('../src/infra/agoraMediaPush');

const PLAYBACK = 'https://cdn.example/live.m3u8';

function liveRoom(playbackUrl: string | null = PLAYBACK) {
  return {
    id: 'room-1',
    title: 'Global Prayer Watch',
    hostId: 'starter',
    channelId: null,
    branchId: null,
    clusterId: null,
    type: 'PRAYER_WATCH' as const,
    playbackUrl,
    startedAt: new Date(),
    createdAt: new Date(),
  };
}

function roomDetail(playbackUrl: string | null = PLAYBACK) {
  return {
    ...liveRoom(playbackUrl),
    description: null,
    status: 'LIVE' as const,
    scheduledFor: null,
    endedAt: null,
    participants: [],
    reminders: [],
  };
}

function person(userId: string, role: 'HOST' | 'SPEAKER' | 'LISTENER' = 'SPEAKER') {
  return {
    id: `p-${userId}`,
    userId,
    role,
    joinedAt: new Date(),
    user: { id: userId, displayName: userId, avatarUrl: null, globalRole: 'MEMBER' },
  };
}

describe('crowd-call station', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    canModerateScoped.mockResolvedValue(false);
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    prisma.channel.findFirst.mockResolvedValue({ id: 'prayer-channel' });
    prisma.user.findUnique.mockResolvedValue({ id: 'member', displayName: 'Ada', avatarUrl: null, globalRole: 'MEMBER' });
    prisma.audioRoomParticipant.findMany.mockResolvedValue([]);
    prisma.audioRoomParticipant.count.mockResolvedValue(0);
    prisma.branchMembership.findMany.mockResolvedValue([]);
    prisma.clusterMembership.findMany.mockResolvedValue([]);
    prisma.branchMembership.findFirst.mockResolvedValue(null);
    prisma.clusterMembership.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ status: 'LIVE' }]);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  });

  it('joins the ingest url and the stream key once', () => {
    expect(rtmpPublishUrl('rtmp://rtmp.bunnycdn.com/live', 'abc')).toBe('rtmp://rtmp.bunnycdn.com/live/abc');
    expect(rtmpPublishUrl('rtmp://rtmp.bunnycdn.com/live/abc', 'abc')).toBe('rtmp://rtmp.bunnycdn.com/live/abc');
    expect(agoraRegionForIngest('DE')).toBe('eu');
  });

  it('gives a member the station and no Agora token when they opt in', async () => {
    prisma.audioRoom.findFirst.mockResolvedValue(liveRoom());
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);
    prisma.audioRoomParticipant.create.mockResolvedValue(person('member', 'LISTENER'));
    prisma.audioRoom.findUnique.mockResolvedValue(roomDetail());

    const joined = await prayerWatchService.start('member', 'MEMBER', true) as {
      role: string;
      agora: { token: string } | null;
      playbackUrl: string | null;
    };

    expect(joined.role).toBe('LISTENER');
    expect(joined.agora).toBeNull();
    expect(joined.playbackUrl).toBe(PLAYBACK);
    expect(prisma.audioRoomParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'member', role: 'LISTENER' }) }),
    );
    expect(joinAudioRoom).not.toHaveBeenCalled();
    expect(emitToAudioRoom).toHaveBeenCalledWith(
      'room-1',
      'audio-room:listeners',
      expect.objectContaining({ roomId: 'room-1' }),
    );
    expect(emitToAudioRoom).not.toHaveBeenCalledWith('room-1', 'audio-room:user-joined', expect.anything());
  });

  it('gives the starter and an admin an Agora token', async () => {
    canModerateScoped.mockImplementation(async (userId: string) => userId === 'admin');
    prisma.audioRoom.findFirst.mockResolvedValue(liveRoom());
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);
    prisma.audioRoomParticipant.create.mockResolvedValue(person('admin', 'SPEAKER'));
    prisma.audioRoom.findUnique.mockResolvedValue(roomDetail());

    const admin = await prayerWatchService.start('admin', 'MEMBER', true) as { role: string; agora: { token: string } | null };
    expect(admin.role).toBe('SPEAKER');
    expect(admin.agora?.token).toBe('publisher-token');

    prisma.audioRoom.findFirst.mockResolvedValue(null);
    prisma.audioRoom.create.mockResolvedValue({ id: 'room-new', title: 'Global Prayer Watch' });
    prisma.audioRoom.findUnique.mockResolvedValue(roomDetail(null));
    fetchMock.mockRejectedValue(new Error('bunny down'));

    const starter = await prayerWatchService.start('starter', 'MEMBER', true) as {
      role: string;
      agora: { token: string } | null;
      playbackUrl: string | null;
    };
    expect(starter.role).toBe('HOST');
    expect(starter.agora?.token).toBe('publisher-token');
    expect(starter.playbackUrl).toBeNull();
  });

  it('still gives a publisher token when the phone does not opt in', async () => {
    prisma.audioRoom.findFirst.mockResolvedValue(liveRoom());
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);
    prisma.audioRoomParticipant.create.mockResolvedValue(person('member', 'SPEAKER'));
    prisma.audioRoom.findUnique.mockResolvedValue(roomDetail());

    const joined = await prayerWatchService.start('member', 'MEMBER') as { role: string; agora: { token: string } | null };
    expect(joined.role).toBe('SPEAKER');
    expect(joined.agora?.token).toBe('publisher-token');
  });

  it('does not hand an opted-in listener an Agora token when Bunny failed', async () => {
    prisma.audioRoom.findFirst.mockResolvedValue(liveRoom(null));
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);
    prisma.audioRoomParticipant.create.mockResolvedValue(person('member', 'LISTENER'));
    prisma.audioRoom.findUnique.mockResolvedValue(roomDetail(null));

    const joined = await prayerWatchService.start('member', 'MEMBER', true) as { agora: unknown; playbackUrl: string | null };
    expect(joined.agora).toBeNull();
    expect(joined.playbackUrl).toBeNull();
    expect(prisma.audioRoomParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'LISTENER' }) }),
    );
    expect(joinAudioRoom).not.toHaveBeenCalled();
  });

  it('refuses a fourth free mic and frees the slot when one is put down', async () => {
    const holders = ['m1', 'm2', 'm3'].map((id) => person(id));
    prisma.audioRoom.findUnique.mockResolvedValue({
      ...liveRoom(),
      status: 'LIVE',
      isPersistent: true,
    });
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('m4', 'LISTENER'));
    prisma.audioRoomParticipant.findMany.mockResolvedValue(holders);

    await expect(audioRoomService.setMic('m4', 'MEMBER', 'room-1', true)).rejects.toMatchObject({
      message: 'All free mics are in use',
      status: 400,
    });

    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('m1', 'SPEAKER'));
    prisma.audioRoomParticipant.count.mockResolvedValue(5);
    await expect(audioRoomService.setMic('m1', 'MEMBER', 'room-1', false)).resolves.toMatchObject({
      role: 'LISTENER',
      agora: null,
      playbackUrl: PLAYBACK,
    });
    expect(prisma.audioRoomParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-m1' }, data: { role: 'LISTENER' } }),
    );
    expect(leaveAudioRoom).toHaveBeenCalledWith('m1', 'room-1');
    expect(emitToAudioRoom).toHaveBeenCalledWith('room-1', 'audio-room:role-changed', {
      roomId: 'room-1', userId: 'm1', role: 'LISTENER',
    });

    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('m4', 'LISTENER'));
    prisma.audioRoomParticipant.findMany.mockResolvedValue(holders.slice(0, 2));
    const grabbed = await audioRoomService.setMic('m4', 'MEMBER', 'room-1', true);
    expect(grabbed.role).toBe('SPEAKER');
    expect(grabbed.agora?.token).toBe('publisher-token');
  });

  it('does not let a member take a protected mic, and lets the starter take a free one', async () => {
    prisma.audioRoom.findUnique.mockResolvedValue({ ...liveRoom(), status: 'LIVE', id: 'room-1' });
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('starter', 'HOST'));

    await expect(audioRoomService.mute('member', 'MEMBER', 'room-1', 'starter')).rejects.toMatchObject({ status: 403 });
    await expect(audioRoomService.mute('member', 'MEMBER', 'room-1', 'admin')).rejects.toMatchObject({ status: 403 });
    await expect(audioRoomService.mute('member', 'MEMBER', 'room-1', 'super')).rejects.toMatchObject({ status: 403 });

    canModerateScoped.mockImplementation(async (userId: string) => userId === 'starter');
    prisma.user.findUnique.mockResolvedValue({ globalRole: 'MEMBER' });
    prisma.branchMembership.findMany.mockResolvedValue([{ userId: 'admin' }]);
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('admin', 'SPEAKER'));
    await expect(audioRoomService.mute('starter', 'MEMBER', 'room-1', 'admin')).rejects.toMatchObject({
      message: 'You cannot take this mic',
      status: 403,
    });

    prisma.branchMembership.findMany.mockResolvedValue([]);
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('guest', 'SPEAKER'));
    prisma.audioRoomParticipant.count.mockResolvedValue(2);
    await expect(audioRoomService.mute('starter', 'MEMBER', 'room-1', 'guest')).resolves.toMatchObject({ ok: true });
    expect(prisma.audioRoomParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-guest' }, data: { role: 'LISTENER' } }),
    );
    expect(leaveAudioRoom).toHaveBeenCalledWith('guest', 'room-1');
    expect(emitToUser).toHaveBeenCalledWith('guest', 'audio-room:playback', {
      roomId: 'room-1',
      playbackUrl: PLAYBACK,
    });
  });

  it('ends the room and deletes the push when the last person leaves', async () => {
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('starter', 'HOST'));
    prisma.audioRoom.findUnique
      .mockResolvedValueOnce({ isPersistent: true, channelId: null, type: 'PRAYER_WATCH' })
      .mockResolvedValueOnce({ bunnyStreamId: 'stream-1', agoraConverterId: 'eu:conv-1' });
    prisma.$queryRaw
      .mockResolvedValueOnce([{
        hostId: 'starter', channelId: null, branchId: null, clusterId: null, type: 'PRAYER_WATCH', status: 'LIVE',
      }])
      .mockResolvedValueOnce([{ status: 'LIVE', channelId: null, type: 'PRAYER_WATCH' }]);
    prisma.audioRoomParticipant.count.mockResolvedValue(0);
    prisma.audioRoomParticipant.findMany.mockResolvedValue([]);

    await audioRoomService.leave('starter', 'room-1');

    expect(prisma.audioRoom.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ENDED' }) }),
    );
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/rtmp-converters/conv-1'))).toBe(true);
    expect(urls.some((url) => url.includes('/live/stream-1/stop'))).toBe(true);
    const methods = fetchMock.mock.calls.map((call) => (call[1] as { method?: string }).method);
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PUT');
  });

  it('requires a join before the mic, then unmute seats the member with the speakers', async () => {
    prisma.audioRoom.findUnique.mockResolvedValue({ ...liveRoom(), status: 'LIVE' });
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);

    await expect(audioRoomService.setMic('member', 'MEMBER', 'room-1', true)).rejects.toMatchObject({
      message: 'Join the call before using the mic',
      status: 400,
    });

    prisma.audioRoomParticipant.findFirst.mockResolvedValue(person('member', 'LISTENER'));
    const grabbed = await audioRoomService.setMic('member', 'MEMBER', 'room-1', true);
    expect(grabbed.role).toBe('SPEAKER');
    expect(grabbed.agora?.token).toBe('publisher-token');
    expect(prisma.audioRoomParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-member' }, data: { role: 'SPEAKER' } }),
    );
    expect(joinAudioRoom).toHaveBeenCalledWith('member', 'room-1');
    expect(emitToAudioRoom).toHaveBeenCalledWith(
      'room-1',
      'audio-room:user-joined',
      expect.objectContaining({ userId: 'member', role: 'SPEAKER' }),
    );
  });

  it('tells the channel when the station link is replaced and skips the mic holders', async () => {
    const body = {
      guid: 'stream-new',
      streamKey: 'key-new',
      playbackUrlHls: 'https://cdn.example/new.m3u8',
      primaryIngestUrl: 'rtmp://rtmp.bunnycdn.com/live',
      ingestRegion: 'DE',
    };
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes('/live') && init?.method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      return { ok: true, status: 200, text: async () => '' };
    });
    prisma.audioRoom.findMany.mockResolvedValue([{
      id: 'room-1',
      title: 'Global Prayer Watch',
      channelId: null,
      type: 'PRAYER_WATCH',
      bunnyStreamId: 'stream-old',
      agoraConverterId: 'eu:conv-old',
      stationStartedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
    }]);

    const result = await refreshDueStations(new Date());
    expect(result.refreshed).toBe(1);
    expect(emitPlaybackToCrowd).toHaveBeenCalledWith('room-1', 'prayer-channel', 'https://cdn.example/new.m3u8');
    expect(emitToAudioRoom).not.toHaveBeenCalled();
  });
});

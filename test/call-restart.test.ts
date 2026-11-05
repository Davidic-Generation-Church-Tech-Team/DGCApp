import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequest } from '../src/utils/errors';

const enqueue = vi.fn();
const dropJob = vi.fn();
const sendIncomingCallToUser = vi.fn();
const redis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};
const prisma = {
  channel: { findUnique: vi.fn(), findFirst: vi.fn() },
  audioRoom: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  audioRoomParticipant: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  call: { findUnique: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
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
vi.mock('../src/infra/enqueue', () => ({ enqueue, dropJob }));
vi.mock('../src/infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/infra/realtime', () => ({
  emitToUser: vi.fn(),
  emitToAudioRoom: vi.fn(),
  emitToChannel: vi.fn(),
  emitToChannelExcept: vi.fn(),
  emitCallEnded: vi.fn(),
  joinAudioRoom: vi.fn(),
  leaveAudioRoom: vi.fn(),
  closeAudioRoom: vi.fn(),
}));
vi.mock('../src/modules/push/push.service', () => ({
  pushService: { sendIncomingCallToUser, sendIncomingCallToUsers: vi.fn(), sendToUsers: vi.fn(), sendToUser: vi.fn() },
}));
vi.mock('../src/modules/notifications/notifications.service', () => ({ notificationService: { notify: vi.fn() } }));
vi.mock('../src/modules/chat/chat.socket', () => ({ readPresence: vi.fn() }));
vi.mock('../src/infra/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  cacheKeys: { userAdminScopes: (id: string) => id },
}));
vi.mock('../src/utils/authorization', () => ({
  canCreateForScope: vi.fn(),
  canModerateScoped: vi.fn(),
  isClusterModerator: vi.fn(),
}));
vi.mock('../src/infra/agora', () => ({ buildRtcToken: vi.fn(), isAgoraConfigured: () => false }));

const { audioRoomService } = await import('../src/modules/audio-rooms/audio-rooms.service');
const { prayerWatchService } = await import('../src/modules/prayer-watch/prayer-watch.service');
const { callService } = await import('../src/modules/calls/calls.service');

function channelRow() {
  return {
    id: 'ch-1',
    type: 'CLUSTER',
    name: 'Youth',
    isReadOnly: false,
    branchId: null,
    clusterId: 'cl-1',
    branch: null,
    cluster: { name: 'Youth' },
    memberships: [{ role: 'MEMBER' }],
  };
}

function ringingCall() {
  return {
    id: 'call-1',
    channelId: 'dm-1',
    callerId: 'caller',
    calleeId: 'callee',
    type: 'AUDIO' as const,
    status: 'RINGING' as const,
    agoraChannel: 'dgc_call_x',
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
    answeredAt: null,
    endedAt: null,
    endedById: null,
    durationMs: null,
    caller: { id: 'caller', displayName: 'Emeka', avatarUrl: null },
    callee: { id: 'callee', displayName: 'Ada', avatarUrl: null },
  };
}

describe('an ended call is not started again', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    prisma.channel.findUnique.mockResolvedValue(channelRow());
    prisma.channel.findFirst.mockResolvedValue({ id: 'prayer-channel' });
    prisma.audioRoom.findFirst.mockResolvedValue(null);
    prisma.audioRoomParticipant.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', displayName: 'Emeka', avatarUrl: null });
    prisma.audioRoom.create.mockReset();
    prisma.call.findUnique.mockReset();
    prisma.call.updateMany.mockReset();
    prisma.$transaction.mockRejectedValue(BadRequest('Room is not live'));
  });

  it('does not open a new channel call when the one being joined has ended', async () => {
    prisma.audioRoom.findFirst.mockResolvedValue({
      id: 'room-1',
      title: 'Youth Call',
      channelId: 'ch-1',
      hostId: 'host-1',
      startedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(audioRoomService.startChannelCall('user-1', 'MEMBER', 'ch-1')).rejects.toMatchObject({
      message: 'This call has ended',
      status: 400,
    });
    expect(prisma.audioRoom.create).not.toHaveBeenCalled();
  });

  it('does not open a new channel call while the last ring is still in its window', async () => {
    redis.get.mockResolvedValue('room-old');

    await expect(audioRoomService.startChannelCall('user-1', 'MEMBER', 'ch-1')).rejects.toMatchObject({
      message: 'This call has ended',
    });
    expect(prisma.audioRoom.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('still creates a channel call when nothing is live and nothing just ended', async () => {
    prisma.audioRoom.create.mockRejectedValue(new Error('created-on-purpose'));

    await expect(audioRoomService.startChannelCall('user-1', 'MEMBER', 'ch-1')).rejects.toThrow('created-on-purpose');
    expect(prisma.audioRoom.create).toHaveBeenCalledTimes(1);
  });

  it('joins a raced live room once and does not create a second call when that room has ended', async () => {
    prisma.audioRoom.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'room-raced',
        title: 'Youth Call',
        channelId: 'ch-1',
        hostId: 'other',
        startedAt: new Date(),
        createdAt: new Date(),
      });
    prisma.audioRoom.create.mockRejectedValue({ code: 'P2002' });

    await expect(audioRoomService.startChannelCall('user-1', 'MEMBER', 'ch-1')).rejects.toMatchObject({
      message: 'This call has ended',
    });
    expect(prisma.audioRoom.create).toHaveBeenCalledTimes(1);
  });

  it('does not open a new Prayer Watch while the last one is still in its ring window', async () => {
    redis.get.mockResolvedValue('room-old');

    await expect(prayerWatchService.start('user-1', 'MEMBER')).rejects.toMatchObject({
      message: 'This call has ended',
    });
    expect(prisma.audioRoom.create).not.toHaveBeenCalled();
  });

  it('drops the direct-call push when the caller cancels', async () => {
    const call = ringingCall();
    prisma.call.findUnique
      .mockResolvedValueOnce(call)
      .mockResolvedValueOnce({ ...call, status: 'CANCELLED' });
    prisma.call.updateMany.mockResolvedValue({ count: 1 });

    await callService.end('caller', 'call-1');

    expect(dropJob).toHaveBeenCalledWith(expect.anything(), 'call-incoming-call-1');
  });

  it('does not push a direct call that was cancelled while the push was being built', async () => {
    prisma.call.findUnique
      .mockResolvedValueOnce(ringingCall())
      .mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect(callService.sendIncomingPush('call-1')).resolves.toEqual({ ok: false, skipped: true });
    expect(sendIncomingCallToUser).not.toHaveBeenCalled();
  });
});

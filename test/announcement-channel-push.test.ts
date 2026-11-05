import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireMember = vi.fn();
const enqueue = vi.fn();
const prisma = {
  channel: { findUnique: vi.fn() },
  message: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
};

vi.mock('../src/infra/db', () => ({ prisma }));
vi.mock('../src/infra/queue', () => ({ notificationQueue: { name: 'notification' } }));
vi.mock('../src/infra/enqueue', () => ({ enqueue }));
vi.mock('../src/infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/infra/realtime', () => ({ emitToChannel: vi.fn() }));
vi.mock('../src/modules/channels/channels.service', () => ({ channelService: { requireMember } }));
vi.mock('../src/modules/moderation/moderation.service', () => ({ moderationService: {} }));

const { chatService } = await import('../src/modules/chat/chat.service');

const photo = 'https://res.cloudinary.com/ph82hmab/image/upload/v1782625723/dgc/flyer.png';
const jpeg = 'https://res.cloudinary.com/ph82hmab/image/upload/f_jpg,q_auto,w_720,c_limit/v1782625723/dgc/flyer.jpg';

function savedMessage(data: {
  id: string;
  channelId: string;
  senderId: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  title?: string | null;
}) {
  return {
    ...data,
    title: data.title ?? null,
    clientMessageId: null,
    replyToId: null,
    forwardedFromId: null,
    pinnedById: null,
    pinnedAt: null,
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
    editedAt: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    poll: null,
    replyTo: null,
    reactions: [],
    sender: { id: data.senderId, displayName: 'Emeka', avatarUrl: 'https://cdn.example/emeka.jpg' },
  };
}

describe('announcement channel push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireMember.mockResolvedValue({ role: 'ADMIN' });
    prisma.message.create.mockImplementation(async ({ data }: { data: Parameters<typeof savedMessage>[0] }) =>
      savedMessage(data),
    );
  });

  it('sends the announcement title, the opening of the text, and a JPEG instead of a chat alert', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      isReadOnly: true,
      type: 'GLOBAL_ANNOUNCEMENT',
      name: 'DGC Global Announcement',
    });

    const shown = await chatService.send('admin-1', 'SUPER_ADMIN', 'channel-1', {
      type: 'IMAGE',
      body: 'Join us on Sunday for the special service.',
      mediaUrl: photo,
    });

    expect(shown.sender.displayName).toBe('Admin');
    expect(shown.mediaUrl).toContain('f_auto,q_auto,c_limit,w_1600');
    expect(shown.thumbUrl).toContain('w_400');
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      'announcement-fanout',
      expect.objectContaining({
        channelId: 'channel-1',
        excludeUserId: 'admin-1',
        title: 'Join us on Sunday for the special service.',
        body: 'Join us on Sunday for the special service.',
        imageUrl: jpeg,
      }),
    );
    expect(enqueue.mock.calls.some((call) => call[1] === 'message-fanout')).toBe(false);
  });

  it('names a titled announcement and still attaches the picture', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      isReadOnly: true,
      type: 'BRANCH_SECTION',
      name: 'Service Updates',
    });
    prisma.message.create.mockImplementation(async ({ data }: { data: Parameters<typeof savedMessage>[0] }) =>
      savedMessage({ ...data, title: 'Sunday service' }),
    );

    await chatService.send('admin-1', 'SUPER_ADMIN', 'channel-2', {
      type: 'IMAGE',
      body: 'Come expecting.',
      mediaUrl: photo,
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      'announcement-fanout',
      expect.objectContaining({
        title: 'Sunday service',
        body: 'Sunday service. Come expecting.',
        imageUrl: jpeg,
      }),
    );
  });

  it('sends the title and the opening of the text when there is no photo', async () => {
    prisma.channel.findUnique.mockResolvedValue({
      isReadOnly: true,
      type: 'GLOBAL_ANNOUNCEMENT',
      name: 'DGC Global Announcement',
    });
    const body = `${'We thank God for His faithfulness this week. '.repeat(8)}See you on Sunday.`;

    await chatService.send('admin-1', 'SUPER_ADMIN', 'channel-1', { type: 'TEXT', body });

    const job = enqueue.mock.calls.find((call) => call[1] === 'announcement-fanout')?.[2] as {
      title: string;
      body: string;
      imageUrl: string | null;
    };
    expect(job.imageUrl).toBeNull();
    expect(job.title.endsWith('…')).toBe(true);
    expect(job.body.startsWith(job.title.slice(0, 40))).toBe(true);
    expect(job.body.length).toBeGreaterThan(job.title.length);
  });

  it('leaves an ordinary group chat on the normal message push', async () => {
    prisma.channel.findUnique.mockResolvedValue({ isReadOnly: false, type: 'CLUSTER', name: 'Youth' });

    const shown = await chatService.send('user-1', 'MEMBER', 'channel-3', {
      type: 'TEXT',
      body: 'See you at rehearsal.',
    });

    expect(shown.sender.displayName).toBe('Emeka');
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      'message-fanout',
      expect.objectContaining({ senderName: 'Emeka', body: 'See you at rehearsal.' }),
    );
    expect(enqueue.mock.calls.some((call) => call[1] === 'announcement-fanout')).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn();
const prisma = {
  event: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  eventRSVP: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  branch: { findUnique: vi.fn() },
  cluster: { findUnique: vi.fn() },
  branchMembership: { findMany: vi.fn(), findUnique: vi.fn() },
  clusterMembership: { findMany: vi.fn(), findUnique: vi.fn() },
  notification: { createMany: vi.fn() },
};
const sendToUsers = vi.fn();

vi.mock('../src/infra/db', () => ({ prisma }));
vi.mock('../src/infra/queue', () => ({ notificationQueue: { name: 'notification' } }));
vi.mock('../src/infra/enqueue', () => ({ enqueue }));
vi.mock('../src/modules/push/push.service', () => ({ pushService: { sendToUsers } }));

const { eventService } = await import('../src/modules/events/events.service');

const startsAt = new Date('2026-11-08T09:00:00.000Z');
const photo = 'https://res.cloudinary.com/ph82hmab/image/upload/v1782625723/dgc/flyer.png';
const jpeg = 'https://res.cloudinary.com/ph82hmab/image/upload/f_jpg,q_auto,w_720,c_limit/v1782625723/dgc/flyer.jpg';

function pageOf(all: string[], where: { id?: { gt?: string } } | undefined, take: number) {
  const cursor = where?.id?.gt;
  const start = cursor ? all.indexOf(cursor) + 1 : 0;
  return all.slice(start, start + take).map((id) => ({ id, userId: id }));
}

describe('event reminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.event.updateMany.mockResolvedValue({ count: 1 });
    prisma.notification.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    sendToUsers.mockResolvedValue(undefined);
  });

  it('hides the admin and labels the event as posted by Admin', async () => {
    prisma.event.findUnique.mockResolvedValue({
      id: 'event-1',
      branchId: null,
      clusterId: null,
      startsAt,
      createdById: 'admin-user',
      title: 'Sunday Service',
    });
    prisma.event.update.mockResolvedValue({
      id: 'event-1',
      title: 'Sunday Service',
      createdById: 'admin-user',
      startsAt,
      branchId: null,
      clusterId: null,
    });

    const updated = await eventService.update('admin-user', 'SUPER_ADMIN', 'event-1', {
      startsAt: new Date('2026-11-09T09:00:00.000Z'),
    });

    expect(updated).not.toHaveProperty('createdById');
    expect(updated).toMatchObject({ postedBy: 'Admin', title: 'Sunday Service' });
    expect(prisma.event.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reminderSentAt: null }),
    }));
  });

  it('does not schedule another reminder when the start time stays the same', async () => {
    prisma.event.findUnique.mockResolvedValue({
      id: 'event-1',
      branchId: 'branch-1',
      clusterId: null,
      startsAt,
    });
    prisma.branchMembership.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.event.update.mockResolvedValue({
      id: 'event-1',
      title: 'Sunday Service',
      createdById: 'admin-user',
      startsAt,
    });

    await eventService.update('admin-user', 'MEMBER', 'event-1', { title: 'Sunday celebration' });
    const data = prisma.event.update.mock.calls[0]?.[0].data;
    expect(data.reminderSentAt).toBeUndefined();
  });

  it('reminds only people who RSVP\'d Going or Interested', async () => {
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-1', title: 'Workers meeting', imageUrl: photo, startsAt },
    ]);
    prisma.eventRSVP.findMany.mockResolvedValue([
      { id: 'r1', userId: 'user-1' },
      { id: 'r2', userId: 'user-2' },
    ]);

    const result = await eventService.sendDueEventReminders();
    expect(result.notified).toBe(2);
    expect(prisma.eventRSVP.findMany.mock.calls[0]?.[0].where).toEqual({
      eventId: 'event-1',
      status: { in: ['GOING', 'INTERESTED'] },
      user: { deletedAt: null, suspendedAt: null },
    });
    expect(prisma.branchMembership.findMany).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(sendToUsers).toHaveBeenCalledWith(
      ['user-1', 'user-2'],
      expect.objectContaining({
        title: 'Workers meeting',
        body: 'Workers meeting is happening on Sunday 8 November at 10:00 am.',
        imageUrl: jpeg,
        data: expect.objectContaining({ eventTitle: 'Workers meeting', eventId: 'event-1', imageUrl: jpeg }),
      }),
    );
  });

  it('does not remind the whole branch or cluster when nobody has RSVP\'d', async () => {
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-2', title: 'Prayer warriors', imageUrl: null, startsAt, branchId: 'branch-1', clusterId: null },
    ]);
    prisma.eventRSVP.findMany.mockResolvedValue([]);

    const result = await eventService.sendDueEventReminders();
    expect(result.notified).toBe(0);
    expect(prisma.branchMembership.findMany).not.toHaveBeenCalled();
    expect(prisma.clusterMembership.findMany).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(sendToUsers).not.toHaveBeenCalled();
  });

  it('pages a reminder of 10,000 RSVPs in groups of 1,000', async () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(5, '0'));
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-all', title: 'Church conference', imageUrl: null, startsAt },
    ]);
    prisma.eventRSVP.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt?: string } }; take: number }) =>
      pageOf(ids, where, take),
    );

    const started = Date.now();
    const result = await eventService.sendDueEventReminders();
    const elapsed = Date.now() - started;

    expect(result).toEqual({ events: 1, notified: 10_000 });
    expect(sendToUsers).toHaveBeenCalledTimes(10);
    for (const call of sendToUsers.mock.calls) {
      expect(call[0]).toHaveLength(1000);
    }
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(10);
    const firstWhere = prisma.eventRSVP.findMany.mock.calls[0]?.[0].where;
    expect(firstWhere.status).toEqual({ in: ['GOING', 'INTERESTED'] });
    expect(firstWhere.eventId).toBe('event-all');
    expect(elapsed).toBeLessThan(2000);
  });

  it('pushes a new event like an announcement, with the title, the opening, and a JPEG', async () => {
    prisma.event.create.mockResolvedValue({
      id: 'event-1',
      title: 'Sunday Service',
      description: 'Join us at 8am. Come expecting.',
      imageUrl: photo,
      location: 'DGC Ibadan',
      startsAt,
      endsAt: null,
      branchId: null,
      clusterId: null,
      createdById: 'admin-1',
      createdAt: startsAt,
      branch: null,
      cluster: null,
      _count: { rsvps: 0 },
    });

    const created = await eventService.create('admin-1', 'SUPER_ADMIN', {
      title: 'Sunday Service',
      description: 'Join us at 8am. Come expecting.',
      imageUrl: photo,
      startsAt,
    });

    expect(created).toMatchObject({ postedBy: 'Admin', imageUrl: photo });
    expect(created).not.toHaveProperty('createdById');
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      'event-created',
      expect.objectContaining({
        eventId: 'event-1',
        title: 'Sunday Service',
        body: 'Sunday Service. Join us at 8am. Come expecting.',
        imageUrl: jpeg,
        excludeUserId: 'admin-1',
        branchId: null,
        clusterId: null,
      }),
      { jobId: 'event-created-event-1' },
    );
  });

  it('pushes a new event with the title and the opening when there is no photo', async () => {
    const description = 'We thank God for this gathering and we invite every worker to come ready to serve and to stay through the evening session with joy and expectation.';
    prisma.event.create.mockResolvedValue({
      id: 'event-2',
      title: 'Workers meeting',
      description,
      imageUrl: null,
      location: null,
      startsAt,
      endsAt: null,
      branchId: 'branch-1',
      clusterId: null,
      createdById: 'admin-1',
      createdAt: startsAt,
      branch: { id: 'branch-1', name: 'Ibadan' },
      cluster: null,
      _count: { rsvps: 0 },
    });
    prisma.branch.findUnique.mockResolvedValue({ id: 'branch-1' });

    await eventService.create('admin-1', 'SUPER_ADMIN', {
      title: 'Workers meeting',
      description,
      startsAt,
      branchId: 'branch-1',
    });

    const payload = enqueue.mock.calls[0]?.[2];
    expect(payload.imageUrl).toBeNull();
    expect(payload.body.startsWith('Workers meeting. We thank God')).toBe(true);
    expect(payload.body.endsWith('…')).toBe(true);
    expect(payload.branchId).toBe('branch-1');
  });

  it('sends the create push to the whole church, a page at a time, and leaves the poster out', async () => {
    const ids = ['admin-1', ...Array.from({ length: 1001 }, (_, i) => `user-${i}`)];
    prisma.user.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt?: string; not?: string } }; take: number }) => {
      const eligible = ids.filter((id) => id !== where.id?.not);
      const cursor = where.id?.gt;
      const start = cursor ? eligible.indexOf(cursor) + 1 : 0;
      return eligible.slice(start, start + take).map((id) => ({ id }));
    });

    const result = await eventService.notifyEventCreated({
      eventId: 'event-1',
      title: 'Sunday Service',
      body: 'Sunday Service. Join us at 8am.',
      imageUrl: jpeg,
      startsAt: startsAt.toISOString(),
      branchId: null,
      clusterId: null,
      excludeUserId: 'admin-1',
    });

    expect(result.notified).toBe(1001);
    expect(sendToUsers).toHaveBeenCalledTimes(2);
    const sent = sendToUsers.mock.calls.flatMap((call) => call[0] as string[]);
    expect(sent).not.toContain('admin-1');
    expect(sent).toHaveLength(1001);
    expect(sendToUsers.mock.calls[0]?.[1]).toMatchObject({
      title: 'Sunday Service',
      body: 'Sunday Service. Join us at 8am.',
      imageUrl: jpeg,
    });
  });

  it('resumes a create push after the last finished page and does not send that page again', async () => {
    const ids = ['admin-1', ...Array.from({ length: 1001 }, (_, i) => `user-${i}`)];
    prisma.user.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt?: string; not?: string } }; take: number }) => {
      const eligible = ids.filter((id) => id !== where.id?.not);
      const cursor = where.id?.gt;
      const start = cursor ? eligible.indexOf(cursor) + 1 : 0;
      return eligible.slice(start, start + take).map((id) => ({ id }));
    });
    const input = {
      eventId: 'event-1',
      title: 'Sunday Service',
      body: 'Sunday Service. Join us at 8am.',
      imageUrl: jpeg,
      startsAt: startsAt.toISOString(),
      branchId: null,
      clusterId: null,
      excludeUserId: 'admin-1',
    };
    const finished: string[] = [];

    const first = await eventService.notifyEventCreated(input, async (cursor) => {
      finished.push(cursor);
    });

    expect(first.notified).toBe(1001);
    expect(finished).toHaveLength(2);
    const alreadySent = sendToUsers.mock.calls[0]?.[0] as string[];
    expect(alreadySent).toHaveLength(1000);

    sendToUsers.mockClear();
    const again = await eventService.notifyEventCreated({ ...input, cursor: finished[0] });

    expect(again.notified).toBe(1);
    const resent = sendToUsers.mock.calls.flatMap((call) => call[0] as string[]);
    expect(resent).toEqual(['user-1000']);
    expect(resent.some((id) => alreadySent.includes(id))).toBe(false);
  });

  it('leaves the page cursor where it was when the push fails', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
    sendToUsers.mockRejectedValueOnce(new Error('push down'));
    const onPage = vi.fn();

    await expect(
      eventService.notifyEventCreated(
        {
          eventId: 'event-1',
          title: 'Sunday Service',
          body: 'Sunday Service',
          startsAt: startsAt.toISOString(),
        },
        onPage,
      ),
    ).rejects.toThrow('push down');
    expect(onPage).not.toHaveBeenCalled();
  });

  it('deletes an event by its own id, even with spaces around the paste', async () => {
    prisma.event.findUnique.mockResolvedValue({ branchId: null, clusterId: null });
    prisma.event.delete.mockResolvedValue({});

    await expect(eventService.remove('admin-1', 'SUPER_ADMIN', ' event-1 ')).resolves.toEqual({ ok: true });

    expect(prisma.event.delete).toHaveBeenCalledWith({ where: { id: 'event-1' } });
  });

  it('does not treat a branch id as the event id', async () => {
    prisma.event.findUnique.mockResolvedValue(null);
    prisma.event.findFirst.mockResolvedValue({ id: 'event-1' });

    await expect(eventService.remove('admin-1', 'SUPER_ADMIN', 'branch-1')).rejects.toThrow(
      'Use the event id, not the branch or cluster id.',
    );
    expect(prisma.event.delete).not.toHaveBeenCalled();
  });
});

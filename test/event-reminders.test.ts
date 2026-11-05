import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  event: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  user: { findMany: vi.fn() },
  branchMembership: { findMany: vi.fn(), findUnique: vi.fn() },
  clusterMembership: { findMany: vi.fn(), findUnique: vi.fn() },
  notification: { createMany: vi.fn() },
};
const sendToUsers = vi.fn();

vi.mock('../src/infra/db', () => ({ prisma }));
vi.mock('../src/modules/push/push.service', () => ({ pushService: { sendToUsers } }));

const { eventService } = await import('../src/modules/events/events.service');

const startsAt = new Date('2026-11-08T09:00:00.000Z');

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

  it('reminds a branch, and leaves out people who said they are not coming', async () => {
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-1', title: 'Workers meeting', startsAt, branchId: 'branch-1', clusterId: null },
    ]);
    prisma.branchMembership.findMany.mockResolvedValue([
      { id: 'm1', userId: 'user-1' },
      { id: 'm2', userId: 'user-2' },
    ]);

    const result = await eventService.sendDueEventReminders();
    expect(result.notified).toBe(2);
    const where = prisma.branchMembership.findMany.mock.calls[0]?.[0].where;
    expect(where.branchId).toBe('branch-1');
    expect(where.user.eventRsvps).toEqual({ none: { eventId: 'event-1', status: 'NOT_GOING' } });
    expect(where.user.deletedAt).toBeNull();
    expect(sendToUsers).toHaveBeenCalledWith(
      ['user-1', 'user-2'],
      expect.objectContaining({
        title: 'Workers meeting',
        body: 'Workers meeting is happening on Sunday 8 November at 10:00 am.',
        data: expect.objectContaining({ eventTitle: 'Workers meeting', eventId: 'event-1' }),
      }),
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('reminds a cluster from its membership, not the whole church', async () => {
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-2', title: 'Prayer warriors', startsAt, branchId: null, clusterId: 'cluster-1' },
    ]);
    prisma.clusterMembership.findMany.mockResolvedValue([{ id: 'c1', userId: 'user-9' }]);

    await eventService.sendDueEventReminders();
    expect(prisma.clusterMembership.findMany.mock.calls[0]?.[0].where.clusterId).toBe('cluster-1');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(sendToUsers).toHaveBeenCalledWith(['user-9'], expect.anything());
  });

  it('pages a church-wide reminder of 10,000 people in groups of 1,000', async () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(5, '0'));
    prisma.event.findMany.mockResolvedValue([
      { id: 'event-all', title: 'Church conference', startsAt, branchId: null, clusterId: null },
    ]);
    prisma.user.findMany.mockImplementation(async ({ where, take }: { where: { id?: { gt?: string } }; take: number }) =>
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
    const firstWhere = prisma.user.findMany.mock.calls[0]?.[0].where;
    expect(firstWhere.eventRsvps).toEqual({ none: { eventId: 'event-all', status: 'NOT_GOING' } });
    expect(elapsed).toBeLessThan(2000);
  });
});

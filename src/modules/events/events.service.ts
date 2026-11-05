import { prisma } from '../../infra/db';
import { NotFound, Forbidden, BadRequest } from '../../utils/errors';
import { pushService } from '../push/push.service';
import type { CreateEventInput, UpdateEventInput } from './events.schema';

const EVENT_SELECT = {
  id: true,
  title: true,
  description: true,
  location: true,
  startsAt: true,
  endsAt: true,
  branchId: true,
  clusterId: true,
  createdById: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
  cluster: { select: { id: true, name: true } },
  _count: { select: { rsvps: true } },
};

const REMINDER_BATCH = 1000;

function forMembers<T extends { createdById: string }>(event: T) {
  const { createdById: _createdById, ...rest } = event;
  return { ...rest, postedBy: 'Admin' as const };
}

function eventPushData(eventId: string, title: string, startsAt: Date) {
  return {
    type: 'event',
    notificationType: 'EVENT',
    route: 'EVENT',
    screen: 'EVENT_DETAIL',
    clickAction: 'OPEN_EVENT',
    androidChannelId: 'events',
    eventId,
    eventTitle: title,
    startsAt: startsAt.toISOString(),
    deepLink: `dgc://events/${eventId}`,
  };
}

function eventReminderCopy(title: string, startsAt: Date) {
  const name = title.trim() || 'An event';
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).format(startsAt);
  return {
    title: name,
    body: `${name} is happening on ${day} at ${time}.`,
  };
}

// Church-wide events reach every active member. A branch or cluster event reaches that
// group. Someone who already said they are not coming is left out.
async function reminderPage(
  event: { id: string; branchId: string | null; clusterId: string | null },
  cursor?: string,
) {
  const activeUser = {
    deletedAt: null,
    suspendedAt: null,
    eventRsvps: { none: { eventId: event.id, status: 'NOT_GOING' as const } },
  };
  if (event.branchId) {
    const rows = await prisma.branchMembership.findMany({
      where: { branchId: event.branchId, ...(cursor ? { id: { gt: cursor } } : {}), user: activeUser },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH,
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({ cursor: row.id, userId: row.userId }));
  }
  if (event.clusterId) {
    const rows = await prisma.clusterMembership.findMany({
      where: { clusterId: event.clusterId, ...(cursor ? { id: { gt: cursor } } : {}), user: activeUser },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH,
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({ cursor: row.id, userId: row.userId }));
  }
  const rows = await prisma.user.findMany({
    where: { ...activeUser, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: REMINDER_BATCH,
    select: { id: true },
  });
  return rows.map((row) => ({ cursor: row.id, userId: row.id }));
}

// Who may create / edit / delete an event of a given scope:
// branch event → branch ADMIN; cluster event → cluster MODERATOR; global → SUPER_ADMIN.
async function assertCanManage(userId: string, role: string, branchId?: string | null, clusterId?: string | null) {
  if (role === 'SUPER_ADMIN') return;
  if (branchId) {
    const m = await prisma.branchMembership.findUnique({ where: { userId_branchId: { userId, branchId } } });
    if (m?.role === 'ADMIN') return;
    throw Forbidden('Only branch admins can manage branch events');
  }
  if (clusterId) {
    const m = await prisma.clusterMembership.findUnique({ where: { userId_clusterId: { userId, clusterId } } });
    if (m?.role === 'MODERATOR') return;
    throw Forbidden('Only cluster moderators can manage cluster events');
  }
  throw Forbidden('Only super admins can manage global events');
}

// Who may RSVP / check in: anyone for a global event, otherwise a member of the event's branch or
// cluster (super admins bypass).
async function assertCanAttend(userId: string, role: string, event: { branchId: string | null; clusterId: string | null }) {
  if (role === 'SUPER_ADMIN') return;
  if (!event.branchId && !event.clusterId) return; // global — open to everyone
  if (event.branchId) {
    const m = await prisma.branchMembership.findUnique({ where: { userId_branchId: { userId, branchId: event.branchId } } });
    if (m) return;
  }
  if (event.clusterId) {
    const m = await prisma.clusterMembership.findUnique({ where: { userId_clusterId: { userId, clusterId: event.clusterId } } });
    if (m) return;
  }
  throw Forbidden('This event is only for its branch or cluster members');
}

export const eventService = {
  // Upcoming events relevant to the user: global + their branches + their clusters.
  async listUpcoming(userId: string) {
    const [branches, clusters] = await Promise.all([
      prisma.branchMembership.findMany({ where: { userId }, select: { branchId: true } }),
      prisma.clusterMembership.findMany({ where: { userId }, select: { clusterId: true } }),
    ]);
    const branchIds = branches.map((b) => b.branchId);
    const clusterIds = clusters.map((c) => c.clusterId);

    const events = await prisma.event.findMany({
      where: {
        startsAt: { gte: new Date() },
        OR: [
          { branchId: null, clusterId: null },
          ...(branchIds.length ? [{ branchId: { in: branchIds } }] : []),
          ...(clusterIds.length ? [{ clusterId: { in: clusterIds } }] : []),
        ],
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
      select: EVENT_SELECT,
    });

    const mine = await prisma.eventRSVP.findMany({
      where: { userId, eventId: { in: events.map((e) => e.id) } },
      select: { eventId: true, status: true },
    });
    const map = new Map(mine.map((r) => [r.eventId, r.status]));
    return events.map((e) => ({ ...forMembers(e), myRsvp: map.get(e.id) ?? null }));
  },

  async get(userId: string, eventId: string) {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: EVENT_SELECT });
    if (!event) throw NotFound('Event not found');

    const grouped = await prisma.eventRSVP.groupBy({ by: ['status'], where: { eventId }, _count: true });
    const rsvpCounts: Record<'GOING' | 'INTERESTED' | 'NOT_GOING', number> = { GOING: 0, INTERESTED: 0, NOT_GOING: 0 };
    for (const g of grouped) rsvpCounts[g.status] = g._count;

    const mine = await prisma.eventRSVP.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { status: true, checkedInAt: true },
    });
    return { ...forMembers(event), rsvpCounts, myRsvp: mine?.status ?? null, checkedInAt: mine?.checkedInAt ?? null };
  },

  async create(userId: string, role: string, dto: CreateEventInput) {
    if (dto.branchId && dto.clusterId) throw BadRequest('An event targets a branch OR a cluster, not both');
    if (dto.branchId) {
      const b = await prisma.branch.findUnique({ where: { id: dto.branchId }, select: { id: true } });
      if (!b) throw BadRequest('Branch not found');
    }
    if (dto.clusterId) {
      const c = await prisma.cluster.findUnique({ where: { id: dto.clusterId }, select: { id: true } });
      if (!c) throw BadRequest('Cluster not found');
    }
    await assertCanManage(userId, role, dto.branchId, dto.clusterId);

    const created = await prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        location: dto.location ?? null,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt ?? null,
        branchId: dto.branchId ?? null,
        clusterId: dto.clusterId ?? null,
        createdById: userId,
      },
      select: EVENT_SELECT,
    });
    return forMembers(created);
  },

  // Edit an event's details (scope stays fixed). Same authority as creating it.
  async update(userId: string, role: string, eventId: string, dto: UpdateEventInput) {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, branchId: true, clusterId: true, startsAt: true },
    });
    if (!event) throw NotFound('Event not found');
    await assertCanManage(userId, role, event.branchId, event.clusterId);
    const startsAtMoved = dto.startsAt != null && dto.startsAt.getTime() !== event.startsAt.getTime();
    const updated = await prisma.event.update({
      where: { id: eventId },
      data: { ...dto, ...(startsAtMoved ? { reminderSentAt: null } : {}) },
      select: EVENT_SELECT,
    });
    return forMembers(updated);
  },

  // Delete/cancel an event. RSVPs cascade away with it.
  async remove(userId: string, role: string, eventId: string) {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { branchId: true, clusterId: true },
    });
    if (!event) throw NotFound('Event not found');
    await assertCanManage(userId, role, event.branchId, event.clusterId);
    await prisma.event.delete({ where: { id: eventId } });
    return { ok: true };
  },

  async rsvp(userId: string, role: string, eventId: string, status: 'GOING' | 'INTERESTED' | 'NOT_GOING') {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { branchId: true, clusterId: true } });
    if (!event) throw NotFound('Event not found');
    await assertCanAttend(userId, role, event);
    await prisma.eventRSVP.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, status },
      update: { status },
    });
    return { ok: true };
  },

  // Withdraw an RSVP entirely (undo) — removes the row, unlike NOT_GOING which keeps a decline.
  async unrsvp(userId: string, eventId: string) {
    await prisma.eventRSVP.deleteMany({ where: { eventId, userId } });
    return { ok: true };
  },

  // QR check-in: the QR encodes the event id; scanning hits this endpoint.
  async checkIn(userId: string, role: string, eventId: string) {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { branchId: true, clusterId: true } });
    if (!event) throw NotFound('Event not found');
    await assertCanAttend(userId, role, event);
    const checkedInAt = new Date();
    await prisma.eventRSVP.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, status: 'GOING', checkedInAt },
      update: { checkedInAt },
    });
    return { ok: true, checkedInAt };
  },

  // Runs every 15 minutes. About a day before an event starts, remind the people it is for,
  // once. Moving startsAt clears reminderSentAt so the new time can be reminded too.
  async sendDueEventReminders(windowMs = 24 * 60 * 60 * 1000) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowMs);
    const events = await prisma.event.findMany({
      where: { reminderSentAt: null, startsAt: { gt: now, lte: windowEnd } },
      select: { id: true, title: true, startsAt: true, branchId: true, clusterId: true },
    });
    let notified = 0;
    for (const ev of events) {
      const claimed = await prisma.event.updateMany({
        where: { id: ev.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count !== 1) continue;

      const { title, body } = eventReminderCopy(ev.title, ev.startsAt);
      const data = eventPushData(ev.id, title, ev.startsAt);
      const before = notified;
      try {
        let cursor: string | undefined;
        for (;;) {
          const page = await reminderPage(ev, cursor);
          if (!page.length) break;
          const userIds = page.map((row) => row.userId);
          const res = await prisma.notification.createMany({
            data: userIds.map((userId) => ({
              userId,
              type: 'EVENT' as const,
              title,
              body,
              data,
            })),
          });
          notified += res.count;
          await pushService.sendToUsers(userIds, {
            title,
            body,
            data,
            threadId: `event:${ev.id}`,
          });
          cursor = page[page.length - 1]!.cursor;
          if (page.length < REMINDER_BATCH) break;
        }
      } catch (err) {
        if (notified === before) {
          await prisma.event.update({ where: { id: ev.id }, data: { reminderSentAt: null } }).catch(() => {});
        }
        throw err;
      }
    }
    return { events: events.length, notified };
  },
};

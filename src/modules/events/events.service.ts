import { prisma } from '../../infra/db';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { NotFound, Forbidden, BadRequest, type AppError } from '../../utils/errors';
import { announcementPushCopy, notificationImageUrl } from '../announcements/announcementPushCopy';
import { pushService } from '../push/push.service';
import type { CreateEventInput, UpdateEventInput } from './events.schema';

const EVENT_SELECT = {
  id: true,
  title: true,
  description: true,
  location: true,
  imageUrl: true,
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

function cleanEventId(eventId: string) {
  return eventId.trim().replace(/^["']+|["']+$/g, '');
}

// The list also carries branchId and branch.id. Those are not the event id, and delete
// with one of them looks like the event vanished from the database.
async function missingEvent(id: string): Promise<AppError> {
  if (id) {
    const other = await prisma.event.findFirst({
      where: { OR: [{ branchId: id }, { clusterId: id }] },
      select: { id: true },
    });
    if (other) return NotFound('Event not found. Use the event id, not the branch or cluster id.');
  }
  return NotFound('Event not found');
}

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

// The day-before reminder goes only to people who said they are coming or interested.
// No RSVP, and Not Going, stay quiet.
async function reminderPage(eventId: string, cursor?: string) {
  const rows = await prisma.eventRSVP.findMany({
    where: {
      eventId,
      status: { in: ['GOING', 'INTERESTED'] },
      user: { deletedAt: null, suspendedAt: null },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: REMINDER_BATCH,
    select: { id: true, userId: true },
  });
  return rows.map((row) => ({ cursor: row.id, userId: row.userId }));
}

// Who hears that an event was just created. A church-wide event reaches every active member.
// A branch or cluster event reaches that group. The admin who posted it is left out.
async function createdAudiencePage(
  event: { branchId: string | null; clusterId: string | null },
  excludeUserId: string | undefined,
  cursor?: string,
) {
  const activeUser = { deletedAt: null, suspendedAt: null };
  if (event.branchId) {
    const rows = await prisma.branchMembership.findMany({
      where: {
        branchId: event.branchId,
        ...(cursor ? { id: { gt: cursor } } : {}),
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        user: activeUser,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH,
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({ cursor: row.id, userId: row.userId }));
  }
  if (event.clusterId) {
    const rows = await prisma.clusterMembership.findMany({
      where: {
        clusterId: event.clusterId,
        ...(cursor ? { id: { gt: cursor } } : {}),
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        user: activeUser,
      },
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH,
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({ cursor: row.id, userId: row.userId }));
  }
  const id: { gt?: string; not?: string } = {};
  if (cursor) id.gt = cursor;
  if (excludeUserId) id.not = excludeUserId;
  const rows = await prisma.user.findMany({
    where: { ...activeUser, ...(id.gt || id.not ? { id } : {}) },
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
    const id = cleanEventId(eventId);
    const event = await prisma.event.findUnique({ where: { id }, select: EVENT_SELECT });
    if (!event) throw await missingEvent(id);

    const grouped = await prisma.eventRSVP.groupBy({ by: ['status'], where: { eventId: id }, _count: true });
    const rsvpCounts: Record<'GOING' | 'INTERESTED' | 'NOT_GOING', number> = { GOING: 0, INTERESTED: 0, NOT_GOING: 0 };
    for (const g of grouped) rsvpCounts[g.status] = g._count;

    const mine = await prisma.eventRSVP.findUnique({
      where: { eventId_userId: { eventId: id, userId } },
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
        imageUrl: dto.imageUrl ?? null,
        branchId: dto.branchId ?? null,
        clusterId: dto.clusterId ?? null,
        createdById: userId,
      },
      select: EVENT_SELECT,
    });
    const copy = announcementPushCopy({
      title: created.title,
      body: created.description,
      imageUrl: created.imageUrl,
    });
    enqueue(
      notificationQueue,
      'event-created',
      {
        eventId: created.id,
        title: copy.title,
        body: copy.body,
        imageUrl: copy.imageUrl,
        startsAt: created.startsAt.toISOString(),
        branchId: created.branchId,
        clusterId: created.clusterId,
        excludeUserId: userId,
      },
      { jobId: `event-created-${created.id}` },
    );
    return forMembers(created);
  },

  // Paged fan-out for a new event. Same picture rules as an announcement: a JPEG with the
  // title, or the title and the opening of the description when there is no picture.
  // `cursor` is the last page that already went out. A retry starts after it, so a failed
  // job does not ring the whole church again. `onPage` runs only after that page is sent.
  async notifyEventCreated(
    input: {
      eventId: string;
      title: string;
      body?: string | null;
      imageUrl?: string | null;
      startsAt: string;
      branchId?: string | null;
      clusterId?: string | null;
      excludeUserId?: string;
      cursor?: string;
    },
    onPage?: (cursor: string) => Promise<void>,
  ) {
    const startsAt = new Date(input.startsAt);
    const data = {
      ...eventPushData(input.eventId, input.title, startsAt),
      ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    };
    let notified = 0;
    let cursor = input.cursor;
    for (;;) {
      const page = await createdAudiencePage(
        { branchId: input.branchId ?? null, clusterId: input.clusterId ?? null },
        input.excludeUserId,
        cursor,
      );
      if (!page.length) break;
      const userIds = page.map((row) => row.userId);
      const res = await prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: 'EVENT' as const,
          title: input.title,
          body: input.body ?? null,
          data,
        })),
      });
      notified += res.count;
      await pushService.sendToUsers(userIds, {
        title: input.title,
        body: input.body ?? null,
        imageUrl: input.imageUrl ?? null,
        data,
        threadId: `event:${input.eventId}`,
      });
      cursor = page[page.length - 1]!.cursor;
      if (onPage) await onPage(cursor);
      if (page.length < REMINDER_BATCH) break;
    }
    return { notified };
  },

  // Edit an event's details (scope stays fixed). Same authority as creating it.
  async update(userId: string, role: string, eventId: string, dto: UpdateEventInput) {
    const id = cleanEventId(eventId);
    const event = await prisma.event.findUnique({
      where: { id },
      select: { id: true, branchId: true, clusterId: true, startsAt: true },
    });
    if (!event) throw await missingEvent(id);
    await assertCanManage(userId, role, event.branchId, event.clusterId);
    const startsAtMoved = dto.startsAt != null && dto.startsAt.getTime() !== event.startsAt.getTime();
    const updated = await prisma.event.update({
      where: { id },
      data: { ...dto, ...(startsAtMoved ? { reminderSentAt: null } : {}) },
      select: EVENT_SELECT,
    });
    return forMembers(updated);
  },

  // Delete/cancel an event. RSVPs cascade away with it.
  async remove(userId: string, role: string, eventId: string) {
    const id = cleanEventId(eventId);
    const event = await prisma.event.findUnique({
      where: { id },
      select: { branchId: true, clusterId: true },
    });
    if (!event) throw await missingEvent(id);
    await assertCanManage(userId, role, event.branchId, event.clusterId);
    await prisma.event.delete({ where: { id } });
    return { ok: true };
  },

  async rsvp(userId: string, role: string, eventId: string, status: 'GOING' | 'INTERESTED' | 'NOT_GOING') {
    const id = cleanEventId(eventId);
    const event = await prisma.event.findUnique({ where: { id }, select: { branchId: true, clusterId: true } });
    if (!event) throw await missingEvent(id);
    await assertCanAttend(userId, role, event);
    await prisma.eventRSVP.upsert({
      where: { eventId_userId: { eventId: id, userId } },
      create: { eventId: id, userId, status },
      update: { status },
    });
    return { ok: true };
  },

  // Withdraw an RSVP entirely (undo) — removes the row, unlike NOT_GOING which keeps a decline.
  async unrsvp(userId: string, eventId: string) {
    await prisma.eventRSVP.deleteMany({ where: { eventId: cleanEventId(eventId), userId } });
    return { ok: true };
  },

  // QR check-in: the QR encodes the event id; scanning hits this endpoint.
  async checkIn(userId: string, role: string, eventId: string) {
    const id = cleanEventId(eventId);
    const event = await prisma.event.findUnique({ where: { id }, select: { branchId: true, clusterId: true } });
    if (!event) throw await missingEvent(id);
    await assertCanAttend(userId, role, event);
    const checkedInAt = new Date();
    await prisma.eventRSVP.upsert({
      where: { eventId_userId: { eventId: id, userId } },
      create: { eventId: id, userId, status: 'GOING', checkedInAt },
      update: { checkedInAt },
    });
    return { ok: true, checkedInAt };
  },

  // Runs every 15 minutes. About a day before an event starts, remind people who RSVP'd
  // Going or Interested, once. Moving startsAt clears reminderSentAt so the new time can be reminded too.
  async sendDueEventReminders(windowMs = 24 * 60 * 60 * 1000) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowMs);
    const events = await prisma.event.findMany({
      where: { reminderSentAt: null, startsAt: { gt: now, lte: windowEnd } },
      select: { id: true, title: true, imageUrl: true, startsAt: true },
    });
    let notified = 0;
    for (const ev of events) {
      const claimed = await prisma.event.updateMany({
        where: { id: ev.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count !== 1) continue;

      const { title, body } = eventReminderCopy(ev.title, ev.startsAt);
      const imageUrl = ev.imageUrl ? notificationImageUrl(ev.imageUrl) : null;
      const data = {
        ...eventPushData(ev.id, title, ev.startsAt),
        ...(imageUrl ? { imageUrl } : {}),
      };
      const before = notified;
      try {
        let cursor: string | undefined;
        for (;;) {
          const page = await reminderPage(ev.id, cursor);
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
            imageUrl,
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

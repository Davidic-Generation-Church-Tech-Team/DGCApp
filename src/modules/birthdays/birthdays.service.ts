import { prisma } from '../../infra/db';
import { sendBirthdayEmail } from '../../infra/brevo';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { logger } from '../../infra/logger';
import { notificationService } from '../notifications/notifications.service';

const ZONE = 'Africa/Lagos';

function lagosToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return { year, month, day, wishFeb29OnFeb28: month === 2 && day === 28 && !leap };
}

type BirthdayRow = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export const birthdayService = {
  // Hourly through the Lagos day. The year stamp stops a second wish.
  async enqueueDueWishes(now = new Date()) {
    const { year, month, day, wishFeb29OnFeb28 } = lagosToday(now);
    const users = await prisma.$queryRaw<BirthdayRow[]>`
      SELECT "id", "email", "displayName", "avatarUrl"
      FROM "User"
      WHERE "deletedAt" IS NULL
        AND "suspendedAt" IS NULL
        AND "dateOfBirth" IS NOT NULL
        AND ("lastBirthdayWishYear" IS NULL OR "lastBirthdayWishYear" < ${year})
        AND (
          (EXTRACT(MONTH FROM "dateOfBirth") = ${month} AND EXTRACT(DAY FROM "dateOfBirth") = ${day})
          OR (
            ${wishFeb29OnFeb28 ? 1 : 0} = 1
            AND EXTRACT(MONTH FROM "dateOfBirth") = 2
            AND EXTRACT(DAY FROM "dateOfBirth") = 29
          )
        )
      LIMIT 500
    `;
    for (const user of users) {
      enqueue(notificationQueue, 'birthday-wish', { userId: user.id, year });
    }
    return { year, month, day, queued: users.length };
  },

  async sendWish(userId: string, year: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        displayName: true,
        avatarUrl: true,
        deletedAt: true,
        suspendedAt: true,
        dateOfBirth: true,
        lastBirthdayWishYear: true,
      },
    });
    if (!user || user.deletedAt || user.suspendedAt || !user.dateOfBirth) return { ok: false, skipped: true };
    if (user.lastBirthdayWishYear != null && user.lastBirthdayWishYear >= year) return { ok: true, skipped: true };

    const claimed = await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ lastBirthdayWishYear: null }, { lastBirthdayWishYear: { lt: year } }],
      },
      data: { lastBirthdayWishYear: year },
    });
    if (claimed.count !== 1) return { ok: true, skipped: true };

    const name = user.displayName?.trim() || 'friend';
    try {
      if (user.email) await sendBirthdayEmail(user.email, name, user.avatarUrl);
      await notificationService.notify(userId, {
        type: 'SYSTEM',
        title: `Happy birthday, ${name}`,
        body: 'We thank God for your life. May this new year be full of joy, peace, and sweet surprises. You are loved at DGC.',
        data: { type: 'birthday', notificationType: 'SYSTEM' },
        threadId: `birthday-${year}`,
      });
    } catch (err) {
      await prisma.user.update({ where: { id: userId }, data: { lastBirthdayWishYear: user.lastBirthdayWishYear } }).catch(() => {});
      throw err;
    }
    logger.info({ userId, emailed: Boolean(user.email) }, 'Birthday wish sent');
    return { ok: true };
  },
};

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  $queryRaw: vi.fn(),
  user: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
};
const sendBirthdayEmail = vi.fn();
const enqueue = vi.fn();
const notify = vi.fn();

vi.mock('../src/infra/db', () => ({ prisma }));
vi.mock('../src/infra/brevo', () => ({ sendBirthdayEmail }));
vi.mock('../src/infra/queue', () => ({ notificationQueue: { name: 'notification' } }));
vi.mock('../src/infra/enqueue', () => ({ enqueue }));
vi.mock('../src/infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/modules/notifications/notifications.service', () => ({
  notificationService: { notify },
}));

const { birthdayService } = await import('../src/modules/birthdays/birthdays.service');

const person = {
  email: 'ada@example.com',
  displayName: 'Ada',
  avatarUrl: 'https://cdn.example/ada.jpg',
  deletedAt: null,
  suspendedAt: null,
  dateOfBirth: new Date('1998-04-12T00:00:00.000Z'),
  lastBirthdayWishYear: null,
};

describe('birthday wishes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(person);
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({});
    sendBirthdayEmail.mockResolvedValue(undefined);
    notify.mockResolvedValue({});
  });

  it('emails the person and sends a warm push once', async () => {
    const result = await birthdayService.sendWish('user-ada', 2026);
    expect(result).toEqual({ ok: true });
    expect(sendBirthdayEmail).toHaveBeenCalledWith('ada@example.com', 'Ada', 'https://cdn.example/ada.jpg');
    expect(notify).toHaveBeenCalledWith('user-ada', expect.objectContaining({
      title: 'Happy birthday, Ada',
      body: expect.stringContaining('We thank God for your life'),
      data: { type: 'birthday', notificationType: 'SYSTEM' },
    }));
  });

  it('still pushes when the person has no email address', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...person, email: null });
    await birthdayService.sendWish('user-ada', 2026);
    expect(sendBirthdayEmail).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });

  it('skips a deleted, suspended, or already wished account', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...person, deletedAt: new Date() });
    await expect(birthdayService.sendWish('user-ada', 2026)).resolves.toEqual({ ok: false, skipped: true });

    prisma.user.findUnique.mockResolvedValue({ ...person, suspendedAt: new Date(), deletedAt: null });
    await expect(birthdayService.sendWish('user-ada', 2026)).resolves.toEqual({ ok: false, skipped: true });

    prisma.user.findUnique.mockResolvedValue({ ...person, lastBirthdayWishYear: 2026 });
    await expect(birthdayService.sendWish('user-ada', 2026)).resolves.toEqual({ ok: true, skipped: true });
    expect(sendBirthdayEmail).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('gives the year back when the email fails, so the next hour can try again', async () => {
    sendBirthdayEmail.mockRejectedValue(new Error('brevo down'));
    await expect(birthdayService.sendWish('user-ada', 2026)).rejects.toThrow('brevo down');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-ada' },
      data: { lastBirthdayWishYear: null },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('asks the database for today in Lagos, including a 29 February birthday on 28 February', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'user-ada' }]);
    const result = await birthdayService.enqueueDueWishes(new Date('2026-02-28T08:00:00.000Z'));
    expect(result).toMatchObject({ year: 2026, month: 2, day: 28, queued: 1 });
    const values = prisma.$queryRaw.mock.calls[0]?.slice(1);
    expect(values).toEqual([2026, 2, 28, 1]);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), 'birthday-wish', { userId: 'user-ada', year: 2026 });
  });
});

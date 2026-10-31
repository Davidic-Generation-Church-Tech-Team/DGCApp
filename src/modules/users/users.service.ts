import { prisma } from '../../infra/db';
import { NotFound, BadRequest, Conflict } from '../../utils/errors';
import { growthEngine } from '../growth/growth.engine';
import { getUserPresence } from '../chat/chat.socket';
import { cached, cacheKeys, invalidate } from '../../infra/cache';
import { optimizeAvatar } from '../../utils/cloudinaryUrl';
import { joinChannelRooms, emitToChannel, getIo } from '../../infra/realtime';
import type { UpdateMeInput } from './users.schema';

const ME_SELECT = {
  id: true,
  email: true,
  phoneNumber: true,
  globalRole: true,
  displayName: true,
  avatarUrl: true,
  gender: true,
  dateOfBirth: true,
  occupation: true,
  bio: true,
  createdAt: true,
} as const;

export async function hardDeleteUser(userId: string) {
  const channelIds = (
    await prisma.channelMembership.findMany({ where: { userId }, select: { channelId: true } })
  ).map((c) => c.channelId);

  const branchIds = (
    await prisma.branchMembership.findMany({ where: { userId }, select: { branchId: true } })
  ).map((m) => m.branchId);

  await prisma.$transaction(
    async (tx) => {
      await tx.message.deleteMany({ where: { senderId: userId } });
      await tx.user.delete({ where: { id: userId } });
    },
    { timeout: 20000, maxWait: 10000 },
  );

  return { channelIds, branchIds };
}

// PRD §2: selecting a branch auto-joins the branch community + Global Announcement channel.
// Exported so registration (auth.service) can reuse the exact same onboarding.
export async function onboardToBranch(userId: string, branchId: string) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true } });
  if (!branch) throw BadRequest('Branch not found');

  const memberships = await prisma.branchMembership.findMany({ where: { userId }, select: { branchId: true } });
  if (memberships.some((m) => m.branchId === branchId)) return; // idempotent — already in this branch
  if (memberships.length > 0) {
    throw Conflict('Already assigned to a branch; an admin must move you between branches');
  }

  const branchChannels = await prisma.channel.findMany({ where: { branchId }, select: { id: true } });
  // Every user gets both singleton global channels: Announcement (read-only) and Prayer Watch (open chat + live prayer call).
  const globalChannels = await prisma.channel.findMany({
    where: { type: { in: ['GLOBAL_ANNOUNCEMENT', 'GLOBAL_PRAYER_WATCH'] } },
    select: { id: true },
  });
  const channelIds = [...branchChannels.map((c) => c.id), ...globalChannels.map((c) => c.id)];

  // Two statements (membership + a single createMany), not N round-trips — stays well under the
  // transaction timeout even against a remote DB. skipDuplicates keeps it idempotent.
  await prisma.$transaction(
    async (tx) => {
      await tx.branchMembership.create({ data: { userId, branchId, role: 'MEMBER' } });
      await tx.channelMembership.createMany({
        data: channelIds.map((channelId) => ({ userId, channelId })),
        skipDuplicates: true,
      });
    },
    { timeout: 20000, maxWait: 10000 },
  );
  await prisma.user.updateMany({ where: { id: userId, onboardedAt: null }, data: { onboardedAt: new Date() } });
  await invalidate(
    cacheKeys.adminDashboard('global'),
    cacheKeys.adminDashboard(branchId),
    ...channelIds.flatMap((id) => [cacheKeys.channelMembers(id), cacheKeys.channelMeta(id)]),
  );
  joinChannelRooms(userId, channelIds);
  await growthEngine.enqueueRequirement(userId, 'JOIN_BRANCH'); // AUTO (First Timer, §11)
}

export const userService = {
  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...ME_SELECT,
        onboardedAt: true,
        currentStage: { select: { key: true, name: true, order: true } },
        branchMemberships: {
          select: { role: true, branch: { select: { id: true, name: true, city: true } } },
        },
        clusterMemberships: {
          select: { role: true, cluster: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
    if (!user) throw NotFound('User not found');
    return {
      ...user,
      onboardingComplete: Boolean(user.onboardedAt),
      onboardedAt: undefined,
    };
  },

  async updateMe(userId: string, data: UpdateMeInput) {
    const { branchId, email, phoneNumber, ...profile } = data;
    const updates: Record<string, unknown> = { ...profile };
    // Store avatars as right-sized auto-format delivery URLs — every list/chat render everywhere
    // then downloads ~10-50KB instead of a full-resolution original.
    if (typeof updates.avatarUrl === 'string') updates.avatarUrl = optimizeAvatar(updates.avatarUrl);

    // Contact additions: fill in the channel the user didn't sign up with. Only settable when
    // empty (changing a verified identity needs re-verification — a later slice), and unique.
    if (email !== undefined || phoneNumber !== undefined) {
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, phoneNumber: true },
      });
      if (email !== undefined) {
        const e = email.toLowerCase();
        if (current.email && current.email !== e) throw Conflict('Email is already set on this account');
        if (!current.email) {
          const taken = await prisma.user.findUnique({ where: { email: e }, select: { id: true } });
          if (taken && taken.id !== userId) throw Conflict('That email is already in use');
          updates.email = e;
        }
      }
      if (phoneNumber !== undefined) {
        if (current.phoneNumber && current.phoneNumber !== phoneNumber) {
          throw Conflict('Phone number is already set on this account');
        }
        if (!current.phoneNumber) {
          const taken = await prisma.user.findUnique({ where: { phoneNumber }, select: { id: true } });
          if (taken && taken.id !== userId) throw Conflict('That phone number is already in use');
          updates.phoneNumber = phoneNumber;
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.user.update({ where: { id: userId }, data: updates });
      await invalidate(cacheKeys.userProfile(userId));
    }
    if (branchId) await onboardToBranch(userId, branchId);
    return this.getMe(userId);
  },

  async getProfile(viewerId: string, targetId: string) {
    // Profile core is cached (invalidated on PATCH /users/me); presence + shared channels stay live.
    const user = await cached(cacheKeys.userProfile(targetId), 120, async () => {
      const row = await prisma.user.findUnique({
        where: { id: targetId, deletedAt: null },
        select: {
          id: true, displayName: true, avatarUrl: true, bio: true, occupation: true, createdAt: true,
        },
      });
      if (!row) throw NotFound('User not found');
      return row;
    });

    const [status, lastSeen, viewerChannels, targetChannels] = await Promise.all([
      getUserPresence(targetId),
      // Outside the cached profile core: it changes every time the user goes offline.
      prisma.user.findUnique({ where: { id: targetId }, select: { lastSeenAt: true } }),
      prisma.channelMembership.findMany({ where: { userId: viewerId }, select: { channelId: true } }),
      prisma.channelMembership.findMany({ where: { userId: targetId }, select: { channelId: true } }),
    ]);
    const viewerSet = new Set(viewerChannels.map((c) => c.channelId));
    const sharedIds = targetChannels.filter((c) => viewerSet.has(c.channelId)).map((c) => c.channelId);
    const sharedChannels = sharedIds.length
      ? await prisma.channel.findMany({
          where: { id: { in: sharedIds }, type: { not: 'DM' } },
          select: { id: true, type: true, name: true },
          take: 20,
        })
      : [];

    return { ...user, status, lastSeenAt: lastSeen?.lastSeenAt ?? null, sharedChannels };
  },

  // Self-delete (hard purge) — removes the account + its data and frees the email/phone for reuse.
  // Handy for testing; also a legit "delete my account" action.
  async deleteMe(userId: string) {
    const { channelIds, branchIds } = await hardDeleteUser(userId);

    await invalidate(
      cacheKeys.userProfile(userId),
      cacheKeys.clusters,
      cacheKeys.branches,
      cacheKeys.adminDashboard('global'),
      cacheKeys.adminAnalytics,
      ...branchIds.map((id) => cacheKeys.adminDashboard(id)),
      ...channelIds.flatMap((id) => [cacheKeys.channelMembers(id), cacheKeys.channelMeta(id)]),
    );

    const payload = { userId };
    for (const channelId of channelIds) {
      emitToChannel(channelId, 'user:deleted', payload);
    }
    getIo()?.emit('user:deleted', payload);

    return { ok: true };
  },
};

import { prisma } from '../../infra/db';
import { NotFound, Conflict, Forbidden } from '../../utils/errors';
import { cached, cacheKeys, invalidate } from '../../infra/cache';
import { joinChannelRooms } from '../../infra/realtime';
import { getOnlineUsers } from '../chat/chat.socket';
import type { CreateBranchInput, CreateClusterInput, UpdateClusterInput } from './admin.schema';

const BRANCH_SECTIONS = [
  'General Chat',
  'Prayer Requests',
  'Testimonies',
  'Service Updates',
  'Volunteer Opportunities',
];

async function firstAdminBranch(userId: string) {
  const membership = await prisma.branchMembership.findFirst({
    where: { userId, role: 'ADMIN' },
    orderBy: { joinedAt: 'asc' },
    select: { branchId: true },
  });
  if (!membership) throw Forbidden('Branch admin only');
  return membership.branchId;
}

async function resolveAdminBranchScope(userId: string, role: string, branchId?: string) {
  if (role === 'SUPER_ADMIN') return branchId;
  const targetBranchId = branchId ?? (await firstAdminBranch(userId));
  const membership = await prisma.branchMembership.findUnique({
    where: { userId_branchId: { userId, branchId: targetBranchId } },
    select: { role: true },
  });
  if (membership?.role !== 'ADMIN') throw Forbidden('Only this branch admin can access this branch');
  return targetBranchId;
}

async function ensureUserExists(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, globalRole: true },
  });
  if (!user) throw NotFound('User not found');
  return user;
}

function assertBranchAdminCanManageTarget(actorRole: string, target: { globalRole: string }) {
  if (actorRole !== 'SUPER_ADMIN' && target.globalRole !== 'MEMBER') {
    throw Forbidden('Branch admins can only manage member accounts');
  }
}

async function branchAdminBranchIds(userId: string) {
  const memberships = await prisma.branchMembership.findMany({
    where: { userId, role: 'ADMIN' },
    select: { branchId: true },
  });
  if (!memberships.length) throw Forbidden('Super admin or branch admin only');
  return memberships.map((m) => m.branchId);
}

async function assertCanPromoteBranchAdmin(actorId: string, actorRole: string, branchId: string, targetUserId: string) {
  if (actorRole === 'SUPER_ADMIN') return { canCreateBranchMembership: true };

  await resolveAdminBranchScope(actorId, actorRole, branchId);
  const targetMembership = await prisma.branchMembership.findUnique({
    where: { userId_branchId: { userId: targetUserId, branchId } },
    select: { id: true },
  });
  if (!targetMembership) {
    throw Forbidden('Branch admins can only promote existing members of their own branch');
  }
  return { canCreateBranchMembership: false };
}

async function assertCanAssignClusterModerator(actorId: string, actorRole: string, targetUserId: string) {
  if (actorRole === 'SUPER_ADMIN') return;

  const branchIds = await branchAdminBranchIds(actorId);
  const targetMembership = await prisma.branchMembership.findFirst({
    where: { userId: targetUserId, branchId: { in: branchIds } },
    select: { id: true },
  });
  if (!targetMembership) {
    throw Forbidden('Branch admins can only appoint cluster moderators from their own branch members');
  }
}

export const adminService = {
  async analytics() {
    return cached(cacheKeys.adminAnalytics, 60, async () => {
      const [
        totalUsers,
        suspendedUsers,
        byBranch,
        byStage,
        totalEvents,
        totalMessages,
        branches,
        stages,
        authBreakdown,
      ] = await Promise.all([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.user.count({ where: { suspendedAt: { not: null } } }),
        prisma.branchMembership.groupBy({ by: ['branchId'], _count: true }),
        prisma.user.groupBy({ by: ['currentStageId'], _count: true }),
        prisma.event.count(),
        prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*)::bigint AS count FROM "Message" WHERE "deletedAt" IS NULL
        `.then((r) => Number(r[0].count)),
        prisma.branch.findMany({ select: { id: true, name: true } }),
        prisma.growthStage.findMany({ orderBy: { order: 'asc' }, select: { id: true, name: true } }),
        prisma.$queryRaw<[{ google_only: bigint; apple_only: bigint; both: bigint }]>`
          SELECT
            COUNT(*) FILTER (WHERE has_google AND NOT has_apple)::bigint AS google_only,
            COUNT(*) FILTER (WHERE has_apple AND NOT has_google)::bigint AS apple_only,
            COUNT(*) FILTER (WHERE has_google AND has_apple)::bigint   AS both
          FROM (
            SELECT
              ap."userId",
              bool_or(ap."kind" = 'GOOGLE') AS has_google,
              bool_or(ap."kind" = 'APPLE')  AS has_apple
            FROM "AuthProvider" ap
            JOIN "User" u ON u."id" = ap."userId" AND u."deletedAt" IS NULL
            GROUP BY ap."userId"
          ) sub
        `,
      ]);

      const branchName = new Map(branches.map((b) => [b.id, b.name]));
      const googleOnly = Number(authBreakdown[0].google_only);
      const appleOnly = Number(authBreakdown[0].apple_only);
      const both = Number(authBreakdown[0].both);
      const passwordOrOtpOnly = Math.max(0, totalUsers - googleOnly - appleOnly - both);

      return {
        totalUsers,
        suspendedUsers,
        totalEvents,
        totalMessages,
        byBranch: byBranch.map((r) => ({ branch: branchName.get(r.branchId) ?? r.branchId, members: r._count })),
        leadershipPipeline: stages.map((s) => ({
          stage: s.name,
          count: byStage.find((r) => r.currentStageId === s.id)?._count ?? 0,
        })),
        signupMethods: { google: googleOnly, apple: appleOnly, both, passwordOrOtpOnly },
      };
    });
  },

  // Live "who's online" page: presence comes from Redis, profile fields from the DB.
  async onlineUsers(offset = 0, limit = 50) {
    const { onlineCount, users, hasMore } = await getOnlineUsers(offset, limit);
    const rows = users.length
      ? await prisma.user.findMany({
          where: { id: { in: users.map((u) => u.userId) }, deletedAt: null },
          select: { id: true, displayName: true, avatarUrl: true, globalRole: true },
        })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      onlineCount,
      items: users.flatMap((u) => {
        const user = byId.get(u.userId);
        return user ? [{ user, status: u.status, lastActiveAt: u.lastActiveAt }] : [];
      }),
      nextOffset: hasMore ? offset + limit : null,
    };
  },

  async listUsers(search?: string, limit = 50) {
    return prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: 'insensitive' } },
                { displayName: { contains: search, mode: 'insensitive' } },
                { phoneNumber: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        displayName: true,
        globalRole: true,
        suspendedAt: true,
        createdAt: true,
        currentStage: { select: { name: true } },
        branchMemberships: { select: { role: true, branch: { select: { name: true } } } },
      },
    });
  },

  async setSuspended(userId: string, suspended: boolean) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) throw NotFound('User not found');
    await prisma.user.update({ where: { id: userId }, data: { suspendedAt: suspended ? new Date() : null } });
    return { ok: true };
  },

  async setRole(userId: string, role: 'MEMBER' | 'SUPER_ADMIN') {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) throw NotFound('User not found');
    await prisma.user.update({ where: { id: userId }, data: { globalRole: role } });
    return { ok: true };
  },

  // Create a branch and auto-provision its section channels (PRD §2/§5).
  async createBranch(input: CreateBranchInput) {
    const branch = await prisma.branch.create({
      data: { name: input.name, city: input.city, country: input.country ?? 'Nigeria' },
    });
    await prisma.channel.createMany({
      data: BRANCH_SECTIONS.map((name) => ({
        type: 'BRANCH_SECTION' as const,
        branchId: branch.id,
        name,
        isReadOnly: name === 'Service Updates', // the branch announcement channel (PRD §3)
      })),
    });
    await invalidate(cacheKeys.branches);
    return branch;
  },

  async assignBranchAdmin(actorId: string, actorRole: string, branchId: string, userId: string) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true } });
    if (!branch) throw NotFound('Branch not found');
    const target = await ensureUserExists(userId);
    assertBranchAdminCanManageTarget(actorRole, target);
    const { canCreateBranchMembership } = await assertCanPromoteBranchAdmin(actorId, actorRole, branchId, userId);

    const branchChannels = await prisma.channel.findMany({ where: { branchId }, select: { id: true } });
    const channelIds = branchChannels.map((c) => c.id);

    await prisma.$transaction(async (tx) => {
      if (canCreateBranchMembership) {
        await tx.branchMembership.upsert({
          where: { userId_branchId: { userId, branchId } },
          create: { userId, branchId, role: 'ADMIN' },
          update: { role: 'ADMIN' },
        });
      } else {
        await tx.branchMembership.update({
          where: { userId_branchId: { userId, branchId } },
          data: { role: 'ADMIN' },
        });
      }
      if (channelIds.length) {
        await tx.channelMembership.createMany({
          data: channelIds.map((channelId) => ({ userId, channelId })),
          skipDuplicates: true,
        });
      }
    });

    await invalidate(
      cacheKeys.adminDashboard('global'),
      cacheKeys.adminDashboard(branchId),
      cacheKeys.adminAnalytics,
      ...channelIds.flatMap((id) => [cacheKeys.channelMembers(id), cacheKeys.channelMeta(id)]),
    );
    joinChannelRooms(userId, channelIds);
    return { ok: true };
  },

  async assignClusterModerator(actorId: string, actorRole: string, clusterId: string, userId: string) {
    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } });
    if (!cluster) throw NotFound('Cluster not found');
    const target = await ensureUserExists(userId);
    assertBranchAdminCanManageTarget(actorRole, target);
    await assertCanAssignClusterModerator(actorId, actorRole, userId);
    const channel = await prisma.channel.findFirst({
      where: { type: 'CLUSTER', clusterId },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.clusterMembership.upsert({
        where: { userId_clusterId: { userId, clusterId } },
        create: { userId, clusterId, role: 'MODERATOR' },
        update: { role: 'MODERATOR' },
      });
      if (channel) {
        await tx.channelMembership.upsert({
          where: { userId_channelId: { userId, channelId: channel.id } },
          create: { userId, channelId: channel.id, role: 'MODERATOR' },
          update: { role: 'MODERATOR' },
        });
      }
    });
    await invalidate(
      cacheKeys.clusters,
      cacheKeys.adminDashboard('global'),
      cacheKeys.adminAnalytics,
      ...(channel ? [cacheKeys.channelMembers(channel.id), cacheKeys.channelMeta(channel.id)] : []),
    );
    if (channel) joinChannelRooms(userId, [channel.id]);
    return { ok: true };
  },

  async setClusterArchived(clusterId: string, archived: boolean) {
    const c = await prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } });
    if (!c) throw NotFound('Cluster not found');
    await prisma.cluster.update({ where: { id: clusterId }, data: { archivedAt: archived ? new Date() : null } });
    await invalidate(cacheKeys.clusters, cacheKeys.adminDashboard('global'), cacheKeys.adminAnalytics);
    return { ok: true };
  },

  async dashboardForAdmin(userId: string, role: string, branchId?: string) {
    const scopedBranchId = await resolveAdminBranchScope(userId, role, branchId);
    return this.branchDashboard(scopedBranchId);
  },

  async membersForAdmin(userId: string, role: string, branchId?: string, search?: string, cursor?: string, limit = 50) {
    const scopedBranchId = await resolveAdminBranchScope(userId, role, branchId);
    return this.branchMembers(scopedBranchId, search, cursor, limit);
  },

  async removeBranchMemberForAdmin(actorId: string, role: string, branchId: string, userId: string) {
    await resolveAdminBranchScope(actorId, role, branchId);
    return this.removeBranchMember(branchId, userId);
  },

  async branchDashboard(branchId?: string) {
    let branchName = 'All Branches';

    if (branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true } });
      if (!branch) throw NotFound('Branch not found');
      branchName = branch.name;
    }

    const scope = branchId ?? 'global';

    return cached(cacheKeys.adminDashboard(scope), 60, async () => {
      const [
        totalMembers,
        stages,
        pendingCerts,
        monthlyRaw,
        pipelineRaw,
      ] = await Promise.all([
        branchId
          ? prisma.branchMembership.count({ where: { branchId, user: { deletedAt: null } } })
          : prisma.user.count({ where: { deletedAt: null } }),
        prisma.growthStage.findMany({ orderBy: { order: 'asc' }, select: { id: true, name: true } }),
        prisma.certificate.count({
          where: {
            status: 'PENDING',
            ...(branchId
              ? { user: { deletedAt: null, branchMemberships: { some: { branchId } } } }
              : { user: { deletedAt: null } }),
          },
        }),
        branchId
          ? prisma.$queryRaw<{ month: string; count: bigint }[]>`
              SELECT to_char("joinedAt", 'YYYY-MM') AS month, COUNT(*)::bigint AS count
              FROM "BranchMembership" bm
              JOIN "User" u ON u."id" = bm."userId" AND u."deletedAt" IS NULL
              WHERE bm."branchId" = ${branchId}
                AND bm."joinedAt" >= NOW() - INTERVAL '6 months'
              GROUP BY month
              ORDER BY month ASC
            `
          : prisma.$queryRaw<{ month: string; count: bigint }[]>`
              SELECT to_char(bm."joinedAt", 'YYYY-MM') AS month, COUNT(*)::bigint AS count
              FROM "BranchMembership" bm
              JOIN "User" u ON u."id" = bm."userId" AND u."deletedAt" IS NULL
              WHERE bm."joinedAt" >= NOW() - INTERVAL '6 months'
              GROUP BY month
              ORDER BY month ASC
            `,
        branchId
          ? prisma.$queryRaw<{ currentStageId: string; count: bigint }[]>`
              SELECT u."currentStageId", COUNT(*)::bigint AS count
              FROM "BranchMembership" bm
              JOIN "User" u ON u."id" = bm."userId" AND u."deletedAt" IS NULL
              WHERE bm."branchId" = ${branchId}
              GROUP BY u."currentStageId"
            `
          : prisma.$queryRaw<{ currentStageId: string; count: bigint }[]>`
              SELECT u."currentStageId", COUNT(*)::bigint AS count
              FROM "BranchMembership" bm
              JOIN "User" u ON u."id" = bm."userId" AND u."deletedAt" IS NULL
              GROUP BY u."currentStageId"
            `,
      ]);

      const pipelineMap = new Map(pipelineRaw.map((r) => [r.currentStageId, Number(r.count)]));

      return {
        scope: branchId ? 'branch' : 'global',
        branchId: branchId ?? null,
        branch: branchName,
        totalMembers,
        pendingCertificates: pendingCerts,
        leadershipPipeline: stages.map((s) => ({
          stage: s.name,
          count: pipelineMap.get(s.id) ?? 0,
        })),
        monthlyGrowth: monthlyRaw.map((r) => ({
          month: r.month,
          count: Number(r.count),
        })),
      };
    });
  },

  // Member list with search. When branchId is provided, scopes to that branch;
  // when omitted, returns all users globally.
  async branchMembers(branchId?: string, search?: string, cursor?: string, limit = 50) {
    if (branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { id: true } });
      if (!branch) throw NotFound('Branch not found');
    }

    const members = await prisma.branchMembership.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        user: {
          deletedAt: null,
          ...(search
            ? {
                OR: [
                  { displayName: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                  { phoneNumber: { contains: search } },
                ],
              }
            : {}),
        },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true,
        role: true,
        joinedAt: true,
        branch: { select: { id: true, name: true } },
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
            email: true,
            globalRole: true,
            currentStage: { select: { key: true, name: true } },
            clusterMemberships: { select: { cluster: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    const hasMore = members.length > limit;
    const items = (hasMore ? members.slice(0, limit) : members).map((m) => ({
      membershipId: m.id,
      branchRole: m.role,
      joinedAt: m.joinedAt,
      branch: m.branch,
      ...m.user,
      clusters: m.user.clusterMemberships.map((cm) => cm.cluster),
      clusterMemberships: undefined,
    }));

    return {
      members: items,
      nextCursor: hasMore ? members[limit - 1]!.id : null,
    };
  },

  // Remove a member from a branch (and their branch channels).
  async removeBranchMember(branchId: string, userId: string) {
    const membership = await prisma.branchMembership.findUnique({
      where: { userId_branchId: { userId, branchId } },
      select: { id: true },
    });
    if (!membership) throw NotFound('User is not a member of this branch');

    const branchChannels = await prisma.channel.findMany({
      where: { branchId },
      select: { id: true },
    });
    const channelIds = branchChannels.map((c) => c.id);

    await prisma.$transaction(async (tx) => {
      await tx.branchMembership.delete({ where: { id: membership.id } });
      if (channelIds.length) {
        await tx.channelMembership.deleteMany({
          where: { userId, channelId: { in: channelIds } },
        });
      }
    });

    await invalidate(
      ...channelIds.flatMap((id) => [cacheKeys.channelMembers(id), cacheKeys.channelMeta(id)]),
    );
    return { ok: true };
  },

  // Create a cluster + its chat channel.
  async createCluster(input: CreateClusterInput) {
    const existing = await prisma.cluster.findUnique({ where: { slug: input.slug }, select: { id: true } });
    if (existing) throw Conflict('A cluster with this slug already exists');

    const cluster = await prisma.cluster.create({
      data: { name: input.name, slug: input.slug, description: input.description, isDefault: false },
    });
    await prisma.channel.create({
      data: { type: 'CLUSTER', clusterId: cluster.id, name: cluster.name },
    });
    await invalidate(cacheKeys.clusters, cacheKeys.adminDashboard('global'), cacheKeys.adminAnalytics);
    return cluster;
  },

  // Edit a cluster's name/description.
  async updateCluster(clusterId: string, input: UpdateClusterInput) {
    const c = await prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } });
    if (!c) throw NotFound('Cluster not found');
    const updated = await prisma.cluster.update({
      where: { id: clusterId },
      data: input,
      select: { id: true, name: true, slug: true, description: true },
    });
    // Sync the cluster channel name if the cluster name changed.
    if (input.name) {
      await prisma.channel.updateMany({
        where: { clusterId, type: 'CLUSTER' },
        data: { name: input.name },
      });
    }
    await invalidate(cacheKeys.clusters, cacheKeys.adminDashboard('global'), cacheKeys.adminAnalytics);
    return updated;
  },
};

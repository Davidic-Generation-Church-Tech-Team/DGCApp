import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/db';
import { NotFound, BadRequest, Forbidden } from '../../utils/errors';
import { getBulkPresence } from '../chat/chat.socket';
import { cached, cacheKeys } from '../../infra/cache';
import { thumbUrl } from '../../utils/cloudinaryUrl';
import { joinChannelRoom } from '../../infra/realtime';

const CHANNEL_SELECT = {
  id: true,
  type: true,
  name: true,
  description: true,
  isReadOnly: true,
  branchId: true,
  clusterId: true,
  createdAt: true,
} as const;

export const channelService = {
  // Membership gate reused across chat ops. SUPER_ADMIN bypasses (can read/moderate any channel).
  async requireMember(userId: string, role: string, channelId: string) {
    const membership = await prisma.channelMembership.findUnique({
      where: { userId_channelId: { userId, channelId } },
    });
    if (!membership && role !== 'SUPER_ADMIN') throw Forbidden('You are not a member of this channel');
    return membership;
  },

  // The Chats list. Batched (not N+1): one grouped unread query honouring each channel's lastReadAt,
  // one DISTINCT ON for the last message, one for DM peers — ~4 queries regardless of channel count.
  async listMine(userId: string) {
    const memberships = await prisma.channelMembership.findMany({
      where: { userId },
      select: {
        role: true,
        lastReadAt: true,
        channel: {
          select: { ...CHANNEL_SELECT, branch: { select: { name: true } }, cluster: { select: { name: true } } },
        },
      },
    });
    if (memberships.length === 0) return [];
    const channelIds = memberships.map((m) => m.channel.id);

    const [unreadRows, lastRows] = await Promise.all([
      prisma.$queryRaw<{ channelId: string; count: number }[]>`
        SELECT cm."channelId", COUNT(m."id")::int AS count
        FROM "ChannelMembership" cm
        JOIN "Message" m
          ON m."channelId" = cm."channelId"
         AND m."deletedAt" IS NULL
         AND m."senderId" <> cm."userId"
         AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
        WHERE cm."userId" = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM "UserBlock" ub
            WHERE ub."blockerId" = ${userId} AND ub."blockedId" = m."senderId"
          )
        GROUP BY cm."channelId"`,
      prisma.$queryRaw<
        { id: string; channelId: string; body: string | null; type: string; senderId: string; senderName: string | null; createdAt: Date }[]
      >`
        SELECT DISTINCT ON (m."channelId") m."id", m."channelId", m."body", m."type", m."senderId", u."displayName" AS "senderName", m."createdAt"
        FROM "Message" m
        JOIN "User" u ON u."id" = m."senderId"
        WHERE m."channelId" IN (${Prisma.join(channelIds)}) AND m."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "UserBlock" ub
            WHERE ub."blockerId" = ${userId} AND ub."blockedId" = m."senderId"
          )
        ORDER BY m."channelId", m."createdAt" DESC, m."id" DESC`,
    ]);
    const unreadMap = new Map(unreadRows.map((r) => [r.channelId, r.count]));
    const lastMap = new Map(lastRows.map((r) => [r.channelId, r]));

    const dmIds = memberships.filter((m) => m.channel.type === 'DM').map((m) => m.channel.id);
    const peers = dmIds.length
      ? await prisma.channelMembership.findMany({
          where: { channelId: { in: dmIds }, userId: { not: userId } },
          select: { channelId: true, user: { select: { id: true, displayName: true, avatarUrl: true, lastSeenAt: true } } },
        })
      : [];
    const peerMap = new Map(peers.map((p) => [p.channelId, p.user]));

    // Bulk-fetch presence for all DM peers
    const peerIds = peers.map((p) => p.user.id);
    const peerPresence = await getBulkPresence(peerIds);

    const items = memberships.map((m) => {
      const ch = m.channel;
      const peer = peerMap.get(ch.id) ?? null;
      return {
        id: ch.id,
        type: ch.type,
        branchId: ch.branchId,
        clusterId: ch.clusterId,
        name: ch.name ?? ch.branch?.name ?? ch.cluster?.name ?? peer?.displayName ?? null,
        isReadOnly: ch.isReadOnly,
        role: m.role,
        lastReadAt: m.lastReadAt,
        unreadCount: unreadMap.get(ch.id) ?? 0,
        lastMessage: lastMap.get(ch.id) ?? null,
        peer: peer ? { ...peer, status: peerPresence[peer.id] ?? 'offline' } : null,
      };
    });
    items.sort(
      (a, b) => (b.lastMessage?.createdAt?.getTime() ?? 0) - (a.lastMessage?.createdAt?.getTime() ?? 0),
    );
    return items;
  },

  async get(userId: string, role: string, channelId: string) {
    const membership = await this.requireMember(userId, role, channelId);
    // Shared meta is cached; myRole/isMuted come from the (already fetched) membership row.
    const meta = await cached(cacheKeys.channelMeta(channelId), 60, async () => {
      const [channel, memberCount] = await Promise.all([
        prisma.channel.findUnique({
          where: { id: channelId },
          select: {
            ...CHANNEL_SELECT,
            branch: { select: { id: true, name: true } },
            cluster: { select: { id: true, name: true } },
          },
        }),
        prisma.channelMembership.count({ where: { channelId } }),
      ]);
      if (!channel) throw NotFound('Channel not found');
      return { ...channel, memberCount };
    });
    return {
      ...meta,
      myRole: membership?.role ?? (role === 'SUPER_ADMIN' ? 'ADMIN' : 'MEMBER'),
      isMuted: !!membership?.mutedAt,
    };
  },

  async markRead(userId: string, _role: string, channelId: string) {
    // No membership pre-check: the update is scoped to (userId, channelId), so a non-member
    // is a harmless zero-row no-op — same semantics as the socket handler, half the queries.
    await prisma.channelMembership.updateMany({
      where: { userId, channelId },
      data: { lastReadAt: new Date() },
    });
    return { ok: true };
  },

  // Open (or return existing) a 1:1 DM channel.
  async openDm(userId: string, otherUserId: string) {
    if (userId === otherUserId) throw BadRequest('Cannot start a DM with yourself');
    const [other, blocked] = await Promise.all([
      prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } }),
      prisma.userBlock.findFirst({
        where: { OR: [{ blockerId: userId, blockedId: otherUserId }, { blockerId: otherUserId, blockedId: userId }] },
        select: { id: true },
      }),
    ]);
    if (!other) throw NotFound('User not found');
    if (blocked) throw Forbidden('Cannot open a DM with a blocked user');

    const existing = await prisma.channel.findFirst({
      where: {
        type: 'DM',
        AND: [{ memberships: { some: { userId } } }, { memberships: { some: { userId: otherUserId } } }],
      },
      select: CHANNEL_SELECT,
    });
    if (existing) {
      joinChannelRoom(userId, existing.id);
      joinChannelRoom(otherUserId, existing.id);
      return existing;
    }

    const channel = await prisma.channel.create({
      data: { type: 'DM', memberships: { create: [{ userId }, { userId: otherUserId }] } },
      select: CHANNEL_SELECT,
    });
    joinChannelRoom(userId, channel.id);
    joinChannelRoom(otherUserId, channel.id);
    return channel;
  },

  // Channel members (PRD §7 "who's in this group"). Capped page for now — add cursor paging when a
  // branch channel gets large.
  async members(userId: string, role: string, channelId: string, limit = 50) {
    const membership = await this.requireMember(userId, role, channelId);
    // The DB part (rows + count + isReadOnly) is cached; presence is merged live on every request
    // so the online dots stay accurate. The read-only gate runs AFTER the cache read — the cached
    // blob is shared, the decision is per-caller.
    const data = await cached(cacheKeys.channelMembers(channelId), 60, async () => {
      const [channel, memberCount, rows] = await Promise.all([
        prisma.channel.findUnique({ where: { id: channelId }, select: { isReadOnly: true } }),
        prisma.channelMembership.count({ where: { channelId } }),
        prisma.channelMembership.findMany({
          where: { channelId },
          orderBy: { joinedAt: 'asc' },
          take: Math.min(limit, 200),
          select: { role: true, user: { select: { id: true, displayName: true, avatarUrl: true } } },
        }),
      ]);
      return {
        isReadOnly: channel?.isReadOnly ?? false,
        memberCount,
        members: rows.map((r) => ({ ...r.user, role: r.role })),
      };
    });
    if (data.isReadOnly && role !== 'SUPER_ADMIN' && membership?.role === 'MEMBER') {
      throw Forbidden('Only admins can view members in view-only channels');
    }
    const presence = await getBulkPresence(data.members.map((m) => m.id));
    return {
      memberCount: data.memberCount,
      members: data.members.map((m) => ({ ...m, status: presence[m.id] })),
    };
  },

  async mute(userId: string, channelId: string) {
    await prisma.channelMembership.update({
      where: { userId_channelId: { userId, channelId } },
      data: { mutedAt: new Date() },
    });
    return { ok: true };
  },

  async unmute(userId: string, channelId: string) {
    await prisma.channelMembership.update({
      where: { userId_channelId: { userId, channelId } },
      data: { mutedAt: null },
    });
    return { ok: true };
  },

  async pinnedMessages(userId: string, role: string, channelId: string) {
    await this.requireMember(userId, role, channelId);
    const rows = await prisma.message.findMany({
      where: { channelId, pinnedAt: { not: null }, deletedAt: null },
      orderBy: { pinnedAt: 'desc' },
      select: {
        id: true, type: true, body: true, mediaUrl: true, pinnedAt: true, createdAt: true,
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
    return rows.map((m) => ({ ...m, thumbUrl: thumbUrl(m.mediaUrl, m.type) }));
  },

  async sharedMedia(userId: string, role: string, channelId: string, cursor?: string, limit = 30) {
    await this.requireMember(userId, role, channelId);
    const where: Record<string, unknown> = {
      channelId,
      type: { in: ['IMAGE', 'VIDEO', 'AUDIO', 'FILE'] },
      deletedAt: null,
    };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }
    const items = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 50),
      select: {
        id: true, type: true, mediaUrl: true, body: true, createdAt: true,
        sender: { select: { id: true, displayName: true } },
      },
    });
    return {
      items: items.map((m) => ({ ...m, thumbUrl: thumbUrl(m.mediaUrl, m.type) })),
      nextCursor: items.length === limit ? items[items.length - 1]!.createdAt.toISOString() : null,
    };
  },
};

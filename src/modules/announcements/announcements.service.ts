import { prisma } from '../../infra/db';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { emitToChannel, joinChannelRoom } from '../../infra/realtime';
import { Forbidden, NotFound } from '../../utils/errors';
import type { PostAnnouncementInput } from './announcements.schema';
import { inspectMediaUrl, type MediaKind } from '../media/media.limits';
import { asAdminAuthor } from '../../utils/adminAuthor';
import { optimizeImage } from '../../utils/cloudinaryUrl';
import { announcementPushCopy } from './announcementPushCopy';
import { presentAnnouncement } from './announcementMedia';

// PRD §4/§3: official comms. The Global Announcement channel is org-wide; each branch's read-only
// "Service Updates" section is its branch announcement channel. Both are posted only by super admins
// + authorized posters (channel admins / branch admins) and fanned out to their members.
const ANNOUNCEMENT_SELECT = {
  id: true,
  title: true,
  body: true,
  type: true,
  mediaUrl: true, // first attachment's URL; kept for clients that predate albums
  attachments: {
    select: { id: true, url: true, type: true, position: true, width: true, height: true },
    orderBy: { position: 'asc' },
  },
  createdAt: true,
  sender: { select: { id: true, displayName: true, avatarUrl: true } },
  // Members can react (PRD §4) — reactions post via /messages/:id/reactions and surface here.
  reactions: { select: { emoji: true, userId: true } },
} as const;

// The branch "Service Updates" section doubles as the read-only branch announcement channel.
const BRANCH_ANNOUNCEMENT_SECTION = 'Service Updates';

async function globalChannelId(): Promise<string> {
  const ch = await prisma.channel.findFirst({ where: { type: 'GLOBAL_ANNOUNCEMENT' }, select: { id: true } });
  if (!ch) throw NotFound('Global announcement channel not found');
  return ch.id;
}

async function branchChannelId(branchId: string): Promise<string> {
  const ch = await prisma.channel.findFirst({
    where: { branchId, type: 'BRANCH_SECTION', name: BRANCH_ANNOUNCEMENT_SECTION },
    select: { id: true },
  });
  if (!ch) throw NotFound('Branch announcement channel not found');
  return ch.id;
}

// The single-file `mediaUrl` form is treated as a one-item album, so every media announcement has
// attachment rows and clients can read `attachments` uniformly. Each URL is checked (our Cloudinary
// account, allowed type, size) before anything is written; the first bad item fails the whole post.
function toAttachments(input: PostAnnouncementInput) {
  const items = input.attachments ?? (input.mediaUrl ? [{ url: input.mediaUrl }] : []);
  return items.map(({ bytes, ...a }, position) => ({ ...a, position, type: inspectMediaUrl(a.url, bytes).kind }));
}

function pushPreview(attachments: { type: MediaKind }[]): string | null {
  if (attachments.length === 0) return null;
  if (attachments.length > 1) return `Shared ${attachments.length} attachments`;
  const t = attachments[0]?.type;
  return t === 'IMAGE' ? 'Shared a photo' : t === 'VIDEO' ? 'Shared a video' : t === 'AUDIO' ? 'Shared audio' : 'Shared a file';
}

// Post to an announcement channel + fan out a Notification to every member off the request path.
async function broadcast(channelId: string, userId: string, input: PostAnnouncementInput) {
  const attachments = toAttachments(input);
  const stored = attachments.map((item) =>
    item.type === 'IMAGE' ? { ...item, url: optimizeImage(item.url) } : item,
  );
  // Message + attachment rows are written in one nested create, so a failure leaves neither.
  const message = await prisma.message.create({
    data: {
      channelId,
      senderId: userId,
      type: stored[0]?.type ?? 'TEXT',
      title: input.title,
      body: input.body?.trim() || null,
      mediaUrl: stored[0]?.url ?? null,
      ...(stored.length > 0 && { attachments: { create: stored } }),
    },
    select: ANNOUNCEMENT_SELECT,
  });
  const shown = asAdminAuthor(presentAnnouncement(message));
  emitToChannel(channelId, 'message:new', shown); // live for members currently connected
  const push = announcementPushCopy({
    title: input.title,
    body: message.body,
    imageUrl: attachments.find((item) => item.type === 'IMAGE')?.url ?? null,
    fallback: pushPreview(attachments),
  });
  enqueue(notificationQueue, 'announcement-fanout', {
    channelId,
    messageId: message.id,
    title: push.title,
    body: push.body,
    imageUrl: push.imageUrl,
    excludeUserId: userId,
  });
  return shown;
}

async function listChannel(channelId: string) {
  const rows = await prisma.message.findMany({
    where: { channelId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: ANNOUNCEMENT_SELECT,
  });
  return rows.map((row) => asAdminAuthor(presentAnnouncement(row)));
}

export const announcementService = {
  // --- Global announcements (§4) ---
  async list() {
    return listChannel(await globalChannelId());
  },

  async post(userId: string, role: string, input: PostAnnouncementInput) {
    const channelId = await globalChannelId();
    if (role !== 'SUPER_ADMIN') {
      const m = await prisma.channelMembership.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { role: true },
      });
      if (m?.role !== 'ADMIN' && m?.role !== 'MODERATOR') {
        throw Forbidden('Only super admins and announcement admins can post announcements');
      }
    }
    return broadcast(channelId, userId, input);
  },

  // --- Branch announcements (§3) — super admin or that branch's admin ---
  async listBranch(branchId: string) {
    return listChannel(await branchChannelId(branchId));
  },

  async postBranch(userId: string, role: string, branchId: string, input: PostAnnouncementInput) {
    if (role !== 'SUPER_ADMIN') {
      const bm = await prisma.branchMembership.findUnique({
        where: { userId_branchId: { userId, branchId } },
        select: { role: true },
      });
      if (bm?.role !== 'ADMIN') {
        throw Forbidden('Only super admins and branch admins can post branch announcements');
      }
    }
    return broadcast(await branchChannelId(branchId), userId, input);
  },

  // --- Announcement-admin management (Super Admin only, PRD §4) ---
  async listAdmins() {
    const channelId = await globalChannelId();
    const rows = await prisma.channelMembership.findMany({
      where: { channelId, role: { in: ['ADMIN', 'MODERATOR'] } },
      select: { role: true, user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } },
    });
    return rows.map((r) => ({ ...r.user, role: r.role }));
  },

  async grantAdmin(userId: string) {
    const channelId = await globalChannelId();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw NotFound('User not found');
    await prisma.channelMembership.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId, role: 'ADMIN' },
      update: { role: 'ADMIN' },
    });
    joinChannelRoom(userId, channelId);
    return { ok: true };
  },

  async revokeAdmin(userId: string) {
    const channelId = await globalChannelId();
    await prisma.channelMembership.updateMany({ where: { userId, channelId }, data: { role: 'MEMBER' } });
    return { ok: true };
  },
};

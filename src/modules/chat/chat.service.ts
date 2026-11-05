import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/db';
import { channelService } from '../channels/channels.service';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { emitToChannel } from '../../infra/realtime';
import { logger } from '../../infra/logger';
import { BadRequest, NotFound, Forbidden } from '../../utils/errors';
import { optimizeImage, thumbUrl } from '../../utils/cloudinaryUrl';
import { moderationService } from '../moderation/moderation.service';
import { asAdminAuthor, isAnnouncementChannel } from '../../utils/adminAuthor';
import { announcementPushCopy } from '../announcements/announcementPushCopy';
import type { SendMessageInput, ListMessagesInput } from './chat.schema';

const POLL_SELECT = {
  id: true,
  question: true,
  allowMultiple: true,
  expiresAt: true,
  options: {
    orderBy: { order: 'asc' as const },
    select: {
      id: true,
      text: true,
      order: true,
      votes: { select: { userId: true } },
    },
  },
};

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  senderId: true,
  type: true,
  title: true,
  body: true,
  mediaUrl: true,
  clientMessageId: true,
  replyToId: true,
  forwardedFromId: true,
  pinnedById: true,
  pinnedAt: true,
  createdAt: true,
  editedAt: true,
  contactName: true,
  contactPhone: true,
  contactEmail: true,
  poll: { select: POLL_SELECT },
  sender: { select: { id: true, displayName: true, avatarUrl: true } },
  reactions: { select: { emoji: true, userId: true } },
  // Reply preview — enough for the client to render "↳ Kwasu: Praying for peace" without a
  // second fetch. deletedAt lets the UI show "message deleted" for a reply whose parent is gone.
  replyTo: {
    select: {
      id: true,
      type: true,
      body: true,
      mediaUrl: true,
      senderId: true,
      deletedAt: true,
      sender: { select: { id: true, displayName: true } },
    },
  },
};

// Attach a small preview URL (image thumb / video poster) so lists render fast on slow networks.
// Applied to every message that leaves the server — REST and socket payloads stay identical.
function withThumb<T extends { mediaUrl: string | null; type: string }>(m: T): T & { thumbUrl: string | null } {
  const mediaUrl = m.type === 'IMAGE' && m.mediaUrl ? optimizeImage(m.mediaUrl) : m.mediaUrl;
  return { ...m, mediaUrl, thumbUrl: thumbUrl(mediaUrl, m.type) };
}

// Keyset cursor over (createdAt, id) — stable even when timestamps collide.
function encodeCursor(m: { createdAt: Date; id: string }) {
  return `${m.createdAt.toISOString()}_${m.id}`;
}
function decodeCursor(c: string): { createdAt: Date; id: string } | null {
  const i = c.lastIndexOf('_');
  if (i < 0) return null;
  const createdAt = new Date(c.slice(0, i));
  const id = c.slice(i + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

function isModerator(role: string, membershipRole: string | undefined) {
  return role === 'SUPER_ADMIN' || membershipRole === 'ADMIN' || membershipRole === 'MODERATOR';
}

type MessagePayload = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

const SEND_RETRY_DELAYS_MS = [150, 500, 1200];
const RETRYABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDbError(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return RETRYABLE_PRISMA_CODES.has(err.code);
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|connection.*closed|connection.*terminated|timeout/i.test(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|connection.*closed|connection.*terminated|timeout/i.test(message);
}

function isUniqueConflict(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function retryDbWrite<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const delayMs = SEND_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRetryableDbError(err)) throw err;
      logger.warn({ err, attempt: attempt + 1, delayMs }, 'chat send transient DB failure; retrying');
      await sleep(delayMs);
    }
  }
}

async function findExistingSentMessage(userId: string, channelId: string, messageId: string, clientMessageId?: string) {
  return prisma.message.findFirst({
    where: clientMessageId ? { senderId: userId, channelId, clientMessageId } : { id: messageId, senderId: userId, channelId },
    select: MESSAGE_SELECT,
  });
}

function notifyMessageFanout(
  channelId: string,
  channelType: string,
  userId: string,
  message: MessagePayload,
  dto: SendMessageInput,
  announcement = false,
) {
  const senderName = message.sender.displayName ?? 'Someone';
  const jobBase = { channelId, messageId: message.id, senderId: userId, body: message.body };
  if (announcement) {
    const written = message.body?.replace(/\s+/g, ' ').trim() ?? '';
    const headline =
      message.title?.trim() || (written.length > 80 ? `${written.slice(0, 80).trimEnd()}…` : written) || 'Announcement';
    const push = announcementPushCopy({
      title: headline,
      body: message.body,
      imageUrl: message.type === 'IMAGE' ? message.mediaUrl : null,
      fallback:
        message.type === 'VIDEO' ? 'Shared a video' : message.type === 'AUDIO' ? 'Shared audio' : message.type === 'FILE' ? 'Shared a file' : null,
    });
    enqueue(notificationQueue, 'announcement-fanout', {
      channelId,
      messageId: message.id,
      title: push.title,
      body: push.body,
      imageUrl: push.imageUrl,
      excludeUserId: userId,
    });
  } else if (channelType === 'DM') {
    enqueue(notificationQueue, 'dm-notify', { ...jobBase, senderName: message.sender.displayName ?? 'New message' });
  } else {
    enqueue(notificationQueue, 'message-fanout', { ...jobBase, senderName });
  }

  // @mentions — notify the tagged users who are members of this channel (PRD §7).
  // @everyone (mentionEveryone: true) fans out to every non-muted member; the worker resolves
  // the recipient list against ChannelMembership at fan-out time so it stays fresh.
  if (dto.mentionEveryone) {
    enqueue(notificationQueue, 'mention-fanout', {
      channelId, messageId: message.id, senderName, body: message.body,
      everyone: true, excludeUserId: userId,
    });
  } else if (dto.mentions?.length) {
    const targets = [...new Set(dto.mentions)].filter((id) => id !== userId);
    if (targets.length) {
      enqueue(notificationQueue, 'mention-fanout', {
        channelId, messageId: message.id, senderName, body: message.body, targets,
      });
    }
  }
}

export const chatService = {
  async send(userId: string, role: string, channelId: string, dto: SendMessageInput) {
    if (dto.type === 'CONTACT') {
      if (!dto.contactName) throw BadRequest('contactName is required for CONTACT messages');
      if (!dto.contactPhone && !dto.contactEmail) throw BadRequest('contactPhone or contactEmail is required');
    } else if (dto.type === 'POLL') {
      if (!dto.poll) throw BadRequest('poll object is required for POLL messages');
    } else if (!dto.body && !dto.mediaUrl) {
      throw BadRequest('A message needs a body or mediaUrl');
    }

    const messageId = randomUUID();
    const result = await retryDbWrite(async () => {
      const [membership, channel] = await Promise.all([
        channelService.requireMember(userId, role, channelId),
        prisma.channel.findUnique({
          where: { id: channelId },
          select: { isReadOnly: true, type: true, name: true },
        }),
      ]);
      if (!channel) throw NotFound('Channel not found');
      if (channel.isReadOnly && !isModerator(role, membership?.role)) {
        throw Forbidden('This channel is read-only');
      }

      if (dto.replyToId) {
        const parent = await prisma.message.findUnique({
          where: { id: dto.replyToId },
          select: { channelId: true },
        });
        if (!parent || parent.channelId !== channelId) throw BadRequest('Reply target is not in this channel');
      }

      const existing = dto.clientMessageId
        ? await findExistingSentMessage(userId, channelId, messageId, dto.clientMessageId)
        : null;
      if (existing) return { message: existing, channelType: channel.type, channelName: channel.name, created: false };

      try {
        // For POLL messages, create poll + message atomically so retries cannot orphan polls.
        if (dto.type === 'POLL' && dto.poll) {
          const message = await prisma.$transaction(async (tx) => {
            const poll = await tx.poll.create({
              data: {
                question: dto.poll!.question,
                allowMultiple: dto.poll!.allowMultiple,
                expiresAt: dto.poll!.expiresAt ?? null,
                options: { create: dto.poll!.options.map((text, i) => ({ text, order: i })) },
              },
            });
            return tx.message.create({
              data: {
                id: messageId,
                channelId,
                senderId: userId,
                clientMessageId: dto.clientMessageId ?? null,
                type: 'POLL',
                body: dto.poll!.question,
                replyToId: dto.replyToId ?? null,
                pollId: poll.id,
              },
              select: MESSAGE_SELECT,
            });
          });
          return { message, channelType: channel.type, channelName: channel.name, created: true };
        }

        // Store images as right-sized auto-format delivery URLs (originals stay in Cloudinary) so
        // every future read — on any client — downloads a fraction of the bytes.
        const message = await prisma.message.create({
          data: {
            id: messageId,
            channelId,
            senderId: userId,
            clientMessageId: dto.clientMessageId ?? null,
            type: dto.type,
            body: dto.body ?? null,
            mediaUrl: dto.mediaUrl ? (dto.type === 'IMAGE' ? optimizeImage(dto.mediaUrl) : dto.mediaUrl) : null,
            replyToId: dto.replyToId ?? null,
            contactName: dto.contactName ?? null,
            contactPhone: dto.contactPhone ?? null,
            contactEmail: dto.contactEmail ?? null,
          },
          select: MESSAGE_SELECT,
        });
        return { message, channelType: channel.type, channelName: channel.name, created: true };
      } catch (err) {
        if (isUniqueConflict(err)) {
          const existingMessage = await findExistingSentMessage(userId, channelId, messageId, dto.clientMessageId);
          if (existingMessage) return { message: existingMessage, channelType: channel.type, channelName: channel.name, created: false };
        }
        throw err;
      }
    });

    const shown = isAnnouncementChannel({ type: result.channelType, name: result.channelName })
      ? asAdminAuthor(result.message)
      : result.message;
    const decorated = withThumb(shown);
    if (result.created) {
      emitToChannel(channelId, 'message:new', decorated);

      // Fire-and-forget: the sender's response must not block on Redis enqueue. If the enqueue
      // fails, the socket delivery already happened; log and move on. This shaves 10-20ms off
      // the send round trip AND lets the socket emit reach the recipient sooner because we're
      // not holding a Redis connection ahead of it.
      notifyMessageFanout(
        channelId,
        result.channelType,
        userId,
        shown,
        dto,
        isAnnouncementChannel({ type: result.channelType, name: result.channelName }),
      );
    }
    return decorated;
  },

  async list(userId: string, role: string, channelId: string, opts: ListMessagesInput) {
    const [, blockedIds] = await Promise.all([
      channelService.requireMember(userId, role, channelId),
      moderationService.getBlockedIds(userId),
    ]);
    const c = opts.cursor ? decodeCursor(opts.cursor) : null;
    const [rows, channel] = await Promise.all([
      prisma.message.findMany({
        where: {
          channelId,
          deletedAt: null,
          ...(blockedIds.size > 0 ? { senderId: { notIn: [...blockedIds] } } : {}),
          ...(c
            ? { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        select: MESSAGE_SELECT,
      }),
      prisma.channel.findUnique({ where: { id: channelId }, select: { type: true, name: true } }),
    ]);
    const hasMore = rows.length > opts.limit;
    const messages = rows.slice(0, opts.limit);
    const last = messages[messages.length - 1];

    // Read receipts (DM ticks): the peer's lastReadAt tells the client which of my messages they've
    // read. For groups this is null (read state there is per-member, surfaced as unread counts).
    let peerLastReadAt: Date | null = null;
    if (channel?.type === 'DM') {
      const peer = await prisma.channelMembership.findFirst({
        where: { channelId, userId: { not: userId } },
        select: { lastReadAt: true },
      });
      peerLastReadAt = peer?.lastReadAt ?? null;
    }
    const present = isAnnouncementChannel(channel) ? asAdminAuthor : <T,>(message: T) => message;
    return {
      messages: messages.map((message) => withThumb(present(message))),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      peerLastReadAt,
    };
  },

  async getOne(userId: string, role: string, channelId: string, messageId: string) {
    await channelService.requireMember(userId, role, channelId);
    const [message, channel] = await Promise.all([
      prisma.message.findFirst({
        where: { id: messageId, channelId, deletedAt: null },
        select: MESSAGE_SELECT,
      }),
      prisma.channel.findUnique({ where: { id: channelId }, select: { type: true, name: true } }),
    ]);
    if (!message) throw NotFound('Message not found');
    const shown = isAnnouncementChannel(channel) ? asAdminAuthor(message) : message;
    return withThumb(shown);
  },

  async addReaction(userId: string, role: string, messageId: string, emoji: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt) throw NotFound('Message not found');
    await channelService.requireMember(userId, role, msg.channelId);
    await prisma.reaction.upsert({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
      create: { messageId, userId, emoji },
      update: {},
    });
    emitToChannel(msg.channelId, 'reaction:add', { messageId, userId, emoji });
    return { ok: true };
  },

  async removeReaction(userId: string, role: string, messageId: string, emoji: string) {
    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } });
    if (!msg) throw NotFound('Message not found');
    await channelService.requireMember(userId, role, msg.channelId);
    await prisma.reaction.deleteMany({ where: { messageId, userId, emoji } });
    emitToChannel(msg.channelId, 'reaction:remove', { messageId, userId, emoji });
    return { ok: true };
  },

  async setPin(userId: string, role: string, messageId: string, pinned: boolean) {
    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } });
    if (!msg) throw NotFound('Message not found');
    const membership = await channelService.requireMember(userId, role, msg.channelId);
    if (!isModerator(role, membership?.role)) throw Forbidden('Only moderators can pin messages');
    const message = await prisma.message.update({
      where: { id: messageId },
      data: pinned ? { pinnedById: userId, pinnedAt: new Date() } : { pinnedById: null, pinnedAt: null },
      select: MESSAGE_SELECT,
    });
    emitToChannel(msg.channelId, pinned ? 'message:pinned' : 'message:unpinned', { messageId });
    const channel = await prisma.channel.findUnique({ where: { id: msg.channelId }, select: { type: true, name: true } });
    return withThumb(isAnnouncementChannel(channel) ? asAdminAuthor(message) : message);
  },

  async remove(userId: string, role: string, messageId: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, senderId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt) throw NotFound('Message not found');
    const membership = await channelService.requireMember(userId, role, msg.channelId);
    const canDelete = msg.senderId === userId || isModerator(role, membership?.role);
    if (!canDelete) throw Forbidden('You can only delete your own messages');
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), body: null, mediaUrl: null }, // soft delete + scrub content
    });
    emitToChannel(msg.channelId, 'message:deleted', { messageId });
    return { ok: true };
  },

  // Edit your own message (PRD §7). Sets editedAt and broadcasts message:edited.
  async edit(userId: string, messageId: string, body: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, senderId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt) throw NotFound('Message not found');
    if (msg.senderId !== userId) throw Forbidden('You can only edit your own messages');
    const message = await prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: new Date() },
      select: MESSAGE_SELECT,
    });
    const channel = await prisma.channel.findUnique({ where: { id: msg.channelId }, select: { type: true, name: true } });
    const decorated = withThumb(isAnnouncementChannel(channel) ? asAdminAuthor(message) : message);
    emitToChannel(msg.channelId, 'message:edited', decorated);
    return decorated;
  },

  // Forward a message into another channel you can post to (PRD §7). Copies the content and links
  // back via forwardedFromId so the client can render a "Forwarded" label.
  async forward(userId: string, role: string, messageId: string, targetChannelId: string) {
    const src = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, type: true, body: true, mediaUrl: true, deletedAt: true },
    });
    if (!src || src.deletedAt) throw NotFound('Message not found');
    await channelService.requireMember(userId, role, src.channelId); // can read the source
    const membership = await channelService.requireMember(userId, role, targetChannelId); // can post to target
    const target = await prisma.channel.findUnique({ where: { id: targetChannelId }, select: { isReadOnly: true } });
    if (!target) throw NotFound('Target channel not found');
    if (target.isReadOnly && !isModerator(role, membership?.role)) throw Forbidden('Target channel is read-only');

    const message = await prisma.message.create({
      data: {
        channelId: targetChannelId,
        senderId: userId,
        type: src.type,
        body: src.body,
        mediaUrl: src.mediaUrl,
        forwardedFromId: messageId,
      },
      select: MESSAGE_SELECT,
    });
    const channel = await prisma.channel.findUnique({ where: { id: targetChannelId }, select: { type: true, name: true } });
    const decorated = withThumb(isAnnouncementChannel(channel) ? asAdminAuthor(message) : message);
    emitToChannel(targetChannelId, 'message:new', decorated);
    return decorated;
  },

  // Search a channel's messages (PRD §7). Case-insensitive substring on the body.
  async search(userId: string, role: string, channelId: string, q: string) {
    const [, blockedIds] = await Promise.all([
      channelService.requireMember(userId, role, channelId),
      moderationService.getBlockedIds(userId),
    ]);
    const rows = await prisma.message.findMany({
      where: {
        channelId,
        deletedAt: null,
        body: { contains: q, mode: 'insensitive' },
        ...(blockedIds.size > 0 ? { senderId: { notIn: [...blockedIds] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: MESSAGE_SELECT,
    });
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { type: true, name: true } });
    const present = isAnnouncementChannel(channel) ? asAdminAuthor : <T,>(message: T) => message;
    return rows.map((message) => withThumb(present(message)));
  },

  // Vote on a poll option. Respects allowMultiple — if false, moves the vote to the new option.
  async votePoll(userId: string, role: string, messageId: string, optionId: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, type: true, pollId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt || msg.type !== 'POLL' || !msg.pollId) throw NotFound('Poll not found');
    await channelService.requireMember(userId, role, msg.channelId);

    const option = await prisma.pollOption.findUnique({ where: { id: optionId }, select: { pollId: true } });
    if (!option || option.pollId !== msg.pollId) throw BadRequest('Option does not belong to this poll');

    const poll = await prisma.poll.findUnique({ where: { id: msg.pollId }, select: { allowMultiple: true, expiresAt: true } });
    if (poll?.expiresAt && poll.expiresAt < new Date()) throw BadRequest('This poll has expired');

    if (!poll?.allowMultiple) {
      await prisma.pollVote.deleteMany({ where: { option: { pollId: msg.pollId }, userId } });
    }

    await prisma.pollVote.upsert({
      where: { optionId_userId: { optionId, userId } },
      create: { optionId, userId },
      update: {},
    });

    const updated = await prisma.poll.findUnique({ where: { id: msg.pollId }, select: POLL_SELECT });
    emitToChannel(msg.channelId, 'poll:voted', { messageId, poll: updated });
    return updated;
  },

  // Retract a vote from a poll option.
  async retractVote(userId: string, role: string, messageId: string, optionId: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, type: true, pollId: true, deletedAt: true },
    });
    if (!msg || msg.deletedAt || msg.type !== 'POLL' || !msg.pollId) throw NotFound('Poll not found');
    await channelService.requireMember(userId, role, msg.channelId);

    await prisma.pollVote.deleteMany({ where: { optionId, userId } });

    const updated = await prisma.poll.findUnique({ where: { id: msg.pollId }, select: POLL_SELECT });
    emitToChannel(msg.channelId, 'poll:voted', { messageId, poll: updated });
    return updated;
  },
};

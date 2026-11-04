// Official posts are shown as the office, not the person who pressed send.
export const ADMIN_AUTHOR = { id: 'admin', displayName: 'Admin', avatarUrl: null as string | null };

export function isAnnouncementChannel(channel: { type: string; name?: string | null } | null | undefined) {
  if (!channel) return false;
  return channel.type === 'GLOBAL_ANNOUNCEMENT' || (channel.type === 'BRANCH_SECTION' && channel.name === 'Service Updates');
}

type SenderBits = { id: string; displayName: string | null; avatarUrl?: string | null };

function maskSender<T extends SenderBits>(sender: T): T {
  return {
    ...sender,
    id: ADMIN_AUTHOR.id,
    displayName: ADMIN_AUTHOR.displayName,
    ...('avatarUrl' in sender ? { avatarUrl: null } : {}),
  };
}

// Replace the author on a message the wider church can see. The real account stays in the database.
export function asAdminAuthor<
  T extends {
    senderId?: string;
    sender?: SenderBits | null;
    replyTo?: { senderId?: string; sender?: SenderBits | null } | null;
  },
>(message: T): T {
  const replyTo = message.replyTo
    ? {
        ...message.replyTo,
        ...(message.replyTo.senderId !== undefined ? { senderId: ADMIN_AUTHOR.id } : {}),
        ...(message.replyTo.sender ? { sender: maskSender(message.replyTo.sender) } : {}),
      }
    : message.replyTo;
  return {
    ...message,
    ...(message.senderId !== undefined ? { senderId: ADMIN_AUTHOR.id } : {}),
    ...(message.sender ? { sender: maskSender(message.sender) } : {}),
    ...(message.replyTo !== undefined ? { replyTo } : {}),
  };
}

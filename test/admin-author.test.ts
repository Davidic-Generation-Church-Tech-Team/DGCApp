import { describe, expect, it } from 'vitest';
import { ADMIN_AUTHOR, asAdminAuthor, isAnnouncementChannel } from '../src/utils/adminAuthor';

describe('announcement author shown to members', () => {
  it('keeps a normal chat as the real person', () => {
    expect(isAnnouncementChannel({ type: 'BRANCH_SECTION', name: 'Testimony' })).toBe(false);
    expect(isAnnouncementChannel(null)).toBe(false);
  });

  it('treats the global board and Service Updates as official', () => {
    expect(isAnnouncementChannel({ type: 'GLOBAL_ANNOUNCEMENT', name: 'DGC Global Announcement' })).toBe(true);
    expect(isAnnouncementChannel({ type: 'BRANCH_SECTION', name: 'Service Updates' })).toBe(true);
  });

  it('replaces the poster name, photo, and id, including a reply', () => {
    const shown = asAdminAuthor({
      id: 'msg-1',
      body: 'Sunday service is at 8',
      senderId: 'user-ada',
      sender: { id: 'user-ada', displayName: 'Ada Okonkwo', avatarUrl: 'https://cdn.example/ada.jpg' },
      replyTo: {
        senderId: 'user-tunde',
        sender: { id: 'user-tunde', displayName: 'Tunde', avatarUrl: 'https://cdn.example/tunde.jpg' },
      },
    });

    expect(shown.senderId).toBe(ADMIN_AUTHOR.id);
    expect(shown.sender).toEqual({ id: 'admin', displayName: 'Admin', avatarUrl: null });
    expect(shown.replyTo?.senderId).toBe('admin');
    expect(shown.replyTo?.sender).toEqual({ id: 'admin', displayName: 'Admin', avatarUrl: null });
    expect(shown.body).toBe('Sunday service is at 8');
  });
});

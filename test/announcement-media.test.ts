import { describe, expect, it } from 'vitest';
import { presentAnnouncement } from '../src/modules/announcements/announcementMedia';

const photo = 'https://res.cloudinary.com/ph82hmab/image/upload/v1782625723/dgc/flyer.jpg';
const video = 'https://res.cloudinary.com/ph82hmab/video/upload/v1782625723/dgc/recap.mp4';

describe('announcement pictures on a slow line', () => {
  it('returns a phone-sized photo and a small preview', () => {
    const shown = presentAnnouncement({
      type: 'IMAGE',
      mediaUrl: photo,
      attachments: [{ url: photo, type: 'IMAGE' }],
    });
    expect(shown.mediaUrl).toBe(
      'https://res.cloudinary.com/ph82hmab/image/upload/f_auto,q_auto,c_limit,w_1600/v1782625723/dgc/flyer.jpg',
    );
    expect(shown.thumbUrl).toContain('f_auto,q_auto:low,c_limit,w_400');
    expect(shown.thumbUrl).not.toContain('w_1600');
    expect(shown.attachments[0]?.url).toBe(shown.mediaUrl);
    expect(shown.attachments[0]?.thumbUrl).toBe(shown.thumbUrl);
  });

  it('gives a video a poster frame and leaves the file address alone', () => {
    const shown = presentAnnouncement({ type: 'VIDEO', mediaUrl: video, attachments: [{ url: video, type: 'VIDEO' }] });
    expect(shown.mediaUrl).toBe(video);
    expect(shown.thumbUrl).toContain('so_0,f_jpg,q_auto,c_limit,w_400');
    expect(shown.thumbUrl?.endsWith('.jpg')).toBe(true);
  });

  it('does not invent a preview for a text announcement', () => {
    expect(presentAnnouncement({ type: 'TEXT', mediaUrl: null }).thumbUrl).toBeNull();
  });
});

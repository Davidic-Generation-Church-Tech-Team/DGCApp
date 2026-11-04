import { describe, expect, it } from 'vitest';
import { announcementPushCopy } from '../src/modules/announcements/announcementPushCopy';

const photo = 'https://res.cloudinary.com/ph82hmab/image/upload/v1782625723/dgc/flyer.jpg';

describe('announcement push copy', () => {
  it('sends the title and a small copy of the photo', () => {
    const push = announcementPushCopy({ title: 'Sunday service', body: null, imageUrl: photo });
    expect(push.title).toBe('Sunday service');
    expect(push.body).toBeNull();
    expect(push.imageUrl).toBe(
      'https://res.cloudinary.com/ph82hmab/image/upload/f_jpg,q_auto,w_720,c_limit/v1782625723/dgc/flyer.jpg',
    );
  });

  it('keeps the opening of the text under a photo when both were posted', () => {
    const push = announcementPushCopy({
      title: 'Sunday service',
      body: 'Join us at 8am. Come expecting.',
      imageUrl: photo,
    });
    expect(push.body).toBe('Join us at 8am. Come expecting.');
    expect(push.imageUrl).toContain('f_jpg,q_auto,w_720,c_limit');
  });

  it('sends the title and the opening of the text when there is no photo', () => {
    const body = `${'We thank God for His faithfulness this week. '.repeat(8)}See you on Sunday.`;
    const push = announcementPushCopy({ title: 'Midweek note', body, imageUrl: null });
    expect(push.imageUrl).toBeNull();
    expect(push.body!.length).toBeLessThanOrEqual(141);
    expect(push.body!.endsWith('…')).toBe(true);
    expect(push.body!.startsWith('We thank God')).toBe(true);
  });

  it('uses a short stand-in when the post is a video and has no words', () => {
    expect(announcementPushCopy({ title: 'Recap', body: '  ', imageUrl: null, fallback: 'Shared a video' })).toEqual({
      title: 'Recap',
      body: 'Shared a video',
      imageUrl: null,
    });
  });
});

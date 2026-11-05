import { describe, expect, it } from 'vitest';
import { audioRoomLivePush, channelCallPush, directCallPush, prayerWatchPush } from '../src/modules/calls/callPushCopy';

describe('call push names the person who started it', () => {
  it('puts the caller on a direct voice or video call', () => {
    expect(directCallPush('Ada', 'AUDIO')).toEqual({ title: 'Ada started a call', body: 'Voice call' });
    expect(directCallPush('Ada', 'VIDEO')).toEqual({ title: 'Ada started a call', body: 'Video call' });
    expect(directCallPush('  ', 'AUDIO').title).toBe('Someone started a call');
  });

  it('puts the starter on a channel call and keeps the channel in the body', () => {
    expect(channelCallPush('Tunde', 'Ibadan - Youth')).toEqual({
      title: 'Tunde started a call',
      body: 'Ibadan - Youth',
    });
  });

  it('puts the starter on Prayer Watch', () => {
    expect(prayerWatchPush('Grace')).toEqual({ title: 'Grace started a call', body: 'Prayer Watch' });
    expect(prayerWatchPush('').title).toBe('Someone started a call');
  });

  it('puts the host on a live audio room', () => {
    expect(audioRoomLivePush('Seyi', 'Midweek prayer')).toEqual({
      title: 'Seyi started a call',
      body: 'Midweek prayer',
    });
    expect(audioRoomLivePush(null, 'Midweek prayer')).toEqual({
      title: 'Audio room is live',
      body: 'Midweek prayer',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { audioRoomLivePush, channelCallPush, directCallPush, prayerWatchPush } from '../src/modules/calls/callPushCopy';

describe('call push names the person who started it', () => {
  it('puts the caller on a direct voice or video call', () => {
    expect(directCallPush('Ada', 'AUDIO')).toEqual({ title: 'Ada', body: 'Incoming voice call' });
    expect(directCallPush('Ada', 'VIDEO')).toEqual({ title: 'Ada', body: 'Incoming video call' });
    expect(directCallPush('  ', 'AUDIO').title).toBe('Someone');
  });

  it('puts the starter on a channel call and keeps the channel in the body', () => {
    expect(channelCallPush('Tunde', 'Ibadan - Youth')).toEqual({
      title: 'Tunde',
      body: 'Incoming call in Ibadan - Youth',
    });
  });

  it('puts the starter on Prayer Watch', () => {
    expect(prayerWatchPush('Grace')).toEqual({ title: 'Grace', body: 'Prayer Watch is live' });
    expect(prayerWatchPush('').title).toBe('Someone');
  });

  it('puts the host on a live audio room', () => {
    expect(audioRoomLivePush('Seyi', 'Midweek prayer')).toEqual({
      title: 'Seyi',
      body: 'Midweek prayer is live',
    });
    expect(audioRoomLivePush(null, 'Midweek prayer')).toEqual({
      title: 'Audio room is live',
      body: 'Midweek prayer',
    });
  });
});

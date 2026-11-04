// The words on a call push. The title is always the person who started it.

export function callerLabel(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : 'Someone';
}

export function directCallPush(callerName: string, type: 'AUDIO' | 'VIDEO') {
  return {
    title: callerLabel(callerName),
    body: `Incoming ${type === 'VIDEO' ? 'video' : 'voice'} call`,
  };
}

export function channelCallPush(starterName: string, channelName: string) {
  return {
    title: callerLabel(starterName),
    body: `Incoming call in ${channelName}`,
  };
}

export function prayerWatchPush(starterName: string) {
  return {
    title: callerLabel(starterName),
    body: 'Prayer Watch is live',
  };
}

export function audioRoomLivePush(hostName: string | null | undefined, roomTitle: string) {
  const name = hostName?.trim();
  if (!name) return { title: 'Audio room is live', body: roomTitle };
  return { title: name, body: `${roomTitle} is live` };
}

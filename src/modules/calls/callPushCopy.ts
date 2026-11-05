// The words on a call push. The title is the sentence the phone shows: "Emeka started a call".

export function callerLabel(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : 'Someone';
}

function startedCall(name: string) {
  return `${name} started a call`;
}

export function directCallPush(callerName: string, type: 'AUDIO' | 'VIDEO') {
  const name = callerLabel(callerName);
  return {
    title: startedCall(name),
    body: type === 'VIDEO' ? 'Video call' : 'Voice call',
  };
}

export function channelCallPush(starterName: string, channelName: string) {
  return {
    title: startedCall(callerLabel(starterName)),
    body: channelName,
  };
}

export function prayerWatchPush(starterName: string) {
  return {
    title: startedCall(callerLabel(starterName)),
    body: 'Prayer Watch',
  };
}

export function audioRoomLivePush(hostName: string | null | undefined, roomTitle: string) {
  const name = hostName?.trim();
  if (!name) return { title: 'Audio room is live', body: roomTitle };
  return { title: startedCall(name), body: roomTitle };
}

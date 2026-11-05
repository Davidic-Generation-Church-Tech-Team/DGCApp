# DM Calls Frontend Implementation Guide

This guide is for implementing WhatsApp-style 1:1 DM calls in the React Native app.

The backend handles call signaling, call history, busy checks, missed-call timeouts, notifications, and Agora token generation. Agora handles the actual audio/video transport.

The backend supports both `AUDIO` and `VIDEO` calls. Ship voice-first by sending `AUDIO`; the response shape already supports video later.

## Requirements

- Authenticated REST requests use:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

- Socket.io connects to the API root host, not `/api/v1`:

```ts
io(API_ROOT_URL, {
  auth: { token: accessToken },
  transports: ['websocket'],
});
```

- Agora SDK should join using the `agora` object returned by the backend:

```ts
type AgoraCredentials = {
  appId: string | null;
  token: string | null;
  channel: string;
  uid: number;
  media: {
    audio: true;
    video: boolean;
  };
};
```

If `appId` or `token` is `null`, Agora is not configured in that environment. The UI can still test signaling, but media will not connect.

## Call Object

REST and socket call payloads use this shape:

```ts
type DmCall = {
  id: string;
  channelId: string;
  callerId: string;
  calleeId: string;
  type: 'AUDIO' | 'VIDEO';
  status: 'RINGING' | 'ANSWERED' | 'DECLINED' | 'MISSED' | 'ENDED' | 'CANCELLED' | 'FAILED';
  agoraChannel: string;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedById: string | null;
  durationMs: number | null;
  callerName: string; // flat name for the incoming screen. Same value as caller.displayName, or "Someone"
  callerAvatarUrl: string;
  caller: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  callee: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  direction: 'OUTGOING' | 'INCOMING';
  ringingExpiresAt: string;
};
```

Some REST responses include:

```ts
type CallWithAgora = DmCall & {
  agora: AgoraCredentials;
};
```

## REST APIs

### 1. Start A DM Call

```http
POST /api/v1/dms/:channelId/calls
```

Body:

```json
{
  "type": "AUDIO"
}
```

Use `"VIDEO"` later when the UI supports video.

Success response: `201`

```ts
CallWithAgora
```

Frontend behavior:

- Show outgoing ringing UI immediately.
- Join Agora using `response.agora`.
- Enable microphone publishing for `AUDIO`.
- For `VIDEO`, enable camera publishing if/when video UI ships.
- Listen for `call:answered`, `call:declined`, `call:ended`, and `call:busy`.

Busy response: `409`

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "User is already on another call"
  }
}
```

or:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "You are already on another call"
  }
}
```

### 2. List Call History In A DM

```http
GET /api/v1/dms/:channelId/calls?limit=30&cursor=<nextCursor>
```

Response:

```ts
{
  calls: DmCall[];
  nextCursor: string | null;
}
```

Use this in the DM detail/history view. Calls are returned newest first.

### 3. Answer Incoming Call

```http
POST /api/v1/calls/:callId/answer
```

Response:

```ts
CallWithAgora
```

Frontend behavior:

- Stop ringing UI.
- Join Agora with `response.agora`.
- Show active call UI.
- Both caller and callee receive `call:answered`.

### 4. Decline Incoming Call

```http
POST /api/v1/calls/:callId/decline
```

Response:

```ts
DmCall
```

Frontend behavior:

- Close incoming ringing UI.
- Both users receive `call:declined`.

### 5. End Or Cancel A Call

```http
POST /api/v1/calls/:callId/end
```

Use this for:

- Either user hanging up an answered call.
- Caller cancelling an outgoing still-ringing call.

Response:

```ts
DmCall
```

Frontend behavior:

- Leave Agora.
- Close active/ringing call UI.
- Both users receive `call:ended`.
- If the caller cancels while the call is still ringing, the server also drops the incoming push when it has not gone out yet. Close the incoming screen on `call:ended` even if a push arrives a moment later. Do not start the call again.

Possible final statuses:

- `ENDED`: answered call was hung up.
- `CANCELLED`: caller cancelled before answer.
- `MISSED`: backend timeout marked it missed.

### 6. Refresh Agora Token

```http
POST /api/v1/calls/:callId/token
```

Response:

```ts
AgoraCredentials
```

Call this before Agora token expiry if a call lasts a long time. Current token lifetime is about 1 hour, so refreshing around 50-55 minutes is safe.

## Socket Events

All socket events are server-to-client. Clients do not need to emit call lifecycle events directly; use REST APIs for state changes.

### `call:incoming`

Sent to the callee when someone starts a call.

```ts
DmCall
```

Frontend behavior:

- Show incoming call screen.
- Start ringtone/vibration.
- Provide Answer and Decline buttons.
- If user taps Answer, call `POST /api/v1/calls/:callId/answer`.
- If user taps Decline, call `POST /api/v1/calls/:callId/decline`.

### `call:ringing`

Sent to the caller's devices after a call is created.

```ts
DmCall
```

Frontend behavior:

- Sync outgoing ringing UI across caller devices.

### `call:busy`

Sent to the caller if either side is already in a live call.

```ts
{
  channelId: string;
  userId: string;
  activeCallId: string;
  selfBusy: boolean;
}
```

Frontend behavior:

- Close outgoing ringing UI.
- Show "User is already on another call" or "You are already on another call".

### `call:answered`

Sent to both participants after the callee answers.

```ts
CallWithAgora
```

Frontend behavior:

- Caller should switch from ringing UI to active call UI and may join Agora with `event.agora` if it did not already join from the start-call REST response.
- Callee should already be joining Agora from the answer response.

### `call:declined`

Sent to both participants after the callee declines.

```ts
DmCall
```

Frontend behavior:

- Stop ringtone/ringback.
- Leave Agora if joined.
- Close call UI.

### `call:ended`

Sent to both participants when the call ends, is cancelled, or is missed.

```ts
DmCall
```

Frontend behavior:

- Stop ringtone/ringback.
- Leave Agora.
- Close call UI.
- If `status === 'MISSED'`, show missed-call state if appropriate.

## Push Payload

Incoming calls are sent as high-priority FCM pushes to the callee.

The data payload includes string values similar to:

```ts
type IncomingCallPushData = {
  type: 'call';
  notificationType: 'CALL';
  callAction: 'incoming';
  callId: string;
  channelId: string;
  callType: 'AUDIO' | 'VIDEO';
  status: 'RINGING';
  agoraChannel: string;
  callerId: string;
  calleeId: string;
  title: string; // "Ada started a call" — this is the notification headline
  body: string; // "Voice call" or "Video call"
  callerName: string;
  callerAvatarUrl: string;
  createdAt: string;
  expiresAt: string;
  priority: 'high';
  clickAction: 'INCOMING_CALL';
  androidChannelId: 'calls';
  androidFullScreenIntent: 'true';
  androidForegroundService: 'true';
  iosCallKit: 'true';
  iosPushType: 'voip';
};
```

FCM data values arrive as strings. Convert booleans manually.

Android implementation notes:

- Create a notification channel with ID `calls`.
- Use `clickAction === 'INCOMING_CALL'` to open the incoming call screen.
- Use `androidFullScreenIntent === 'true'` for full-screen incoming call UI.
- Use `androidForegroundService === 'true'` for ringing/call service behavior while the app is backgrounded or killed.
- Stop ringtone/full-screen UI when `expiresAt` passes or when a socket/REST update ends the call.

iOS implementation notes:

- Foreground/background regular FCM can show the incoming call UI.
- True killed-state call ringing on iOS requires PushKit VoIP pushes + CallKit + Apple VoIP push certificate setup.
- The backend payload already includes `iosCallKit=true`, `iosPushType=voip`, `callId`, caller fields, and call type so the same data contract can be used when the iOS VoIP flow is connected.

## Recommended Frontend State Machine

Use one active call store, keyed by `call.id`.

States:

- `idle`
- `incoming`
- `outgoing`
- `connecting`
- `active`
- `ending`
- `ended`

Transitions:

- `POST /dms/:channelId/calls` success: `idle -> outgoing`
- `call:incoming`: `idle -> incoming`
- Answer tapped: `incoming -> connecting`
- Answer response success: `connecting -> active`
- `call:answered`: `outgoing -> active`
- Decline tapped or `call:declined`: `incoming/outgoing -> ended`
- Hang up tapped or `call:ended`: `incoming/outgoing/active -> ended`
- `call:busy`: `outgoing -> ended`
- `ringingExpiresAt` reached locally: stop ringing UI; backend will mark missed

Always call `POST /calls/:callId/end` when the local user hangs up. Always leave the Agora channel when moving to `ended`.

## Agora Join Flow

Before joining:

- Request and confirm Android `RECORD_AUDIO` permission.
- Use the same `appId`, `token`, `channelName`, and numeric `uid` returned in `agora`.
- For DM calls, use Agora communication mode/profile if your SDK exposes it.
- Enable audio, unmute local audio, and publish as a broadcaster/host if your SDK is using live-broadcast profile.
- Do not join with `uid = 0`; use the backend `agora.uid`.
- Log `onJoinChannelSuccess`, `onUserJoined`, `onUserMuteAudio`, `onRemoteAudioStateChanged`, `onLocalAudioStateChanged`, and token errors while testing.

Caller:

```ts
const call = await api.post<CallWithAgora>(`/dms/${channelId}/calls`, {
  type: 'AUDIO',
});

await agora.joinChannel({
  appId: call.agora.appId,
  token: call.agora.token,
  channelName: call.agora.channel,
  uid: call.agora.uid,
});
```

If the caller waits until the callee answers:

```ts
socket.on('call:answered', async (call: CallWithAgora) => {
  await agora.joinChannel({
    appId: call.agora.appId,
    token: call.agora.token,
    channelName: call.agora.channel,
    uid: call.agora.uid,
  });
});
```

Callee:

```ts
const call = await api.post<CallWithAgora>(`/calls/${incomingCall.id}/answer`);

await agora.joinChannel({
  appId: call.agora.appId,
  token: call.agora.token,
  channelName: call.agora.channel,
  uid: call.agora.uid,
});
```

Hang up:

```ts
await api.post(`/calls/${call.id}/end`);
await agora.leaveChannel();
```

Decline:

```ts
await api.post(`/calls/${call.id}/decline`);
```

## UI Checklist

- DM header has voice call button now.
- Video button can be hidden for launch, but backend supports `type: 'VIDEO'`.
- Incoming call screen shows `callerName` (or `data.callerName` / `data.title` from the push) and the avatar, plus Answer and Decline. Do not hardcode "Incoming call". On iPhone CallKit, pass `callerName` as `localizedCallerName`.
- Outgoing call screen shows peer name/avatar, Ringing, Cancel.
- Active call screen shows mute, speaker, hang up, duration.
- Stop all ringing/ringback audio on decline, answer, end, missed, timeout, logout, or socket disconnect cleanup.
- Call history renders by `status`, `direction`, and `durationMs`.
- Handle `409 CONFLICT` as busy state.
- Handle `400 BAD_REQUEST` as stale call state and close the call UI.

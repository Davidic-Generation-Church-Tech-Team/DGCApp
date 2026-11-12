# Station calls: frontend implementation guide

This is the contract for Prayer Watch and channel calls on phones that send `preferPlayback: true`. Give this file to the app agent. Implement this. Do not invent a second flow.

The backend is already deployed. The phone talks only to the existing API (live host `https://dgc-backend-bo80.onrender.com`). Chat, direct calls, and named `GENERAL` rooms do not change.

Current store builds omit `preferPlayback`. They stay speakers on Agora, as `CALLS_AND_PRESENCE_FRONTEND_GUIDE.md` part 1 describes. This guide is the store update. Until this build ships, the Agora bill does not drop.

## What the member experiences

Same idea as a Telegram channel call.

- Starting a call does not pull the channel in. Only the starter is in the call, with the mic open. Everyone else gets a ring or a banner. That notice is not membership.
- A member who has not tapped Join does not hear the call and has no mute button. The banner does not play audio.
- Join puts them in the call, muted. They hear the station. They can mute and unmute only after this.
- Unmute opens a free mic. They then hear the other speakers live. Mute puts the mic down. They stay in the call and hear the station again.
- Leave removes only that person. The call ends when the last person who joined leaves, or when someone who is allowed ends it.

People on a mic hear each other immediately. People who are muted hear the same voices about 10 to 15 seconds later. Do not try to remove that delay. Do not tell the user the station is real-time.

## Do not

- Do not call `video.bunnycdn.com`, Agora's REST API, or any ingest URL. The phone never sees a stream key, a Bunny AccessKey, an Agora customer secret, or an Agora app certificate.
- Do not autoplay `live.playbackUrl` from the banner or from a status poll. Play it only after a successful Join, or when a later event in this guide tells you to.
- Do not join Agora when `role` is `LISTENER` and `agora` is null. A null station link is not a reason to fall back to Agora.
- Do not play `playbackUrl` while you hold a mic. Speakers stay on Agora only.
- Do not run Agora and the station player at the same time.
- Do not mute by only silencing the local Agora track. That leaves the paid line open. The mute button calls `POST /mic`.
- Do not send `preferPlayback` as the string `"true"`, `1`, or `"1"`. The server accepts only the JSON boolean `true`. Anything else joins every person as a speaker.
- Do not use `POST /participants/:userId/unmute` to take a mic. A listener who calls it gets "Listener has no active mic to unmute".
- Do not use raise-hand, step-down, or audience tokens on these two call types. Those remain for named `GENERAL` rooms.
- Do not change direct calls. Do not send this body to a DM call.
- Do not render `listeners.length` as the crowd. That array is capped at 30. Use `listenerCount`.
- Do not use the socket event `title` as a person's name. On `audio-room:incoming`, the person is `callerName` (same value as `startedByName`). The push title is "{name} started a call". `callerName` is only the name.

## The two audio paths

| Path | Who | What the phone does |
|---|---|---|
| Agora | Starter, super admin, branch admin, cluster moderator, channel admin or moderator, and a member who has unmuted | `react-native-agora`. Join with `appId`, `token`, `channel`, `uid` from the server. Publish the microphone. |
| Station | A member who joined with `preferPlayback: true` and is still muted | `expo-av` or `react-native-video`. Play `playbackUrl`. It is an ordinary public HLS URL (`.m3u8`). No playback token. |

`channel` inside `agora` is the **audio room id**, not the chat channel id. `uid` is a number. Pass that exact number into `joinChannel`. Do not pass `0`, and do not generate another uid. Match speaking indicators to `speakers[].agoraUid`.

Use `ChannelProfileLiveBroadcasting`. A mic holder joins as `ClientRoleBroadcaster` with the microphone published and the camera off. The station-down subscriber path joins as `ClientRoleAudience` with the microphone not published. Leave the channel before switching roles.

Tokens last 60 minutes. While you are a speaker, call `POST /api/v1/audio-rooms/:roomId/token` before the hour is up (around 50 minutes) and again after the socket reconnects.

## Local state

Keep one object for the call that is on screen:

```ts
type CallMode = 'speaking' | 'listening' | 'silent';

type LiveCall = {
  roomId: string;
  chatChannelId: string | null; // from the channel screen, or from GET /prayer-watch
  role: 'HOST' | 'SPEAKER' | 'LISTENER';
  mode: CallMode;
  playbackUrl: string | null;
  listenerCount: number;
  speakers: Speaker[];
  viewer: { canModerate: boolean; canEnd: boolean };
};
```

- `speaking`: Agora publisher, mic open, station player stopped.
- `listening`: station player running, Agora left, mic shown as off, person is still in the call.
- `silent`: in the call, mic off, station link is null, Agora left. Show "The station is not up yet."

`chatChannelId` is the chat channel. `roomId` is the call. Do not mix them up when joining Agora.

## One function for every audio response

Use this for start, join, and a successful unmute. Do not copy the branches into each screen.

```ts
function applyAudio(body: {
  role: 'HOST' | 'SPEAKER' | 'LISTENER';
  playbackUrl: string | null;
  agora: { appId: string | null; token: string | null; channel: string; uid: number } | null;
}) {
  live.role = body.role;
  live.playbackUrl = body.playbackUrl;

  const token = body.agora?.token;
  if (token && body.agora) {
    stopStation();
    joinAgoraAsPublisher(body.agora); // mic published, not locally muted
    live.mode = 'speaking';
    return;
  }

  leaveAgora();
  if (body.role === 'LISTENER' && body.playbackUrl) {
    playStation(body.playbackUrl); // live edge, no scrubber
    live.mode = 'listening';
    return;
  }

  stopStation();
  live.mode = 'silent';
}
```

`joinAgoraAsPublisher` must leave any previous Agora channel first. `playStation` must leave Agora first. If the new URL equals the URL already playing, leave the player alone.

## Auth and errors

Every request uses the same access token as the rest of the app.

Errors are HTTP JSON:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Join the call before using the mic" } }
```

Branch on `error.message` for the sentences in the error table. `401` means refresh the access token and retry once.

`POST /mic` validates the body. `hold` must be a boolean. A wrong type comes back as `400` with Zod's message, not as a mic result.

## Seeing that a call is live

These do not start audio and do not join the call.

`GET /api/v1/prayer-watch`

```json
{
  "channelId": "chat-channel-id",
  "live": {
    "id": "room-id",
    "title": "Global Prayer Watch",
    "hostId": "user-id",
    "playbackUrl": "https://.../playlist.m3u8",
    "startedAt": "2026-11-12T10:00:00.000Z",
    "createdAt": "2026-11-12T10:00:00.000Z"
  }
}
```

`live` is `null` when no Prayer Watch call is up. `playbackUrl` may be `null` while the call is still live. Show the banner either way. Do not play the URL.

`GET /api/v1/channels/:channelId/call`

```json
{
  "channelId": "chat-channel-id",
  "live": {
    "id": "room-id",
    "title": "Youth Call",
    "channelId": "chat-channel-id",
    "hostId": "user-id",
    "playbackUrl": "https://.../playlist.m3u8",
    "startedAt": "2026-11-12T10:00:00.000Z",
    "createdAt": "2026-11-12T10:00:00.000Z"
  }
}
```

Call this when the channel screen opens and when it comes back into view. Hide the banner when `live` is `null`.

## Start

Channel:

`POST /api/v1/channels/:channelId/call/start`

```json
{ "preferPlayback": true }
```

Status `201`. If a call is already live, this joins it and `alreadyLive` is `true`. The caller is not the starter in that case. Read `role` from the body. Do not assume `HOST`.

Prayer Watch:

`POST /api/v1/prayer-watch/start`

```json
{ "preferPlayback": true }
```

Status `201`. Same `alreadyLive` rule. A second start attaches to the call that is already up.

Both responses are the room detail below, plus:

```json
{
  "role": "HOST",
  "playbackUrl": "https://.../playlist.m3u8",
  "agora": { "appId": "…", "token": "…", "channel": "room-id", "uid": 123456 },
  "alreadyLive": false
}
```

The starter always gets `role: "HOST"` and an `agora` object on a brand-new call. Call `applyAudio`. Open the call screen. Do not show the starter the incoming screen.

`playbackUrl` on this response is for later, when this person mutes. Do not play it now.

## Join

Use this when the member taps Join on the banner, the incoming screen, or the push.

`POST /api/v1/audio-rooms/:roomId/join`

```json
{ "preferPlayback": true }
```

Status `200`. There is no `alreadyLive` field on this route.

A member receives:

```json
{
  "role": "LISTENER",
  "playbackUrl": "https://.../playlist.m3u8",
  "agora": null
}
```

plus the room detail. Call `applyAudio`. Open the call screen. The mic button is visible and shows muted.

A starter rejoining, a super admin, a branch admin, a cluster moderator, or a channel admin or moderator receives `role` `HOST` or `SPEAKER`, `agora` set, and must take the speaking path. There is no separate pastor role. The pastor is a super admin.

If `playbackUrl` is `null` and `agora` is `null`, still open the call screen, stay muted, and show "The station is not up yet." Do not join Agora.

Tapping Join again while already muted is safe. The server returns the listening payload again. Tapping Join while already a speaker returns "Already in this room". Fetch the room and `POST /token`, then keep the call screen.

## Room detail

`GET /api/v1/audio-rooms/:roomId` returns the same detail that start and join spread in. It does not include `role` or `agora`. Remember the role from the join response and from mic and socket updates.

```json
{
  "id": "room-id",
  "title": "Youth Call",
  "description": "Live call in Youth",
  "channelId": "chat-channel-id",
  "branchId": null,
  "clusterId": null,
  "hostId": "starter-user-id",
  "status": "LIVE",
  "scheduledFor": null,
  "startedAt": "2026-11-12T10:00:00.000Z",
  "endedAt": null,
  "createdAt": "2026-11-12T10:00:00.000Z",
  "playbackUrl": "https://.../playlist.m3u8",
  "host": { "id": "starter-user-id", "displayName": "Ada", "avatarUrl": null },
  "speakerCount": 2,
  "listenerCount": 140,
  "totalParticipants": 142,
  "speakers": [
    {
      "id": "participant-row-id",
      "userId": "starter-user-id",
      "role": "HOST",
      "joinedAt": "2026-11-12T10:00:00.000Z",
      "agoraUid": 123456,
      "user": { "id": "starter-user-id", "displayName": "Ada", "avatarUrl": null }
    }
  ],
  "listeners": [],
  "isReminding": false,
  "viewer": { "canModerate": false, "canEnd": false }
}
```

- `host` is null once the starter has left. The "Started the call" badge compares `userId` to `hostId`.
- `speakers` is everyone who can talk. Show this list on the call screen.
- `listeners` is at most 30 muted members, for a small preview if you want names. The congregation size is `listenerCount`.
- `totalParticipants` is speakers plus listeners. The call is not empty because `speakers` is short.
- `viewer.canModerate` shows Mute, Mute all, and Remove.
- `viewer.canEnd` shows End for everyone. On a channel call the last person also gets `canEnd`. On Prayer Watch, End is for the starter and for admins and moderators. An ordinary last member ends Prayer Watch by leaving, which ends it for everyone.
- Refetch this when the app returns to the foreground, when the user's channel role changes, and when a speaker event arrives without a display name.

Prayer Watch `channelId` on the room is often null. Keep the `channelId` from `GET /prayer-watch` for chat. Do not expect it on the room.

## Mute and unmute

Only after Join has succeeded.

Unmute (take a free mic):

`POST /api/v1/audio-rooms/:roomId/mic`

```json
{ "hold": true }
```

Success:

```json
{
  "ok": true,
  "role": "SPEAKER",
  "playbackUrl": "https://.../playlist.m3u8",
  "agora": { "appId": "…", "token": "…", "channel": "room-id", "uid": 123456 }
}
```

Call `applyAudio`. The server also emits `audio-room:token` to this user. Acting on the HTTP body is enough. Do not join Agora twice.

At most three members can hold a free mic besides the starter and the admins. A fourth stays muted and the button shows "All free mics are in use." Admins are not counted in those three. Do not disable the button from a local guess. Send the request and show the error.

If this user is already `HOST` or `SPEAKER`, the same call refreshes the publisher token. Apply it. Do not also start the station.

Mute (put the mic down, stay in the call):

```json
{ "hold": false }
```

Success when the station is up:

```json
{
  "ok": true,
  "role": "LISTENER",
  "playbackUrl": "https://.../playlist.m3u8",
  "agora": null
}
```

Leave Agora, then play `playbackUrl`. Stay on the call screen. Show the mic as off. The person is still in the call.

If they were already a listener, the same body comes back and you change nothing.

The last unmuted person cannot mute. The error is "The last person on the call keeps the mic". Leave the mic open. They can Leave, or End if `viewer.canEnd` is true.

If `hold: false` returns `playbackUrl: null`, the station is down. Leave the Agora publisher so the paid line closes, then immediately:

`POST /api/v1/audio-rooms/:roomId/token`

That response is flat. It is not wrapped in `agora`.

```json
{
  "appId": "…",
  "token": "…",
  "channel": "room-id",
  "uid": 123456,
  "playbackUrl": null,
  "role": "LISTENER"
}
```

If `token` is set, join Agora as a subscriber only. Do not publish. Show the mic as off. This is how they still hear the speakers when the station failed. If `token` is null, stay in `silent`.

Do this token follow-up only when the mute response has no playback URL. When a URL is present, do not join Agora.

Calling `/mic` before Join returns "Join the call before using the mic". Keep the mic control disabled until Join returns.

## Moderator controls

Show these only when `viewer.canModerate` is true.

| Action | Request | What the target phone does |
|---|---|---|
| Mute one free mic | `POST /api/v1/audio-rooms/:roomId/participants/:userId/mute` | They stay in the call. If the station is up they receive `audio-room:playback` and must leave Agora and play it. They also receive `audio-room:muted`. |
| Mute all free mics | `POST /api/v1/audio-rooms/:roomId/mute-all` | Same, for each id in the `audio-room:all-muted` payload. The actor keeps their mic. Protected mics stay up. At least one speaker remains. |
| Remove | `DELETE /api/v1/audio-rooms/:roomId/participants/:userId` | Target receives `audio-room:kicked`. They leave Agora, stop the player, close the call screen, and show "You were removed from the call". |

Mute of the starter, a super admin, or another admin or moderator returns `403` "You cannot take this mic". Show that sentence. Do not change their row.

`unmute` does not give a listener a mic. Ignore it for this build on Prayer Watch and channel calls.

A moderator mute while the station is down does not change the role. The target receives `audio-room:muted` with `{ roomId, mutedBy }` and must set Agora's local mic off and keep the Agora channel. Speakers receive `audio-room:user-muted` with `{ roomId, userId, mutedBy }` and show a muted icon. That icon is not the same as `role: LISTENER`.

## Leave and end

Leave, always available:

`POST /api/v1/audio-rooms/:roomId/leave`

Then leave Agora, stop the player, and close the call screen. The call continues for everyone else unless this person was the last one in it. "Not in this room" still means close the screen.

If the only person with a mic leaves while muted members remain, the server hands the mic to the longest-present admin, otherwise the longest-present member. The person who receives it is told by `audio-room:token`. Handle that event. Do not build a second handoff in the app.

End for everyone, only when `viewer.canEnd` is true. Ask "End the call for everyone?" first.

`POST /api/v1/audio-rooms/:roomId/end`

Use that route for the button on the call screen, including Prayer Watch. Do not send that button to `POST /api/v1/prayer-watch/:roomId/end`. That second route is only a Prayer Warriors cluster moderator or a super admin, and a branch admin who is not in that cluster gets 403.

When the last person leaves, the server ends the call itself. You do not need a second request.

On any end, `audio-room:ended` arrives. Stop audio and close every call and ringing screen for that `roomId`.

## Token refresh

`POST /api/v1/audio-rooms/:roomId/token`

Speakers get a flat publisher token plus `playbackUrl` and `role`. Renew Agora with it. Do not start the player.

A muted member, while the station is up, gets:

```json
{
  "appId": null,
  "token": null,
  "channel": "room-id",
  "uid": 123456,
  "playbackUrl": "https://.../playlist.m3u8",
  "role": "LISTENER"
}
```

Do not join Agora. If `playbackUrl` changed and you are already playing this room, swap the player.

"Not in this room" means you were removed. Tear the call down.

## Socket events

The app does not emit anything to subscribe. The server puts sockets in rooms. Stay connected the whole time the app is open, and send the presence heartbeat every 60 seconds, including during a call. If the heartbeat stops for about 2 minutes, the server treats the user as gone and removes them within about 5 minutes. Call Leave when the call screen closes for any reason, including back and unmount.

People who are muted are in the call in the database. They are not in the speaker socket. They do not receive `audio-room:user-joined`, `audio-room:user-left`, `audio-room:role-changed`, `audio-room:listeners`, `audio-room:state`, `audio-room:user-muted`, or `audio-room:all-muted`. That is intentional. A listener refreshes the room with GET when the call screen opens and when the app foregrounds. Do not poll faster than every 30 seconds.

### Events a muted member does receive

| Event | Where it arrives | What to do |
|---|---|---|
| `audio-room:playback` `{ roomId, playbackUrl }` | Your user socket, when you mute or a moderator returns you to the station | If `roomId` is the call you are in: leave Agora, play `playbackUrl`, set role `LISTENER`, mode `listening`, stay on the call screen. |
| `audio-room:playback` `{ roomId, playbackUrl }` | The channel socket, about every 11 hours | Swap the player only if you are already playing that `roomId`. If you have not joined, ignore it. If you are on a mic, you will not receive this one. |
| `audio-room:token` `{ roomId, appId, token, channel, uid }` | Your user socket | If you are listening or silent in that room, you have been given the mic. Stop the player, join Agora as a publisher, set role `SPEAKER`, mode `speaking`, mic open. Then reconnect the socket once. |
| `audio-room:muted` `{ roomId, mutedBy }` | Your user socket | If you are already switching to the station because of `playback`, ignore the Agora mute. If you are still a speaker because the station is down, turn the local Agora mic off and show muted. |
| `audio-room:kicked` `{ roomId }` | Your user socket | Leave Agora, stop the player, close the screen, show "You were removed from the call". |
| `audio-room:ended` `{ roomId, channelId? }` | The channel socket | If `roomId` is the call you are playing, ringing, or showing, stop audio and close those screens. Show "Call ended". |
| `audio-room:incoming` | The channel socket | Show the incoming screen. You are not in the call yet. |

The reconnect after `audio-room:token` is required. The server updates your row to `SPEAKER` and sends the token, but it does not put your socket into the speaker room on that path. After reconnect, the server sees the speaker row, joins the room, and emits `audio-room:state`. Replace the speaker list with that state. A voluntary unmute via `POST /mic` does put the socket in the room, so that path does not need a reconnect.

### Events only speakers receive

| Event | Payload | What to do |
|---|---|---|
| `audio-room:user-joined` | `{ id, userId, role, agoraUid, user? }` | Add them to `speakers` if `role` is `HOST` or `SPEAKER`. A join of a speaker from the server includes `user`. An unmute often does not. If `user` is missing, GET the room once and replace `speakers`. |
| `audio-room:user-left` | `{ roomId, userId }` | Remove that user from `speakers` if present. Do not change `listenerCount` from this event. A swept listener also emits this, and they were never on the speaker list. |
| `audio-room:role-changed` | `{ roomId, userId, role }` | `LISTENER`: remove them from `speakers`. They are still in the call. `SPEAKER` or `HOST`: add or update them, then GET if you have no name. |
| `audio-room:listeners` | `{ roomId, listenerCount }` | Replace the congregation count. Do not add a row per listener. |
| `audio-room:user-muted` | `{ roomId, userId, mutedBy }` | Muted icon. On a live station this arrives together with `role-changed` `LISTENER`. The role change is what moves them off the mic list. |
| `audio-room:all-muted` | `{ roomId, mutedBy, userIds }` | Same for each id. |
| `audio-room:ended` | `{ roomId, channelId? }` | Tear down. You receive this on the speaker socket. You do not also need the channel copy. |
| `audio-room:state` | `{ roomId, participants, listenerCount? }` | After reconnect, replace `speakers` with `participants` and replace `listenerCount` when the field is present. On these calls, `participants` is only hosts and speakers. |

Ignore a socket payload whose `roomId` is not the call on screen, except `incoming` and `ended`, which must still close a ring or a banner for that room.

## Screens

### Banner

Show "Call in progress — Join" when status `live` is not null and this user is not in that call. Tap runs Join with `preferPlayback: true`. Do not start the player on the banner. If Join returns "Room is not live" or "This call has ended", hide the banner and show "This call has ended". Do not call start.

### Incoming channel call

Show `channelName` and `callerName`. Buttons: Join and Dismiss. Join uses `POST /audio-rooms/:roomId/join` with `preferPlayback: true`. Dismiss closes the UI and sends nothing. Close the screen after 30 seconds. Never show it to the starter. Push tap does the same Join. Push fields: `notificationType` `CALL`, `callKind` `CHANNEL_AUDIO_ROOM`, `roomId`, `channelId`, `channelName`, `callerName`, `callerId`, `callerAvatarUrl`. Title is "{name} started a call". Body is the channel name.

### Prayer Watch notice

The push is not a 30-second call ring. Title is "{name} started a call". Body is "Prayer Watch". Data includes `route` and `screen` `PRAYER_WATCH`, `roomId`, `channelId`, `callerName`, `callerId`, `callerAvatarUrl`, and `deepLink` `dgc://prayer-watch/rooms/{roomId}`. Tap Joins with `preferPlayback: true`. The home banner is the way in after the notice is gone.

### Call screen

- Speakers: name, avatar, speaking indicator from Agora's volume callback matched on `agoraUid`, and a "Started the call" badge where `userId === hostId`.
- Congregation: "140 listening" from `listenerCount`.
- Mic: visible for everyone in the call. Off calls `hold: true`. On calls `hold: false`. Disable it while the request is in flight.
- Leave: always.
- End: only when `viewer.canEnd` is true, and also when a channel call's `totalParticipants` becomes 1 and that person is you.
- Mute, Mute all, Remove: only when `viewer.canModerate` is true.
- While `mode` is `listening`, you may show the speaker names from the last GET. They will not tick live. That is expected. Sound is the station.
- Keep the call playing if the app is backgrounded. Stop it only on Leave, End, kick, or `audio-room:ended`.

### Channel header call button

Unchanged rule for who may start. The request body gains `"preferPlayback": true`. If `alreadyLive` is true, you joined. Apply `role` from the body. Disable the button while the request runs.

## Errors

| Message | What the app does |
|---|---|
| Please wait a moment before starting another call in this channel | Show it. Joining a live call is not limited. |
| This call has ended | Show it. Hide the banner. Do not call start again. A new call is allowed after 30 seconds. |
| Another prayer call is being started, please try again | Show it. The member can tap again. |
| Room is not live | Treat as "This call has ended". Do not start a replacement. |
| Room not found | Channel or Prayer Watch join: the call is gone. Close the screen. |
| Already in this room | Fetch the room and the token. Stay on the call screen. |
| Not in this room | Close the call screen and stop audio. |
| Join the call before using the mic | Ignore the tap. The Join request has not finished. |
| All free mics are in use | Stay muted. Show the message. |
| The last person on the call keeps the mic | Keep the mic open. |
| You cannot take this mic | Show it. Leave that person's mic up. |
| Listener has no active mic to mute | Refresh the room. They are already muted. |
| Listener has no active mic to unmute | Do not call unmute. Use `POST /mic` with `hold: true`. |
| This room does not use station mics | App bug: `/mic` was sent to a named room or a DM. |
| You do not have permission to end this room | Refetch. If the call has ended, close quietly. Otherwise show that only the starter or an admin can end it, and offer Leave. |
| Only Prayer Warriors moderators or super admins can force-end the Prayer Watch call | The app called `POST /prayer-watch/:roomId/end` from the normal End button. Call `POST /audio-rooms/:roomId/end` instead. |
| Room already ended | Close the call screen. |
| Unauthorized | Refresh the access token and retry once. |

## Named rooms and direct calls

Do not apply `applyAudio`'s listener branch to them.

- A `GENERAL` room still uses raise hand, promote, step down, and Agora audience tokens. `POST /mic` there returns "This room does not use station mics".
- A direct call still uses `DM_CALLS_FRONTEND_GUIDE.md`. No `preferPlayback`, no station player.

If this build sends `preferPlayback: true` on a `GENERAL` join by mistake, the server still returns an Agora token for that room. Playing a null `playbackUrl` would silence them. Scope the station player to `PRAYER_WATCH` and `CHANNEL_CALL` only. You can tell a channel call by the screen you joined from. Prayer Watch uses `/prayer-watch`. The room detail does not include a `type` field.

## Checklist

- Banner shows a live call and stays silent until Join.
- Join with the boolean `true` opens the call screen muted and plays HLS when `agora` is null and `playbackUrl` is set.
- Join as an admin joins Agora and does not play HLS.
- The starter is not rung, starts on Agora, and can Leave without ending.
- Unmute stops HLS, joins Agora, and the speaker list gains that person.
- A fourth free mic shows "All free mics are in use" and HLS keeps playing.
- Mute leaves Agora, plays HLS again, and the person is still on the call screen.
- The last speaker cannot mute.
- A moderator cannot mute the starter or another admin.
- Mute all drops free mics only.
- Leave stops both audio paths.
- The last person to leave closes the banner for everyone else.
- `audio-room:ended` stops a listener who is not in the speaker socket.
- An 11-hour `audio-room:playback` swaps the URL only for someone already playing that room.
- `audio-room:token` while listening puts that phone on Agora and reconnects the socket once.
- A missing `playbackUrl` on Join does not join Agora.
- Killing the heartbeat no longer matters for this test if Leave was sent when the screen closed.
- A named room and a DM still use Agora only.

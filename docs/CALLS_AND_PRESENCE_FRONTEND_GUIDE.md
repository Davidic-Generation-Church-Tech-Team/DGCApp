# Group Calls & Online Status Frontend Implementation Guide

This guide covers two features for the React Native app:

1. **Group & cluster calls**: voice calls inside cluster and group chat channels.
2. **Online status & last seen**: who is online, when people were last seen, and the live online users list for super admins.

The two are linked: the presence heartbeat described in part 2 also keeps users on a call in part 1, so both need to be built.

## Part 1: Group & cluster calls

This part explains how voice calls inside cluster and group chat channels work, and what the React Native app needs to build for them.

On the backend these are called **channel calls**. A channel call belongs to one chat channel, rings every member of that channel, lets everyone on it talk, and stays up until someone ends it or the last person leaves.

The backend keeps track of the call, who is on it, who is allowed to do what, the ringing notifications, and the Agora tokens. Agora carries the actual audio.

This part does not cover 1:1 DM calls (see `DM_CALLS_FRONTEND_GUIDE.md`) or the Global Prayer Watch call, which has its own endpoints and stricter rules.

### Before you start

- Every request needs the user's access token, the same as the rest of the API.
- The app must be connected to the socket server while the user is in a channel or on a call.
- The app must keep sending the presence heartbeat every 60 seconds while it is open, including during a call. If the heartbeat stops for about 2 minutes, the server treats the user as gone and removes them from the call.
- Join Agora with the `agora` details the backend returns when starting or joining a call. If those details come back empty, Agora isn't set up in that environment: the call screens will work but there will be no sound.

### The rules

- **Starting:** any member of the channel can start a call. In read-only channels, only channel admins, channel moderators and super admins can start one.
- **One call at a time:** a channel can only have one live call. If someone taps Call while a call is already running, they simply join it.
- **Talking:** everyone on the call can talk. There is no raise-hand step.
- **The person who started the call can end it for everyone**, whether or not they are an admin.
- **The person who started the call can also leave without ending it.** The call carries on for everyone else, and they can rejoin later and still end it.
- **Anyone with admin rights at that moment can end the call.** This means a channel admin or moderator, a moderator of the channel's cluster, an admin of the channel's branch, or a super admin. Rights are checked when the button is tapped, so someone made admin during the call can end it straight away.
- **The last person left on the call can end it**, whether or not they are an admin.
- **When the last person leaves, the call ends on its own.**

### What the app gets back

When the app starts, joins or fetches a call, the backend returns the call details:

- the call ID (also used as the Agora channel name), title and the channel it belongs to;
- whether it is live or ended;
- who started it (`hostId`), which never changes during the call;
- everyone currently on the call, each with their name, avatar and Agora user number (use this number to show who is talking);
- how many people are on the call;
- **`viewer`**: what the current user is allowed to do, worked out by the server:
  - `canEnd`: they may end the call for everyone;
  - `canModerate`: they may mute people, mute everyone, or remove someone.

Use `viewer` to decide which buttons to show. Don't try to work out roles in the app: the server already includes every case (starter, all admin types, last person on the call). Both are false once the call has ended.

The `host` field becomes empty when the starter leaves the call. To show a "Started the call" badge, compare against `hostId` instead.

### Actions

| Action | Endpoint | What happens |
|---|---|---|
| Check if a call is live in a channel | `GET /api/v1/channels/:channelId/call` | Returns the live call, or nothing. Check this when the channel screen opens or comes back into view. |
| Start a call | `POST /api/v1/channels/:channelId/call/start` | Starts a new call and rings the other members. If a call is already live, the user joins it instead, and the response says `alreadyLive` is true. In that case the user is not the starter. |
| Join a call | `POST /api/v1/audio-rooms/:roomId/join` | Adds the user to the call. Use this when accepting a ring or tapping the Join banner. |
| Leave the call | `POST /api/v1/audio-rooms/:roomId/leave` | Removes only this user. The call continues for everyone else, unless they were the last one. |
| End the call for everyone | `POST /api/v1/audio-rooms/:roomId/end` | Ends the call. Only allowed when `viewer.canEnd` is true. |
| Get call details | `GET /api/v1/audio-rooms/:roomId` | Returns the latest call details, including fresh `viewer` flags. |
| Refresh the Agora token | `POST /api/v1/audio-rooms/:roomId/token` | Use when Agora says the token is about to expire, and after reconnecting. |
| Mute someone | `POST /api/v1/audio-rooms/:roomId/participants/:userId/mute` | Moderators only. |
| Mute everyone else | `POST /api/v1/audio-rooms/:roomId/mute-all` | Moderators only. |
| Remove someone | `DELETE /api/v1/audio-rooms/:roomId/participants/:userId` | Moderators only. |
| Unmute | `POST /api/v1/audio-rooms/:roomId/participants/:userId/unmute` | Moderators can unmute anyone; anyone can unmute themselves. |

Muting is a request, not something the server can force. When a user is told they've been muted, their app **must** turn off their mic in Agora and update the mic button.

### Live updates (socket events)

The server signs the user up for a call's events automatically when they start or join it. The app doesn't need to send anything to subscribe.

| Event | Who receives it | What the app should do |
|---|---|---|
| `audio-room:incoming` | Every member of the channel, including the starter | Show the incoming call screen and the Join banner, unless the current user started the call. Stop ringing after 30 seconds. |
| `audio-room:user-joined` | Everyone on the call | Add the person to the call screen. |
| `audio-room:user-left` | Everyone on the call | Remove the person from the call screen. |
| `audio-room:ended` | Everyone on the call | Leave Agora, close the call screen, show "Call ended". |
| `audio-room:kicked` | The person removed | Leave Agora, close the call screen, show "You were removed from the call". |
| `audio-room:muted` | The person muted | Turn off their mic in Agora and update the mic button. |
| `audio-room:user-muted`, `audio-room:all-muted`, `audio-room:user-unmuted` | Everyone on the call | Show or clear the muted icon on the right people. |
| `audio-room:role-changed` | Everyone on the call | Update that person's role. |
| `audio-room:token` | One user | Give Agora the new token. |
| `audio-room:state` | One user, after reconnecting | Replace the list of people on the call with this one. |

**Important:** the "call ended" event only reaches people **on** the call. Members who are still being rung, or who are looking at the Join banner, are not told. So the app must:

- stop ringing after 30 seconds no matter what;
- show "This call has ended" if joining fails with "Room is not live";
- check whether a call is live each time the channel screen comes into view.

### Ringing when the app is closed

When a call starts, every channel member except the starter (and anyone who muted the channel) gets an incoming-call push notification for 30 seconds. It contains the call ID, the channel ID and name, and who started the call. It is marked as a group call (`callKind` is `CHANNEL_AUDIO_ROOM`) so the app can tell it apart from a DM call.

- **Join:** open the app, join the call, then connect to Agora.
- **Dismiss:** just close the notification. There's nothing to send to the server; the call carries on for others.
- **No answer after 30 seconds:** remove the notification. The call may still be running, and the user can join from the banner in the channel.

### Screens and buttons the app must have

#### Call button in the channel header
- Show it to channel members. In read-only channels, show it only to channel admins, moderators and super admins.
- Tapping it starts the call (or joins the one already running), connects to Agora and opens the call screen.
- Disable it while the request is in progress so it can't be tapped twice.

#### "Call in progress — Join" banner in the channel
- Show it when a call is live in that channel and the user isn't on it.
- Tapping it joins the call.
- If the call has already ended, hide the banner and show "This call has ended".

#### Incoming group call screen
- Show the channel name and who started the call, with **Join** and **Dismiss** buttons.
- Close it automatically after 30 seconds.
- Never show it to the person who started the call.

#### Call screen
- **People on the call:** names and avatars, a speaking indicator (from Agora), a muted icon, and a "Started the call" badge on the starter.
- **Mic button:** turns the user's mic on and off.
- **Speaker/earpiece button.**
- **Leave button:** always shown to everyone. Leaves the call without ending it.
- **End call for everyone button:** shown only when `viewer.canEnd` is true. Ask "End the call for everyone?" before ending.
- **Moderator options** (Mute, Remove on each person, and Mute all): shown only when `viewer.canModerate` is true.

The starter and admins must see **both** Leave and End, so they can choose to leave without ending.

When only the current user is left on the call, show the End button even if `viewer.canEnd` was false when the call details were last fetched. The last person is always allowed to end the call.

#### Keeping the buttons correct
`viewer` comes from the last time the app fetched the call. Fetch the call details again when the user's role in the channel changes and when the app comes back to the foreground.

### Errors

Errors come back with a status, a short code (such as `FORBIDDEN`) and a message.

| When | Error | What the app should do |
|---|---|---|
| Starting or checking a call | "Channel not found" | Show "Channel not found" and leave the screen. |
| Starting or checking a call | "You are not a member of this channel" | Show that message. |
| Starting a call in a read-only channel | "Only moderators can start calls in read-only channels" | Hide the call button for this user. |
| Starting a call in a DM or Prayer Watch | "Use DM calls…" / "Use /api/v1/prayer-watch/start…" | App bug: those have their own call flows. |
| Joining | "Room not found" or "Room is not live" | Show "This call has ended" and hide the banner. |
| Joining | "Already in this room" | Not a real error: the user is already on the call (double tap or another device). Fetch the call details and carry on. |
| Leaving | "Not in this room" | The user is already off the call. Close the call screen quietly. |
| Ending | "Room already ended" or "Room not found" | Close the call screen quietly. |
| Ending | "You do not have permission to end this room" | Fetch the call details. If the call has ended, close the screen quietly. Otherwise show "Only the person who started the call or an admin can end it", and offer Leave. |
| Refreshing the token | "Not in this room" | The user is no longer on the call. Leave Agora and close the screen. |
| Mute, mute all, remove | "You do not have permission…" | Fetch the call details and hide moderator options if `viewer.canModerate` is now false. |
| Mute, remove | "User is not in this room" | Refresh the list of people on the call. |
| Any request | Unauthorized | Refresh the access token and try again. |

### Things to watch out for

- **Leaving without tapping Leave.** If the app is closed or loses connection, the user stays visible on the call for about 2 to 5 minutes until the server notices. To avoid this, always call Leave when the user leaves the call screen in any way, and keep the heartbeat running in the background during a call.
- **Reconnecting.** After the socket reconnects, the server sends the current list of people on the call: replace your list with it. Refresh the Agora token too. If the app was in the background for a while, fetch the call details, as the call may have ended.
- **Two devices.** If the user is already on the call on another device, don't ring them on this one.
- **Two people tapping Call at once.** Only one call is created. The second person joins the first person's call and is not the starter.

### Testing checklist

- A member starts a call: other members are rung, the starter is not.
- Ringing stops after 30 seconds.
- A second member taps Call during a live call: they join it and nobody is rung again.
- The starter (not an admin) sees Leave and End; End ends the call for everyone.
- The starter taps Leave: the call continues; they can rejoin and still end it.
- A member who isn't the starter or an admin sees only Leave while others are on the call.
- A channel admin who didn't start the call can end it.
- A member made admin during the call can end it straight away.
- The last person on the call (not an admin) can end it without an error.
- The last person taps Leave: the call ends and the banner disappears for others.
- Tapping Join on an ended call shows "This call has ended".
- A moderator mutes someone: their mic turns off and they show as muted.
- A moderator removes someone: their call screen closes.
- In a read-only channel, ordinary members see no call button but can still join a live call.
- Closing the app during a call: the user disappears from the call for others within about 5 minutes.

## Part 2: Online status & last seen

This part explains how the app shows who is online, when someone was last seen, and the live list of online users for super admins.

### How it works

- A user counts as **online** while the app is connected to the socket server and sending its heartbeat.
- When the app goes to the background it can report **away** instead.
- A user becomes **offline** when their last open device disconnects, or when the server stops hearing their heartbeat for about 2 minutes (for example, the app was killed or lost signal). In the second case, others see them go offline within about 3 minutes.
- Each time a user goes offline, the server saves their **last seen** time.

### What every app must do

- Connect to the socket server when the user signs in, and stay connected while the app is open.
- Send the `presence:heartbeat` event every 60 seconds. Send it with status "away" when the app goes to the background, and as normal when it comes back.
- Disconnect the socket when the user signs out.

If the heartbeat stops, the user will appear offline to everyone, even if the app is still open.

### Showing online status and last seen (all users)

- **Live changes:** listen for the `presence` event. It tells you a user's ID and their new status (online, away or offline). When the status is offline it also includes their last seen time. Update any green dots, chat headers and profiles showing that user.
- **User profile:** the profile response now includes the user's status and their `lastSeenAt` time.
- **Chat list:** for each DM, the other person's details now include their status and `lastSeenAt` time.

Showing it:

- Online: show a green dot or "Online".
- Away: show "Away", or treat it as online.
- Offline: show "Last seen" with the time (for example, "Last seen 2 hours ago" or "Last seen yesterday at 18:40").
- No last seen time: the user hasn't been seen since this feature was released. Show nothing, or just "Offline".

### Live online users list (super admins only)

Super admins can see everyone who is online right now, kept up to date live.

#### When a super admin's app connects
The server sends a `presence:online-snapshot` event straight away. It contains:

- the total number of users online (including away);
- the list of online users, most recently active first, each with their user ID, status and the time they were last active;
- whether there are more users than were sent (the snapshot holds up to 5,000).

#### While connected
Every time someone comes online, goes away or goes offline, the server sends a `presence:admin-update` event to super admins. It contains the user's ID, their new status, the new total online count, and, for offline, their last seen time. Use it to add, update or remove that person in the list and update the counter.

#### Full details with names and avatars
The socket events only carry user IDs. To show names and avatars, fetch `GET /api/v1/admin/online-users`. It returns the total online count and a page of online users, each with their name, avatar, role, status and last active time. It takes `offset` and `limit` (up to 200 per page) and tells you the offset to use for the next page, or nothing when you've reached the end.

#### Screens and widgets for super admins
- **Online counter:** for example "1,284 online now", on the admin dashboard. Starts from the snapshot and updates with each admin update event.
- **Online users list:** names, avatars, status and "active 2 min ago", loaded page by page from the endpoint, with people added and removed live as admin update events arrive. For someone new who isn't in the list yet, fetch the page again or look up their profile.

#### Errors
- Non-super-admins calling the online users endpoint get a "forbidden" error. Don't show the online users screen to anyone else.
- A user who is made super admin while signed in starts getting the live list after they reconnect with a refreshed token.

### Things to watch out for

- **Several devices:** a user stays online as long as any of their devices is connected.
- **Server problems:** if the presence store is briefly unavailable, users may show as offline for a moment. Don't show error messages for this; it sorts itself out.
- **Reconnecting:** after a super admin's socket reconnects, a new snapshot arrives. Replace the list and counter with it rather than adding to them.

### Testing checklist

- Open the app on device A and view user B's profile on device C: B shows online.
- Put B's app in the background: B shows away.
- Close B's app normally: B shows offline with a last seen time within a few seconds.
- Kill B's app or turn off its internet: B shows offline within about 3 minutes, with last seen set to their last activity.
- B signed in on two devices: closing one keeps B online.
- Super admin opens the dashboard: the counter and list appear right away and change as people come and go.
- An ordinary user can't open the online users screen or endpoint.

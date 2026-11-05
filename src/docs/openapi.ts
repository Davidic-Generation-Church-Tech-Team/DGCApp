import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import swaggerUi from 'swagger-ui-express';
import type { Express } from 'express';
import { logger } from '../infra/logger';
import {
  requestOtpSchema,
  requestPhoneOtpSchema,
  googleAuthSchema,
  appleAuthSchema,
  registerSchema,
  verifyOtpUnifiedSchema,
  loginSchema,
  setPasswordSchema,
  verifyResetOtpSchema,
  resetPasswordSchema,
  refreshTokenSchema,
} from '../modules/auth/auth.schema';
import { updateMeSchema, registerDeviceSchema, removeDeviceSchema } from '../modules/users/users.schema';
import { uploadSignatureSchema } from '../modules/media/media.schema';
import { sendMessageSchema, reactionSchema, editMessageSchema, forwardMessageSchema, pollVoteSchema } from '../modules/chat/chat.schema';
import { openDmSchema } from '../modules/channels/channels.schema';
import { createEventSchema, updateEventSchema, rsvpSchema } from '../modules/events/events.schema';
import { createBranchSchema, setRoleSchema, assignUserSchema } from '../modules/admin/admin.schema';
import { submitCertificateSchema, adminVerifyRequirementSchema, rejectCertificateSchema } from '../modules/growth/growth.schema';
import { postAnnouncementSchema, announcementAdminSchema } from '../modules/announcements/announcements.schema';
import { createRoomSchema, updateRoomSchema, promoteSchema } from '../modules/audio-rooms/audio-rooms.schema';
import { initiateCallSchema, listCallsSchema } from '../modules/calls/calls.schema';

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const okSchema = z.object({ ok: z.boolean() });
const tokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  isNewUser: z.boolean().optional(), // true when this sign-in created the account → route to onboarding
  // Compact profile so the app can render straight from the auth response — no GET /users/me round trip.
  user: z
    .object({
      id: z.string(),
      email: z.string().nullable(),
      phoneNumber: z.string().nullable(),
      displayName: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      globalRole: z.string(),
      onboardingComplete: z.boolean(),
    })
    .nullable(),
});
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const mediaKindLimitSchema = z.object({ maxBytes: z.number(), formats: z.array(z.string()) });
const mediaLimitsSchema = z.object({
  kinds: z.object({
    IMAGE: mediaKindLimitSchema,
    VIDEO: mediaKindLimitSchema,
    AUDIO: mediaKindLimitSchema,
    FILE: mediaKindLimitSchema,
  }),
  maxAttachments: z.number(),
});
const branchSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string(),
});
const meSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  globalRole: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  gender: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  occupation: z.string().nullable(),
  bio: z.string().nullable(),
  onboardingComplete: z.boolean(),
});

const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
const bearer = [{ bearerAuth: [] as string[] }];

// ---- auth ----
const publicAuth: [string, string, z.ZodTypeAny, z.ZodTypeAny][] = [
  ['/api/v1/auth/register', 'Register: email one verification code. A retry for the same email within 60s returns ok and does not send another code.', registerSchema, okSchema],
  ['/api/v1/auth/verify-otp', 'PREFERRED verify (email or phone): finishes a pending registration, else passwordless sign-in', verifyOtpUnifiedSchema, tokenSchema],
  ['/api/v1/auth/email/request-otp', 'Request an email OTP for sign-in (public, rate-limited)', requestOtpSchema, okSchema],
  ['/api/v1/auth/phone/request-otp', 'Request a phone OTP for sign-in (public, rate-limited; needs SMS provider)', requestPhoneOtpSchema, okSchema],
  ['/api/v1/auth/google', 'Sign in with a Google ID token', googleAuthSchema, tokenSchema],
  ['/api/v1/auth/apple', 'Sign in with an Apple ID token (needs Apple config)', appleAuthSchema, tokenSchema],
  ['/api/v1/auth/login', 'Sign in with email + password (rate-limited)', loginSchema, tokenSchema],
  ['/api/v1/auth/password/request-otp', 'Forgot password: email a reset code (public, rate-limited)', requestOtpSchema, okSchema],
  ['/api/v1/auth/password/verify-otp', 'Verify reset OTP is correct (does NOT consume it — call reset-password next)', verifyResetOtpSchema, okSchema],
  ['/api/v1/auth/reset-password', 'Reset password with a code from /auth/password/request-otp', resetPasswordSchema, tokenSchema],
  ['/api/v1/auth/refresh', 'Rotate refresh token for a new token pair', refreshTokenSchema, tokenSchema],
];
for (const [path, summary, body, ok] of publicAuth) {
  registry.registerPath({
    method: 'post',
    path,
    tags: ['auth'],
    summary,
    request: { body: json(body) },
    responses: {
      200: { description: 'Success', ...json(ok) },
      400: { description: 'Bad request', ...json(errorSchema) },
      401: { description: 'Unauthorized', ...json(errorSchema) },
      429: { description: 'Too many requests', ...json(errorSchema) },
    },
  });
}

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/password',
  tags: ['auth'],
  summary: 'Set or change your password',
  security: bearer,
  request: { body: json(setPasswordSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/logout',
  tags: ['auth'],
  summary: 'Revoke a refresh token',
  security: bearer,
  request: { body: json(refreshTokenSchema) },
  responses: { 200: { description: 'Logged out', ...json(okSchema) } },
});

// ---- users ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/users/me',
  tags: ['users'],
  summary: 'Get the authenticated user profile (with memberships + growth stage)',
  security: bearer,
  responses: {
    200: { description: 'Current user', ...json(meSchema) },
    401: { description: 'Unauthorized', ...json(errorSchema) },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/users/me',
  tags: ['users'],
  summary: 'Update profile; setting branchId the first time auto-joins branch + Global Announcement. Phone, gender, and date of birth are optional.',
  security: bearer,
  request: { body: json(updateMeSchema) },
  responses: {
    200: { description: 'Updated user', ...json(meSchema) },
    400: { description: 'Bad request', ...json(errorSchema) },
    409: { description: 'Already assigned to a branch', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/users/me',
  tags: ['users'],
  summary: 'Delete my account from inside the app (hard purge; frees the email/phone for reuse)',
  security: bearer,
  responses: { 200: { description: 'Deleted', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/users/me/devices',
  tags: ['users'],
  summary: 'Register or refresh this device for push notifications',
  description:
    'Call after login, app launch, and push-token refresh. Body accepts token/deviceToken/fcmToken/pushToken/apnsToken and uppercase or lowercase platform. Android/Web use FCM. iOS may send either an FCM token or a raw APNs token; raw APNs tokens are delivered through Apple directly.',
  security: bearer,
  request: { body: json(registerDeviceSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/users/me/devices',
  tags: ['users'],
  summary: 'Unregister a device token (call on logout)',
  security: bearer,
  request: { body: json(removeDeviceSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

// ---- branches ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/branches',
  tags: ['branches'],
  summary: 'List branches (public — registration picker)',
  responses: { 200: { description: 'Branches', ...json(z.array(branchSchema)) } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/branches/{id}',
  tags: ['branches'],
  summary: 'Get a branch by id',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Branch', ...json(branchSchema) },
    404: { description: 'Not found', ...json(errorSchema) },
  },
});

// ---- media ----
registry.registerPath({
  method: 'post',
  path: '/api/v1/media/signature',
  tags: ['media'],
  summary: 'Get Cloudinary signed-upload params; client uploads directly, then sends back the URL',
  security: bearer,
  request: { body: json(uploadSignatureSchema) },
  responses: {
    200: {
      description: 'Signed upload params',
      ...json(
        z.object({
          cloudName: z.string(),
          apiKey: z.string(),
          timestamp: z.number(),
          folder: z.string(),
          signature: z.string(),
          uploadUrl: z.string(),
          expiresAt: z.string(), // cache the whole response per type and reuse until this moment
          limits: mediaLimitsSchema, // same as GET /media/limits
        }),
      ),
    },
    401: { description: 'Unauthorized', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/media/limits',
  tags: ['media'],
  summary: 'Allowed file types and max sizes for message media — check a file against this before uploading',
  description:
    'kinds.<IMAGE|VIDEO|AUDIO|FILE> = { maxBytes, formats[] } (formats are lowercase extensions). ' +
    'maxAttachments = most files per message. Announcement posts enforce the same table and fail with ' +
    'MEDIA_URL_NOT_ALLOWED (400), MEDIA_TYPE_NOT_SUPPORTED (415) or MEDIA_TOO_LARGE (413).',
  security: bearer,
  responses: {
    200: { description: 'Media limits', ...json(mediaLimitsSchema) },
    401: { description: 'Unauthorized', ...json(errorSchema) },
  },
});

// ---- bootstrap ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/bootstrap',
  tags: ['bootstrap'],
  summary:
    'App-launch payload in ONE round trip: me + channels + notifications + live audio rooms + upcoming events',
  security: bearer,
  responses: {
    200: {
      description:
        'Everything the home screen needs. Call this once on launch instead of 5 separate GETs — on slow networks this is the difference between a 2s and a 10s cold open.',
      ...json(
        z.object({
          me: z.object({}).passthrough(),
          channels: z.array(z.object({}).passthrough()),
          notifications: z.object({ items: z.array(z.object({}).passthrough()), unreadCount: z.number() }),
          liveAudioRooms: z.array(z.object({}).passthrough()),
          upcomingEvents: z.array(z.object({}).passthrough()),
        }),
      ),
    },
    401: { description: 'Unauthorized', ...json(errorSchema) },
  },
});

// ---- channels + chat ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels',
  tags: ['channels'],
  summary: 'List my channels with last message + unread count (the Chats list)',
  security: bearer,
  responses: { 200: { description: 'Channels', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}',
  tags: ['channels'],
  summary: 'Get channel detail — includes description, memberCount, myRole, isMuted',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: {
    200: { description: 'Channel', ...json(z.object({}).passthrough()) },
    403: { description: 'Not a member', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/channels/dm',
  tags: ['channels'],
  summary: 'Open (or fetch) a 1:1 DM channel',
  security: bearer,
  request: { body: json(openDmSchema) },
  responses: { 201: { description: 'DM channel', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/call',
  tags: ['channels'],
  summary: 'Get the currently live group call for this channel, if any. DMs use /dms/{channelId}/calls; Global Prayer Watch uses /prayer-watch.',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'Channel call status', ...json(z.object({ channelId: z.string(), live: z.object({}).passthrough().nullable() })) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/channels/{channelId}/call/start',
  tags: ['channels'],
  summary: 'Start or join a live group call in this channel. Rings only non-muted members of this channel. Everyone joins as HOST/SPEAKER with a publisher token, like Prayer Watch. Starting a NEW call is limited to once per user per channel every 2 minutes (429); joining a live call is not limited.',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 201: { description: 'Audio room detail + Agora credentials + alreadyLive flag', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/dms/{channelId}/calls',
  tags: ['calls'],
  summary: 'List voice/video call history for a 1:1 DM',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }), query: listCallsSchema },
  responses: { 200: { description: 'Calls + nextCursor', ...json(z.object({ calls: z.array(z.object({}).passthrough()), nextCursor: z.string().nullable() })) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/dms/{channelId}/calls',
  tags: ['calls'],
  summary: 'Start a 1:1 DM call. Returns call detail + Agora credentials for the caller.',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }), body: json(initiateCallSchema) },
  responses: {
    201: { description: 'Ringing call + Agora credentials', ...json(z.object({}).passthrough()) },
    409: { description: 'Caller or callee is already in a live call', ...json(errorSchema) },
  },
});
for (const [path, summary] of [
  ['/api/v1/calls/{callId}/answer', 'Answer an incoming ringing call. Returns Agora credentials for the callee.'],
  ['/api/v1/calls/{callId}/decline', 'Decline an incoming ringing call.'],
  ['/api/v1/calls/{callId}/end', 'End an answered call, or cancel an outgoing ringing call.'],
  ['/api/v1/calls/{callId}/token', 'Refresh Agora credentials for an active call.'],
] as const) {
  registry.registerPath({
    method: 'post',
    path,
    tags: ['calls'],
    summary,
    security: bearer,
    request: { params: z.object({ callId: z.string() }) },
    responses: { 200: { description: 'Call action result', ...json(z.object({}).passthrough()) } },
  });
}
registry.registerPath({
  method: 'post',
  path: '/api/v1/channels/{channelId}/read',
  tags: ['channels'],
  summary: 'Mark a channel read (sets lastReadAt)',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/messages',
  tags: ['chat'],
  summary: 'List messages (keyset pagination: ?cursor=&limit=)',
  security: bearer,
  request: {
    params: z.object({ channelId: z.string() }),
    query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }),
  },
  responses: { 200: { description: 'Messages + nextCursor', ...json(z.object({ messages: z.array(z.object({}).passthrough()), nextCursor: z.string().nullable() })) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/messages/{messageId}',
  tags: ['chat'],
  summary: 'Get one message by id. Use after push tap when the message is not in local chat state yet.',
  security: bearer,
  request: { params: z.object({ channelId: z.string(), messageId: z.string() }) },
  responses: {
    200: { description: 'Message', ...json(z.object({}).passthrough()) },
    404: { description: 'Not found', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/channels/{channelId}/messages',
  tags: ['chat'],
  summary: 'Send a message. Supports retry-safe clientMessageId, replyToId, mentions[], and mentionEveryone. Response payload includes replyTo preview when replying.',
  security: bearer,
  request: {
    params: z.object({ channelId: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: sendMessageSchema,
          examples: {
            plain: { summary: 'Plain text', value: { type: 'TEXT', body: 'Hello everyone', clientMessageId: 'local-uuid-123' } },
            reply: { summary: 'Reply to a message', value: { type: 'TEXT', body: 'Amen!', replyToId: 'cm...' } },
            mention: { summary: 'Mention specific users', value: { type: 'TEXT', body: '@Kwasu can you lead?', mentions: ['cm...user1', 'cm...user2'] } },
            everyone: { summary: '@everyone', value: { type: 'TEXT', body: 'All hands — prayer at 5am', mentionEveryone: true } },
          },
        },
      },
    },
  },
  responses: {
    201: { description: 'Created message', ...json(z.object({}).passthrough()) },
    403: { description: 'Not a member / read-only', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/messages/search',
  tags: ['chat'],
  summary: 'Search a channel\'s messages (?q=term)',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }), query: z.object({ q: z.string() }) },
  responses: { 200: { description: 'Matching messages', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/members',
  tags: ['channels'],
  summary: 'List a channel\'s members (who is in this group) + count. Each member includes a `status` field: online | away | offline.',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'Members + memberCount', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/channels/{channelId}/mute',
  tags: ['channels'],
  summary: 'Mute a channel (suppress notifications)',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'Muted', ...json(z.object({ ok: z.boolean() })) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/channels/{channelId}/mute',
  tags: ['channels'],
  summary: 'Unmute a channel',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'Unmuted', ...json(z.object({ ok: z.boolean() })) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/messages/pinned',
  tags: ['channels'],
  summary: 'List pinned messages in a channel',
  security: bearer,
  request: { params: z.object({ channelId: z.string() }) },
  responses: { 200: { description: 'Pinned messages', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/channels/{channelId}/media',
  tags: ['channels'],
  summary: 'Shared media gallery (images, videos, audio, files) — paginated',
  security: bearer,
  request: {
    params: z.object({ channelId: z.string() }),
    query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().optional() }),
  },
  responses: { 200: { description: 'Media items + nextCursor', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/users/{userId}',
  tags: ['users'],
  summary: 'Public user profile — displayName, avatar, bio, occupation, online status, shared channels',
  security: bearer,
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: { description: 'User profile', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/messages/{messageId}',
  tags: ['chat'],
  summary: 'Edit your own message',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(editMessageSchema) },
  responses: {
    200: { description: 'Updated message', ...json(z.object({}).passthrough()) },
    403: { description: 'Not your message', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/forward',
  tags: ['chat'],
  summary: 'Forward a message to another channel { channelId }',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(forwardMessageSchema) },
  responses: {
    201: { description: 'Forwarded message', ...json(z.object({}).passthrough()) },
    403: { description: 'Not a member / read-only', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/reactions',
  tags: ['chat'],
  summary: 'React to a message',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(reactionSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/messages/{messageId}/reactions',
  tags: ['chat'],
  summary: 'Remove your reaction (emoji) from a message',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(reactionSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/pin',
  tags: ['chat'],
  summary: 'Pin a message (moderator only)',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }) },
  responses: { 200: { description: 'Pinned message', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/unpin',
  tags: ['chat'],
  summary: 'Unpin a message (moderator only)',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }) },
  responses: { 200: { description: 'Unpinned message', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/messages/{messageId}',
  tags: ['chat'],
  summary: 'Delete a message (sender or moderator)',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

// ---- polls ----
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/poll/vote',
  tags: ['chat'],
  summary: 'Vote on a poll option (if allowMultiple=false, moves your vote)',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(pollVoteSchema) },
  responses: { 200: { description: 'Updated poll with vote counts', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/{messageId}/poll/retract',
  tags: ['chat'],
  summary: 'Retract your vote from a poll option',
  security: bearer,
  request: { params: z.object({ messageId: z.string() }), body: json(pollVoteSchema) },
  responses: { 200: { description: 'Updated poll with vote counts', ...json(z.object({}).passthrough()) } },
});

// ---- clusters ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/clusters',
  tags: ['clusters'],
  summary: 'List clusters (Recommended Clusters) with isMember + memberCount',
  security: bearer,
  responses: { 200: { description: 'Clusters', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/clusters/{clusterId}/join',
  tags: ['clusters'],
  summary: 'Join a cluster (also joins its chat channel)',
  security: bearer,
  request: { params: z.object({ clusterId: z.string() }) },
  responses: { 200: { description: 'Joined', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/clusters/{clusterId}/leave',
  tags: ['clusters'],
  summary: 'Leave a cluster',
  security: bearer,
  request: { params: z.object({ clusterId: z.string() }) },
  responses: { 200: { description: 'Left', ...json(okSchema) } },
});

// ---- growth ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/growth/me',
  tags: ['growth'],
  summary: 'My Journey: ten-stage pipeline, progress %, next action, current-stage tasks, badges',
  security: bearer,
  responses: { 200: { description: 'Growth summary', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/growth/requirements/{key}/complete',
  tags: ['growth'],
  summary: 'Self-attest a SELF_ATTEST requirement (advances stage when all are met)',
  security: bearer,
  request: { params: z.object({ key: z.string() }) },
  responses: { 200: { description: 'Updated growth summary', ...json(z.object({}).passthrough()) }, 400: { description: 'Not self-attestable', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/growth/certificates',
  tags: ['growth'],
  summary: 'Submit a certificate for a CERTIFICATE requirement (status PENDING)',
  security: bearer,
  request: { body: json(submitCertificateSchema) },
  responses: { 201: { description: 'Certificate', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/growth/certificates',
  tags: ['growth'],
  summary: 'My submitted certificates',
  security: bearer,
  responses: { 200: { description: 'Certificates', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/growth/admin/certificates',
  tags: ['growth'],
  summary: 'Pending certificate verification queue (super admin)',
  security: bearer,
  responses: { 200: { description: 'Pending certificates', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/growth/admin/certificates/{id}/verify',
  tags: ['growth'],
  summary: 'Verify a certificate (records the requirement completion)',
  security: bearer,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/growth/admin/certificates/{id}/reject',
  tags: ['growth'],
  summary: 'Reject a certificate submission (optional reason)',
  security: bearer,
  request: { params: z.object({ id: z.string() }), body: json(rejectCertificateSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/growth/admin/requirements/verify',
  tags: ['growth'],
  summary: 'Admin-verify an ADMIN_VERIFY requirement for a member',
  security: bearer,
  request: { body: json(adminVerifyRequirementSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

// ---- events ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/events',
  tags: ['events'],
  summary: 'Upcoming events (global + my branches + my clusters) with my RSVP. The poster is postedBy "Admin", not a person. About a day before, a push goes to that audience, except people who RSVP Not Going.',
  security: bearer,
  responses: { 200: { description: 'Events', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/events',
  tags: ['events'],
  summary: 'Create an event — set branchId (branch) OR clusterId (cluster) OR neither (global); never both',
  security: bearer,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createEventSchema,
          example: {
            title: 'Sunday Service',
            description: 'Weekly service',
            location: 'DGC Ibadan',
            startsAt: '2026-07-12T09:00:00.000Z',
            endsAt: '2026-07-12T11:00:00.000Z',
            branchId: 'paste a branch id from GET /branches',
          },
        },
      },
    },
  },
  responses: {
    201: { description: 'Created event', ...json(z.object({}).passthrough()) },
    403: { description: 'Not permitted', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/events/{eventId}',
  tags: ['events'],
  summary: 'Event detail with RSVP counts + my RSVP/check-in',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }) },
  responses: { 200: { description: 'Event', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/events/{eventId}',
  tags: ['events'],
  summary: 'Edit an event (super admin or the owning branch admin / cluster moderator); scope is fixed. Moving startsAt sends the day-before reminder again.',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }), body: json(updateEventSchema) },
  responses: {
    200: { description: 'Updated event', ...json(z.object({}).passthrough()) },
    403: { description: 'Not permitted', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/events/{eventId}',
  tags: ['events'],
  summary: 'Delete/cancel an event (removes its RSVPs) — super admin or the owning admin/moderator',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }) },
  responses: {
    200: { description: 'OK', ...json(okSchema) },
    403: { description: 'Not permitted', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/events/{eventId}/rsvp',
  tags: ['events'],
  summary: 'RSVP to an event',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }), body: json(rsvpSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/events/{eventId}/rsvp',
  tags: ['events'],
  summary: 'Withdraw your RSVP (remove it entirely)',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/events/{eventId}/checkin',
  tags: ['events'],
  summary: 'Check in at an event (QR scan)',
  security: bearer,
  request: { params: z.object({ eventId: z.string() }) },
  responses: { 200: { description: 'Checked in', ...json(okSchema) } },
});

// ---- notifications ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/notifications',
  tags: ['notifications'],
  summary: 'List my notifications + unread count',
  security: bearer,
  responses: { 200: { description: 'Notifications', ...json(z.object({ items: z.array(z.object({}).passthrough()), unreadCount: z.number() })) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/notifications/read-all',
  tags: ['notifications'],
  summary: 'Mark all my notifications read',
  security: bearer,
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/notifications/{id}/read',
  tags: ['notifications'],
  summary: 'Mark a notification read',
  security: bearer,
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

// ---- admin ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/analytics',
  tags: ['admin'],
  summary: 'Dashboard analytics: counts, branch + leadership-pipeline breakdowns',
  security: bearer,
  responses: { 200: { description: 'Analytics', ...json(z.object({}).passthrough()) }, 403: { description: 'Super admin only', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/dashboard',
  tags: ['admin'],
  summary: 'Admin dashboard. Super admins get global data; branch admins get their branch scope.',
  security: bearer,
  responses: { 200: { description: 'Dashboard', ...json(z.object({}).passthrough()) }, 403: { description: 'Admin only', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/members',
  tags: ['admin'],
  summary: 'Admin member list. Super admins get all members; branch admins get their branch members.',
  security: bearer,
  request: { query: z.object({ search: z.string().optional(), cursor: z.string().optional() }) },
  responses: { 200: { description: 'Members + nextCursor', ...json(z.object({}).passthrough()) }, 403: { description: 'Admin only', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/users',
  tags: ['admin'],
  summary: 'List/search members',
  security: bearer,
  request: { query: z.object({ search: z.string().optional() }) },
  responses: { 200: { description: 'Users', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/online-users',
  tags: ['admin'],
  summary: 'Users online right now (super admin). Returns { onlineCount, items: [{ user, status, lastActiveAt }], nextOffset }, most recently active first.',
  security: bearer,
  request: { query: z.object({ offset: z.coerce.number().optional(), limit: z.coerce.number().max(200).optional() }) },
  responses: { 200: { description: 'Online users page', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/users/{userId}/suspend',
  tags: ['admin'],
  summary: 'Suspend a member (blocks sign-in and API access)',
  security: bearer,
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/users/{userId}/unsuspend',
  tags: ['admin'],
  summary: 'Lift a member suspension',
  security: bearer,
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/users/{userId}/role',
  tags: ['admin'],
  summary: 'Set a user global role. Super admin only; branch admins cannot grant SUPER_ADMIN.',
  security: bearer,
  request: { params: z.object({ userId: z.string() }), body: json(setRoleSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/branches',
  tags: ['admin'],
  summary: 'Create a branch (auto-provisions section channels)',
  security: bearer,
  request: { body: json(createBranchSchema) },
  responses: { 201: { description: 'Branch', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/branches/{branchId}/admins',
  tags: ['admin'],
  summary: 'Assign a branch admin. Super admin can assign any user; that branch admin can only promote existing members of the same branch.',
  security: bearer,
  request: { params: z.object({ branchId: z.string() }), body: json(assignUserSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) }, 403: { description: 'Not this branch admin or target is outside branch scope', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/branches/{branchId}/dashboard',
  tags: ['admin'],
  summary: 'Branch dashboard for a super admin or that branch admin',
  security: bearer,
  request: { params: z.object({ branchId: z.string() }) },
  responses: { 200: { description: 'Branch dashboard', ...json(z.object({}).passthrough()) }, 403: { description: 'Not this branch admin', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/branches/{branchId}/members',
  tags: ['admin'],
  summary: 'Branch members for a super admin or that branch admin',
  security: bearer,
  request: { params: z.object({ branchId: z.string() }), query: z.object({ search: z.string().optional(), cursor: z.string().optional() }) },
  responses: { 200: { description: 'Branch members + nextCursor', ...json(z.object({}).passthrough()) }, 403: { description: 'Not this branch admin', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/branches/{branchId}/members/{userId}/remove',
  tags: ['admin'],
  summary: 'Remove a member from a branch. Super admin or that branch admin only.',
  security: bearer,
  request: { params: z.object({ branchId: z.string(), userId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) }, 403: { description: 'Not this branch admin', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/clusters/{clusterId}/moderators',
  tags: ['admin'],
  summary: 'Assign a cluster moderator. Super admin can assign any user; branch admins can only appoint ordinary members from their own branch.',
  security: bearer,
  request: { params: z.object({ clusterId: z.string() }), body: json(assignUserSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) }, 403: { description: 'Super admin or same-branch admin only', ...json(errorSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/clusters/{clusterId}/archive',
  tags: ['admin'],
  summary: 'Archive a cluster (hidden from discovery; chat frozen)',
  security: bearer,
  request: { params: z.object({ clusterId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/clusters/{clusterId}/unarchive',
  tags: ['admin'],
  summary: 'Restore an archived cluster',
  security: bearer,
  request: { params: z.object({ clusterId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});

// ---- announcements (PRD §4) ----
const announcementMediaErrors = {
  400: { description: 'BAD_REQUEST (invalid body) or MEDIA_URL_NOT_ALLOWED (not from the DGC Cloudinary account)', ...json(errorSchema) },
  413: { description: 'MEDIA_TOO_LARGE — attachment bytes exceed the maxBytes for its kind', ...json(errorSchema) },
  415: { description: 'MEDIA_TYPE_NOT_SUPPORTED — extension not in GET /media/limits', ...json(errorSchema) },
};
registry.registerPath({
  method: 'get',
  path: '/api/v1/announcements',
  tags: ['announcements'],
  summary: 'List recent announcements (Home → Announcements)',
  security: bearer,
  responses: { 200: { description: 'Announcements', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/announcements',
  tags: ['announcements'],
  summary: 'Post an announcement (super admin or announcement admin) — notifies all members',
  description:
    'Media: upload each file first via POST /media/signature { type: "media" } + direct Cloudinary upload, then send ' +
    'the secure_url(s). For an album send attachments: [{ url, width?, height?, bytes? }] (1–10, in display order; pass the bytes Cloudinary returns so size is checked); for one file ' +
    'you may instead send mediaUrl (older single-file form, still supported). Not both. body is optional when media is sent. ' +
    'Response: attachments[] ({ id, url, thumbUrl, type IMAGE/VIDEO/AUDIO/FILE, position, width, height }) ordered by position, ' +
    'plus mediaUrl = first attachment url, thumbUrl = a small preview, and type = first attachment type (TEXT when there is no media). ' +
    'Image urls are capped at 1600px and thumbs at 400px, so the list does not download the original upload. Scroll with thumbUrl and load url or mediaUrl only when the picture is opened. ' +
    'The GET feeds return the same shape. sender is always { id: "admin", displayName: "Admin", avatarUrl: null } — ' +
    'the person who posted is not included. Every other active member gets a push: the title and the first image ' +
    'when the announcement has a photo, otherwise the title and the opening of the text. Every media URL must be a ' +
    'file in the DGC Cloudinary account with an allowed extension (see GET /media/limits).',
  security: bearer,
  request: { body: json(postAnnouncementSchema) },
  responses: {
    201: { description: 'Created announcement', ...json(z.object({}).passthrough()) },
    403: { description: 'Not authorized to post', ...json(errorSchema) },
    ...announcementMediaErrors,
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/announcements/admins',
  tags: ['announcements'],
  summary: 'List announcement admins (super admin only)',
  security: bearer,
  responses: { 200: { description: 'Announcement admins', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/announcements/admins',
  tags: ['announcements'],
  summary: 'Authorize a user to post announcements (super admin only)',
  security: bearer,
  request: { body: json(announcementAdminSchema) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/announcements/admins/{userId}',
  tags: ['announcements'],
  summary: 'Revoke a user announcement-posting access (super admin only)',
  security: bearer,
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: { description: 'OK', ...json(okSchema) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/branches/{branchId}/announcements',
  tags: ['announcements'],
  summary: 'List a branch\'s announcements (Service Updates channel)',
  security: bearer,
  request: { params: z.object({ branchId: z.string() }) },
  responses: { 200: { description: 'Branch announcements', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/branches/{branchId}/announcements',
  tags: ['announcements'],
  summary: 'Post a branch announcement (branch admin or super admin) — notifies that branch, with the title and image or a text excerpt',
  description: 'Same body and response as POST /announcements, including attachments (albums) and mediaUrl.',
  security: bearer,
  request: { params: z.object({ branchId: z.string() }), body: json(postAnnouncementSchema) },
  responses: {
    201: { description: 'Created announcement', ...json(z.object({}).passthrough()) },
    403: { description: 'Not authorized', ...json(errorSchema) },
    ...announcementMediaErrors,
  },
});

// ─── Audio Rooms ───
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms',
  tags: ['audio-rooms'],
  summary: 'Create an audio room (admin only). Returns full room detail shape (host, speakers, listeners, counts, agora). Live rooms start immediately; no extra GET needed.',
  security: bearer,
  request: { body: json(createRoomSchema) },
  responses: { 201: { description: 'Created room + participants + agora token (when live)', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/audio-rooms',
  tags: ['audio-rooms'],
  summary: 'List audio rooms — ?filter=live|scheduled|ended. Each card: host {id,displayName,avatarUrl}, speakerCount, listenerCount, participantsPreview (first 8 avatars), isReminding.',
  security: bearer,
  request: { query: z.object({ filter: z.enum(['live', 'scheduled', 'ended']).optional(), branchId: z.string().optional(), clusterId: z.string().optional() }) },
  responses: { 200: { description: 'Room cards for the Audio tab', ...json(z.array(z.object({}).passthrough())) } },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/audio-rooms/{roomId}',
  tags: ['audio-rooms'],
  summary: 'Room detail — host, speakerCount, listenerCount, totalParticipants, speakers (all), listeners (first 30), isReminding, viewer { canModerate, canEnd } for the current user',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Room + speakers + capped listeners', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/remind',
  tags: ['audio-rooms'],
  summary: '"Remind Me" on a scheduled room — user is notified when the host starts it',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Reminder set', ...json(z.object({ ok: z.boolean(), isReminding: z.boolean() })) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/audio-rooms/{roomId}/remind',
  tags: ['audio-rooms'],
  summary: 'Cancel "Remind Me" on a scheduled room',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Reminder cleared', ...json(z.object({ ok: z.boolean(), isReminding: z.boolean() })) } },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/audio-rooms/{roomId}',
  tags: ['audio-rooms'],
  summary: 'Update room title/description/schedule (host only)',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }), body: json(updateRoomSchema) },
  responses: { 200: { description: 'Updated room', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/start',
  tags: ['audio-rooms'],
  summary: 'Start a scheduled room (SCHEDULED → LIVE). Host only. Returns full room detail shape + `agora` credentials.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Room now live + agora token', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/end',
  tags: ['audio-rooms'],
  summary: 'End a live room. Host/starter or a moderator of the room scope (channel admin/mod, cluster mod, branch admin, super admin). For channel calls, the last remaining participant can also end it.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Room ended', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/join',
  tags: ['audio-rooms'],
  summary: 'Join a live room as listener. Returns full room detail shape + `agora` credentials — no extra GET needed.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Participant + Agora credentials', ...json(z.object({}).passthrough()) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/leave',
  tags: ['audio-rooms'],
  summary: 'Leave a room. If host leaves, next speaker is promoted or room ends.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Left', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/raise-hand',
  tags: ['audio-rooms'],
  summary: 'Raise hand to request speaker role (listeners only). Broadcasts audio-room:hand-raised.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Hand raised', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/audio-rooms/{roomId}/raise-hand',
  tags: ['audio-rooms'],
  summary: 'Lower a previously raised hand (listeners only). Broadcasts audio-room:hand-lowered.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Hand lowered', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/promote',
  tags: ['audio-rooms'],
  summary: 'Promote/demote a participant. Host, super admin, or the room\'s branch admin / cluster moderator. Promoted speakers get a new Agora token via socket.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }), body: json(promoteSchema) },
  responses: { 200: { description: 'Role changed', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/step-down',
  tags: ['audio-rooms'],
  summary: 'Speaker demotes themselves to LISTENER. Returns a fresh audience-role Agora token.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'Stepped down; contains new Agora audience token', ...json(z.object({ ok: z.boolean(), appId: z.string().nullable(), token: z.string().nullable(), channel: z.string(), uid: z.number() })) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/participants/{userId}/mute',
  tags: ['audio-rooms'],
  summary: 'Soft-mute a HOST/SPEAKER. Broadcasts audio-room:user-muted; the target receives audio-room:muted and is expected to honor it client-side.',
  security: bearer,
  request: { params: z.object({ roomId: z.string(), userId: z.string() }) },
  responses: { 200: { description: 'Mute signal sent', ...json(okSchema) } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/participants/{userId}/unmute',
  tags: ['audio-rooms'],
  summary: 'Clear a soft-mute badge for a HOST/SPEAKER. Moderators can unmute anyone; a participant can unmute themselves. Broadcasts audio-room:user-unmuted.',
  security: bearer,
  request: { params: z.object({ roomId: z.string(), userId: z.string() }) },
  responses: { 200: { description: 'Unmute signal sent', ...json(okSchema) } },
});
registry.registerPath({
  method: 'delete',
  path: '/api/v1/audio-rooms/{roomId}/participants/{userId}',
  tags: ['audio-rooms'],
  summary: 'Kick a participant. Host, super admin, or the room\'s branch admin / cluster moderator.',
  security: bearer,
  request: { params: z.object({ roomId: z.string(), userId: z.string() }) },
  responses: { 200: { description: 'Kicked', ...json(okSchema) } },
});

// ---- Global Prayer Watch (PRD clarification: singleton chat channel + live prayer call) ----
registry.registerPath({
  method: 'get',
  path: '/api/v1/prayer-watch',
  tags: ['prayer-watch'],
  summary: 'Return the Global Prayer Watch channel id + the currently-live call (or null). Use channelId with the standard channel endpoints for chat messages.',
  security: bearer,
  responses: {
    200: {
      description: 'Channel id + live call state',
      ...json(z.object({
        channelId: z.string(),
        live: z.object({ id: z.string(), title: z.string(), hostId: z.string(), startedAt: z.string().nullable(), createdAt: z.string() }).nullable(),
      })),
    },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/prayer-watch/start',
  tags: ['prayer-watch'],
  summary: 'Any member starts the Global Prayer Watch call. Idempotent — if one is already live, attaches the caller and returns the existing room + Agora token. A new call pushes the starter\'s name to every user.',
  security: bearer,
  responses: {
    201: {
      description: 'Call started (or joined if already live) — includes full room detail + Agora token (host for the starter, audience for someone joining an ongoing call) + alreadyLive flag',
      ...json(z.object({}).passthrough()),
    },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/prayer-watch/{roomId}/end',
  tags: ['prayer-watch'],
  summary: 'Force-end the Global Prayer Watch call. Prayer Warriors cluster moderator or super admin only. Regular members just leave via /audio-rooms/:id/leave; the call auto-ends when the last participant leaves.',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: {
    200: { description: 'Ended', ...json(okSchema) },
    403: { description: 'Not a Prayer Warriors moderator or super admin', ...json(errorSchema) },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/audio-rooms/{roomId}/token',
  tags: ['audio-rooms'],
  summary: 'Refresh Agora token (call when token is about to expire, ~55 min)',
  security: bearer,
  request: { params: z.object({ roomId: z.string() }) },
  responses: { 200: { description: 'New Agora credentials', ...json(z.object({}).passthrough()) } },
});

// Rendered as Markdown at the top of Swagger UI (/docs) — the frontend integration guide so the
// app team can self-serve the flows without a separate repo doc. Array-of-lines (single-quoted) so
// backticks/JSON quotes inside the Markdown need no escaping.
const apiDescription = [
  '# DGC Global Community API',
  '',
  'Integration guide below — base URL, headers, auth, and the sign-up / sign-in / onboarding flows. The full endpoint list is grouped by tag beneath this section.',
  '',
  '## Base URL and headers',
  '',
  '- Every endpoint is under `/api/v1` — e.g. `https://dgc-backend-bo80.onrender.com/api/v1/auth/login`.',
  '- Send `Content-Type: application/json` on every request that has a body.',
  '- Endpoints with a lock icon require the header `Authorization: Bearer <accessToken>`.',
  '- To call protected endpoints from this page, click **Authorize** (top-right) and paste an `accessToken`.',
  '',
  '> Two mistakes that have already caused bugs: forgetting `Content-Type: application/json` (the body is then ignored), and sending the OTP `code` as a number — it must be a **string** such as `"233015"`.',
  '',
  '## Responses and errors',
  '',
  'Success responses are `2xx` with a JSON body. Every error uses this exact shape:',
  '',
  '```',
  '{ "error": { "code": "BAD_REQUEST", "message": "Human-readable reason" } }',
  '```',
  '',
  'Always display `error.message`. Rendering the whole error object is what produces `[object Object]` on screen.',
  '',
  '## Tokens',
  '',
  '- `accessToken` — valid 1 hour; send it in the `Authorization` header.',
  '- `refreshToken` — valid 30 days and rotates on every use; store it securely.',
  '- On a `401` with `"Invalid or expired token"`, call `POST /api/v1/auth/refresh`, then retry the request once.',
  '- **Retry-safe on flaky networks:** if a refresh response is lost in transit, retrying with the SAME refresh token works for 60 seconds (rotation grace). Likewise a consumed OTP code can be re-verified for 90 seconds. Retries after a network error are safe — do NOT log the user out or force a new code on the first failure.',
  '- Every auth response (`login`, `verify-otp`, `google`, `refresh`, `reset-password`) includes a compact `user` object — render from it directly instead of following up with `GET /users/me`.',
  '',
  '## App launch (do this, not 5 GETs)',
  '',
  '1. Render immediately from local cache (last known state) — never block the splash screen on the network.',
  '2. Call **`GET /api/v1/bootstrap`** once: it returns `me`, `channels`, `notifications` (+ `unreadCount`), `liveAudioRooms`, and `upcomingEvents` in a single round trip. Reconcile your cached UI with it when it arrives.',
  '3. Connect the socket. Done — the app is fully live after ONE http request.',
  '',
  '## HTTP caching (free speed on repeat views)',
  '',
  'Stable GETs now send `Cache-Control: private, max-age=N` — `/branches` (300s), `/clusters` (60s), `/events` (60s), `/users/:userId` (120s). The device HTTP cache serves repeats instantly with zero network. iOS honours this automatically; on Android/React Native verify OkHttp caching or keep a small in-app cache keyed by URL that honours `max-age`. Chat, channels, and notifications are never cached — they must always be fresh.',
  '',
  '## Sign up vs. sign in — which endpoint?',
  '',
  '| Method | Sign up | Sign in |',
  '| --- | --- | --- |',
  '| Email + password | `POST /auth/register` then `POST /auth/verify-otp` | `POST /auth/login` |',
  '| Email OTP | `POST /auth/email/request-otp` then `POST /auth/verify-otp` | the same call |',
  '| Google | `POST /auth/google` | the same call |',
  '| Apple | `POST /auth/apple` | the same call |',
  '| Phone | disabled until SMS provider is configured | disabled until SMS provider is configured |',
  '',
  'There is **one verify endpoint, `POST /auth/verify-otp`** (email or phone): it finishes a pending registration if one exists, otherwise does a passwordless sign-in. For the passwordless methods (Google, Apple, email OTP) there is **no separate login endpoint** — the backend creates the account when the user is new, or signs them in when they already exist. After the call, route using `user.onboardingComplete` (see Onboarding). Only email + password has separate sign-up and sign-in endpoints.',
  '',
  '> **Phone OTP** is not active until an SMS provider is configured and returns a "not configured" error. Do not ship phone sign-in until then.',
  '',
  '## Flow 1 — Email + password registration',
  '',
  '1. `POST /api/v1/auth/register` with the Create Account form, including `branchId`. Emails one 6-digit code and returns `{ "ok": true, "retryAfterSeconds": 60 }` with a `Retry-After` header. A second submit for that email inside the window returns the same success and keeps the original code, which stays valid for 10 minutes. A Redis blip on the limiter does not return 429; the signup still sends the code. `429` is only a real limit.',
  '2. `POST /api/v1/auth/verify-otp` with `{ "identifier": "<email>", "code": "<6-char string>" }`. Finishes the full account and returns `{ "accessToken", "refreshToken", "isNewUser": true, "user": {...} }`.',
  '',
  'Because the name and branch were supplied in step 1, the account is already onboarded — go straight to the dashboard.',
  '',
  '## Flow 2 — Passwordless (Google / Apple / email OTP)',
  '',
  '- Google: `POST /api/v1/auth/google` with `{ "idToken" }`.',
  '- Apple: `POST /api/v1/auth/apple` with `{ "idToken", "fullName" }` from Authentication Services when available. `displayName`, `givenName`, and `familyName` are also accepted. The backend stores Apple-provided email from the verified ID token and uses Apple-provided name without asking the user to re-enter it.',
  '- Email OTP: `POST /api/v1/auth/email/request-otp` with `{ "email" }`, then `POST /api/v1/auth/verify-otp` with `{ "identifier": "<email>", "code" }`.',
  '',
  'All return `{ "accessToken", "refreshToken", "isNewUser", "user" }` and create a minimal account when needed. Continue with Onboarding only when `user.onboardingComplete` is false.',
  '',
  '## Onboarding (passwordless users)',
  '',
  '1. `GET /api/v1/users/me` and read `onboardingComplete`.',
  '2. When it is `false`: `GET /api/v1/branches` to fill the branch picker, then `PATCH /api/v1/users/me` with `{ "branchId" }`. Include `displayName` only if the provider did not supply one and the user chooses to add it. Setting `branchId` auto-joins the branch community and the Global Announcement channel.',
  '3. When it is `true`: go straight to the dashboard.',
  '',
  '> Use `onboardingComplete` as the source of truth (not `isNewUser`). Phone number, gender, and date of birth are optional profile fields and must not block signup, Apple sign-in, onboarding, or app use.',
  '',
  '## Login, forgot password, refresh, logout',
  '',
  '- Login (email + password): `POST /api/v1/auth/login` with `{ "email", "password" }`, returns a token pair.',
  '- Forgot password: `POST /api/v1/auth/password/request-otp` with `{ "email" }`, then `POST /api/v1/auth/password/verify-otp` with `{ "email", "code" }` to confirm the code, then `POST /api/v1/auth/reset-password` with `{ "email", "code", "newPassword" }` to change the password (also signs them in).',
  '- Refresh: `POST /api/v1/auth/refresh` with `{ "refreshToken" }` (no Bearer header). Returns a new pair; the old refresh token stops working after a 60s grace window (safe to retry after a network error).',
  '- Logout: `POST /api/v1/auth/logout` with `{ "refreshToken" }` (Bearer header).',
  '',
  '## Delete account',
  '',
  '`DELETE /api/v1/users/me` (Bearer). The account is identified from the token, so a user can only delete themselves. This is a permanent purge and frees the email/phone for reuse.',
  '',
  '## Push notification registration',
  '',
  'Call `POST /api/v1/users/me/devices` after login, app launch, and every push-token refresh.',
  '',
  'Android/Web: send the Firebase Cloud Messaging registration token as `fcmToken` or `token`.',
  '',
  'iOS React Native fallback: send the APNs token as `apnsToken` or `token`. The backend sends these directly to Apple APNs, so Render must have `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_BASE64`, and `APNS_ENV` set.',
  '',
  'Good iOS APNs payload: `{ "platform": "IOS", "apnsToken": "<64-char APNs token>" }`. Optional PushKit VoIP tokens belong in `apnsVoipToken`, not the main token.',
  '',
  '## Push tap / action contract',
  '',
  'All push payloads include string data fields for routing. The mobile app should prefer `data.deepLink`, then fall back to `route` / `screen`.',
  '',
  'Android: create notification channels `messages`, `audio_rooms`, `events`, and `calls`. The backend sets `android.notification.clickAction` from `data.clickAction`, so declare matching intent filters or handle the data in the notification-open callback.',
  '',
  'Quick reply: message notifications are marked with `notificationCategory=MESSAGE_REPLY` and `quickReplyAction=MESSAGE_REPLY`. Register this category/action in the app and render the reply input locally; FCM does not create the Reply button from the backend payload alone.',
  '',
  'Known deep links: `dgc://channels/{channelId}/messages/{messageId}`, `dgc://prayer-watch/rooms/{roomId}`, `dgc://audio-rooms/{roomId}`, `dgc://events/{eventId}`, `dgc://channels/{channelId}/calls/{callId}`.',
  '',
  '## Avatar / file upload',
  '',
  '1. `POST /api/v1/media/signature` with `{ "type": "avatar" }` returns signed upload params.',
  '2. Upload the file directly to the returned `uploadUrl` (Cloudinary, multipart/form-data); Cloudinary returns a `secure_url`.',
  '3. `PATCH /api/v1/users/me` with `{ "avatarUrl": "<secure_url>" }`.',
  '',
  '**Make uploads fast on bad networks:**',
  '- **Cache the signature.** The response includes `expiresAt` (1 hour). Reuse one cached signature per `type` for every upload until then — do NOT call `/media/signature` before each upload. First upload of the hour pays one extra round trip; the rest pay zero.',
  '- **Compress before uploading.** Resize images to max 1600px and ~80% JPEG quality on-device (expo-image-manipulator) before sending. A 6MB camera photo becomes ~300KB — the difference between a 90-second and a 4-second upload on 3G.',
  '',
  '**Displaying media:** the backend now stores chat images and avatars as optimized delivery URLs (`f_auto,q_auto`, size-capped) — render `mediaUrl`/`avatarUrl` as-is. Message payloads also include **`thumbUrl`** (small image preview, or a poster frame for videos): use `thumbUrl` while scrolling the chat list and load `mediaUrl` only when the user opens the media full-screen.',
  '',
  '## Realtime (Socket.io)',
  '',
  'Connect to the root host (not `/api/v1`) using the same access token:',
  '',
  '```',
  'io("https://dgc-backend-bo80.onrender.com", { auth: { token: accessToken }, transports: ["websocket"] })',
  '```',
  '',
  'On connect you are auto-joined to `user:<yourId>` (notifications) and to `channel:<id>` for every channel you belong to.',
  '',
  '### Presence',
  '',
  'The server tracks online/away/offline status via Redis with a 120-second TTL.',
  '',
  '- **Listen** `presence` — `{ userId, status, lastSeenAt? }` where status is `"online"` | `"away"` | `"offline"`. Sent only to sockets watching that user (DM peers are watched automatically on connect; others via `presence:subscribe`). `lastSeenAt` is included when status is `"offline"`.',
  '- **Emit** `presence:subscribe` — `{ userIds: string[] }` (max 500 watched per socket). Ack: `{ statuses: { [userId]: status } }`. Watches reset on reconnect.',
  '- **Emit** `presence:unsubscribe` — `{ userIds: string[] }`.',
  '- **Emit** `presence:heartbeat` — send every ~60s to stay online. Payload: `{}` for online, `{ status: "away" }` when app is backgrounded. If the server receives no heartbeat within 120s, the user is marked offline automatically (announced within ~3 minutes, with `lastSeenAt` set to their last heartbeat).',
  '- **Listen** `presence:online-snapshot` (super admins only) — sent on connect: `{ onlineCount, users: [{ userId, status, lastActiveAt }], hasMore }`, most recently active first, up to 5000 users.',
  '- **Listen** `presence:admin-update` (super admins only) — `{ userId, status, onlineCount, lastSeenAt? }` on every status change.',
  '',
  'The REST endpoints `GET /channels` (DM peer) and `GET /channels/:id/members` include a `status` field on each user. The DM peer in `GET /channels` and `GET /users/:id` also include `lastSeenAt` (null if never recorded). Super admins can page through online users with `GET /admin/online-users`.',
  '',
  '### Typing indicators',
  '',
  '- **Emit** `typing:start` — `{ channelId }`. Send when the user starts typing (debounce on the client).',
  '- **Emit** `typing:stop` — `{ channelId }`. Send when the user stops typing or clears the input.',
  '- **Listen** `typing:start` — `{ channelId, userId, displayName }`. Show "{displayName} is typing…" in the chat UI.',
  '- **Listen** `typing:stop` — `{ channelId, userId, displayName }`. Remove the typing indicator.',
  '',
  '### Mark-read (socket)',
  '',
  '- **Emit** `channel:markRead` — `{ channelId }`. Updates `lastReadAt` server-side so unread counts drop to 0. No REST call needed (though `POST /channels/:id/read` remains available as a fallback).',
  '',
  '### All socket events',
  '',
  '| Event | Direction | Payload |',
  '|---|---|---|',
  '| `presence` | listen | `{ userId, status, lastSeenAt? }` |',
  '| `presence:online-snapshot` | listen (super admin) | `{ onlineCount, users, hasMore }` |',
  '| `presence:admin-update` | listen (super admin) | `{ userId, status, onlineCount, lastSeenAt? }` |',
  '| `presence:heartbeat` | emit | `{ status? }` |',
  '| `presence:subscribe` | emit (ack) | `{ userIds }` → `{ statuses }` |',
  '| `presence:unsubscribe` | emit | `{ userIds }` |',
  '| `typing:start` | emit / listen | `{ channelId, userId?, displayName? }` |',
  '| `typing:stop` | emit / listen | `{ channelId, userId?, displayName? }` |',
  '| `channel:markRead` | emit | `{ channelId }` |',
  '| `channel:join` | emit | `{ channelId }` |',
  '| `message:new` | listen | full message object |',
  '| `reaction:add` / `reaction:remove` | listen | `{ messageId, emoji, userId }` |',
  '| `message:pinned` / `message:unpinned` | listen | `{ messageId }` |',
  '| `message:deleted` | listen | `{ messageId }` |',
  '| `notification:new` | listen | notification object |',
  '| `call:incoming` | listen | call object (sent to callee) |',
  '| `call:ringing` | listen | call object (sent to caller devices) |',
  '| `call:busy` | listen | `{ channelId, userId, activeCallId, selfBusy }` |',
  '| `call:answered` | listen | call object + viewer-specific `agora` credentials |',
  '| `call:declined` | listen | call object |',
  '| `call:ended` | listen | call object; status may be `ENDED`, `MISSED`, or `CANCELLED` |',
  '| `audio-room:incoming` | listen | `{ roomId, channelId, title, channelName, startedById, startedByName, startedByAvatarUrl, createdAt, expiresAt }` for channel group calls |',
  '| `audio-room:user-joined` | listen | participant object |',
  '| `audio-room:user-left` | listen | `{ roomId, userId }` |',
  '| `audio-room:role-changed` | listen | `{ roomId, userId, role }` |',
  '| `audio-room:hand-raised` | listen | `{ roomId, userId }` |',
  '| `audio-room:hand-lowered` | listen | `{ roomId, userId }` |',
  '| `audio-room:ended` | listen | `{ roomId }` |',
  '| `audio-room:kicked` | listen | `{ roomId }` (sent to the kicked user only) |',
  '| `audio-room:muted` | listen | `{ roomId, mutedBy }` — sent to the muted user; client is expected to mute its local mic |',
  '| `audio-room:user-muted` | listen | `{ roomId, userId, mutedBy }` — broadcast so the whole room UI reflects the mute state |',
  '| `audio-room:user-unmuted` | listen | `{ roomId, userId }` — broadcast so the whole room UI clears the mute state |',
  '| `audio-room:token` | listen | `{ roomId, appId, token, channel, uid }` (sent when promoted to speaker, or on step-down as an audience token) |',
  '',
  'Sending a message is a REST call (`POST /api/v1/channels/{channelId}/messages`); the server then broadcasts `message:new` to the channel room.',
  '',
  '### Message send UX contract',
  '',
  '- Always include a stable `clientMessageId` generated on the device before the first send attempt. Reuse the same `clientMessageId` on automatic retries. The backend returns the existing stored message on duplicate retries, so the UI can avoid double bubbles.',
  '- Render an optimistic local message immediately with pending/clock state. Replace it when either the REST response or `message:new` arrives with the same `clientMessageId`; then show sent/delivered state.',
  '- Message push payloads include `route=CHAT`, `screen=CHAT`, `clickAction=OPEN_CHAT`, `androidChannelId=messages`, `channelId`, `messageId`, `deepLink`, `notificationCategory=MESSAGE_REPLY`, and `quickReplyAction=MESSAGE_REPLY`.',
  '- On push tap, navigate to the channel in `channelId`. If `messageId` is not already in local state, call `GET /api/v1/channels/{channelId}/messages/{messageId}` and merge it into the list.',
  '- For quick reply notification actions, send `POST /api/v1/channels/{channelId}/messages` with `{ "type": "TEXT", "body": "<reply>", "clientMessageId": "<local uuid>" }`.',
  '',
  '## DM Calls (Agora)',
  '',
  '1:1 WhatsApp-style calling is signaling + Agora RTC tokens. The backend supports both `AUDIO` and `VIDEO`; ship voice-first by sending `{ "type": "AUDIO" }`.',
  '',
  '### Flow',
  '',
  '1. Caller starts a call: `POST /api/v1/dms/:channelId/calls` with `{ "type": "AUDIO" | "VIDEO" }`. Response includes the call row and `agora: { appId, token, channel, uid, media }` for the caller.',
  '2. Callee receives `call:incoming` over socket plus a high-priority FCM data payload with `notificationType=CALL`, `callAction=incoming`, `callId`, `channelId`, `callType`, `agoraChannel`, caller fields, and `expiresAt`.',
  '3. Callee answers: `POST /api/v1/calls/:callId/answer`. Response includes Agora credentials for the callee. Both users receive `call:answered` with viewer-specific Agora credentials, so the caller can safely join media on this event if it did not already join from the start response.',
  '4. Callee declines: `POST /api/v1/calls/:callId/decline`. Both users receive `call:declined`.',
  '5. Either user hangs up an answered call: `POST /api/v1/calls/:callId/end`. The caller can also use this endpoint to cancel a still-ringing outgoing call. Both users receive `call:ended`.',
  '6. If nobody answers in about 30 seconds, a background job marks the call `MISSED`, emits `call:ended`, and sends a normal missed-call notification.',
  '7. Call history for the DM: `GET /api/v1/dms/:channelId/calls?cursor=&limit=`.',
  '8. Agora tokens can be refreshed while active: `POST /api/v1/calls/:callId/token`.',
  '',
  'For Android, create a `calls` notification channel and route `androidFullScreenIntent=true` / `androidForegroundService=true` call data to the foreground service + full-screen intent. For iOS killed-state ringing, route the same call data through CallKit/PushKit VoIP infrastructure when the VoIP certificate flow is ready; the FCM data payload already carries the required fields.',
  '',
  '## Audio Rooms (Agora)',
  '',
  'Clubhouse-style live audio. The backend manages room lifecycle, participants, and roles; Agora handles the actual audio transport.',
  '',
  '### Flow',
  '',
  '1. Create a room: `POST /api/v1/audio-rooms` — starts live immediately (or set `scheduledFor` for later). **Permission** (PRD §3): super admin (any room), branch admin (rooms scoped to their branch via `branchId`), cluster moderator (rooms scoped to their cluster via `clusterId`). Unscoped rooms are super-admin-only.',
  '2. For scheduled rooms, host / branch admin / cluster moderator calls `POST /audio-rooms/:id/start` when ready.',
  '3. Users join: `POST /audio-rooms/:id/join` — returns an Agora token + `{ appId, channel, uid }`.',
  '4. On the frontend, use `react-native-agora` with `ChannelProfileLiveBroadcasting` + `setClientRole(BROADCASTER)` for HOST/SPEAKER, `AUDIENCE` for LISTENER.',
  '5. Listeners can raise hand: `POST /audio-rooms/:id/raise-hand` (or lower with `DELETE`).',
  '6. Moderator promotes: `POST /audio-rooms/:id/promote` with `{ userId, role: "SPEAKER" }` — the promoted user receives a new Agora token via `audio-room:token` socket event (publisher role). Host, super admin, or the room\'s branch admin / cluster moderator can do this.',
  '7. Speaker steps themself down: `POST /audio-rooms/:id/step-down` — response includes a fresh audience-role Agora token.',
  '8. Moderator soft-mutes a speaker: `POST /audio-rooms/:id/participants/:userId/mute`. The target receives `audio-room:muted`; the whole room receives `audio-room:user-muted`. Clients are expected to honor it (Agora doesn\'t offer server-forced mute at our tier — kick via `DELETE /audio-rooms/:id/participants/:userId` is the hard fallback).',
  '9. Moderator or self unmute clears the badge: `POST /audio-rooms/:id/participants/:userId/unmute`. The whole room receives `audio-room:user-unmuted` with `{ roomId, userId }`.',
  '10. Tokens expire after 1 hour — call `POST /audio-rooms/:id/token` to refresh before expiry.',
  '11. Moderator ends room: `POST /audio-rooms/:id/end` — all participants get `audio-room:ended`.',
  '',
  '### Channel group calls',
  '',
  'Any non-DM, non-Global-Prayer-Watch channel can host one live group call at a time. Members start it with `POST /api/v1/channels/:channelId/call/start`; if one is already live, the same endpoint joins the caller and returns `alreadyLive: true`.',
  '',
  '**Call rules:**',
  '- Only channel members can see/join the channel call. Read-only channels require a channel moderator/admin or super admin to start the call.',
  '- The room is persistent like Prayer Watch: it stays live if the starter leaves and ends only when the last participant leaves, or when a moderator ends it.',
  '- Everyone joins as HOST/SPEAKER with publisher Agora credentials, like Global Prayer Watch.',
  '- On new call start, the server emits `audio-room:incoming` to the channel socket room and sends call-style FCM only to non-muted members of that channel, excluding the starter.',
  '',
  '**Flow:**',
  '1. Chat mount: `GET /api/v1/channels/:channelId/call` → `{ channelId, live }`. Show a join-call banner when `live` is not null.',
  '2. Start/tap join: `POST /api/v1/channels/:channelId/call/start`. Response includes full audio-room detail + `agora` + `alreadyLive`.',
  '3. Incoming ring: listen for `audio-room:incoming` or handle FCM payloads where `notificationType=CALL`, `callKind=CHANNEL_AUDIO_ROOM`, `roomId`, `channelId`, `channelName`, and caller fields are present. The notification title is "{name} started a call". `callerName` is the name only, and the body is the channel name. Tap should open the channel call and join with `POST /api/v1/audio-rooms/:roomId/join` or the channel start endpoint.',
  '',
  '### Global Prayer Watch (singleton channel + live prayer call)',
  '',
  '**"DGC Global Prayer Watch"** is a singleton channel every user is auto-joined to during onboarding (alongside "DGC Global Announcement"). Existing users were backfilled. It works as an ordinary chat channel — send messages via the standard `POST /channels/:channelId/messages` — AND members can spin up a live prayer audio call inside it whenever none is currently live.',
  '',
  '**Call rules:**',
  '- Any authenticated member can start a call (`POST /prayer-watch/start`). Only one active call at a time — a second Start attaches you to the existing call as a SPEAKER instead of creating a duplicate.',
  '- The call stays live even if the starter leaves. It auto-ends only when the **last** participant leaves.',
  '- The starter is HOST for the duration they\'re in the call. Prayer Warriors cluster moderators (and super admins) can moderate (mute/promote/kick) regardless of whether they started it, and can force-end via `POST /prayer-watch/:roomId/end`.',
  '- On start, the server fan-outs a push whose title is "{name} started a call" and whose body is "Prayer Watch". Payloads include `title`, `callerName` (the name only), `callerId`, `callerAvatarUrl`, `route=PRAYER_WATCH`, `screen=PRAYER_WATCH`, `clickAction=OPEN_PRAYER_WATCH`, `roomId`, `channelId`, and `deepLink=dgc://prayer-watch/rooms/{roomId}`.',
  '',
  '**Flow:**',
  '1. Home mount: `GET /api/v1/prayer-watch` → response `{ channelId, live }`. Show a "Join Prayer Watch" banner when `live` is not null.',
  '2. Member starts a call: `POST /api/v1/prayer-watch/start`. Response includes full room detail + Agora `{appId, token, channel, uid}` (host token) + `alreadyLive: false`.',
  '3. Another member joins the ongoing call: same `POST /prayer-watch/start`. Response returns the same room + Agora publisher token + `alreadyLive: true`. (Or they can call `POST /audio-rooms/:id/join` directly if they already know the roomId.)',
  '4. Chat in the channel: standard `POST /channels/:channelId/messages` using the `channelId` from step 1. Every message shows up in the channel like any general chat.',
  '5. Member leaves the call: `POST /audio-rooms/:id/leave`. If they were the last one, the call ends and everyone receives `audio-room:ended`.',
  '6. Prayer Warriors moderator force-ends: `POST /api/v1/prayer-watch/:roomId/end`.',
  '7. Moderation while live: `promote`, `kick`, `mute`, `unmute`, `step-down` all use the standard audio-room endpoints — Prayer Warriors cluster moderators are recognised automatically for PRAYER_WATCH rooms.',
  '',
  '### Scheduled-room reminders',
  '',
  'A background scan (every 5 min) watches scheduled rooms. ~15 minutes before `scheduledFor`, users who tapped Remind Me get a "Starting soon" push, and the host gets a nudge to go live. When the host actually starts the room, Remind-Me users are notified again ("room is live") and the reminder is cleared.',
  '',
  '### Agora setup',
  '',
  'The backend generates RTC tokens server-side. Set `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` in the environment. The frontend uses `react-native-agora` with `appId` + `token` + `channelName` + `uid` from the join response.',
].join('\n');

export function mountDocs(app: Express) {
  try {
    const generator = new OpenApiGeneratorV3(registry.definitions);
    const spec = generator.generateDocument({
      openapi: '3.0.0',
      info: { title: 'DGC Global Community API', version: '1.0.0', description: apiDescription },
      servers: [{ url: '/' }],
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
    app.get('/openapi.json', (_req, res) => res.json(spec));
    logger.info('Swagger UI mounted at /docs');
  } catch (err) {
    logger.error({ err }, 'Failed to mount OpenAPI docs');
  }
}

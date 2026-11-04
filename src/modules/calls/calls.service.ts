import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/db';
import { buildRtcToken, isAgoraConfigured } from '../../infra/agora';
import { env } from '../../config/env';
import { emitToUser } from '../../infra/realtime';
import { notificationQueue } from '../../infra/queue';
import { enqueue } from '../../infra/enqueue';
import { pushService } from '../push/push.service';
import { notificationService } from '../notifications/notifications.service';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors';
import type { InitiateCallInput, ListCallsInput } from './calls.schema';
import { directCallPush } from './callPushCopy';

export const CALL_RING_TIMEOUT_MS = 30_000;

const LIVE_STATUSES = ['RINGING', 'ANSWERED'] as const;

const USER_SELECT = {
  id: true,
  displayName: true,
  avatarUrl: true,
} as const;

const CALL_SELECT = {
  id: true,
  channelId: true,
  callerId: true,
  calleeId: true,
  type: true,
  status: true,
  agoraChannel: true,
  createdAt: true,
  answeredAt: true,
  endedAt: true,
  endedById: true,
  durationMs: true,
  caller: { select: USER_SELECT },
  callee: { select: USER_SELECT },
} as const;

type CallRecord = Prisma.CallGetPayload<{ select: typeof CALL_SELECT }>;
type Tx = Prisma.TransactionClient;

function stableUid(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 2_000_000_000) || 1;
}

function displayName(user: { displayName: string | null }) {
  return user.displayName ?? 'Someone';
}

function mediaLabel(type: 'AUDIO' | 'VIDEO') {
  return type === 'VIDEO' ? 'video' : 'voice';
}

function ringingExpiresAt(call: Pick<CallRecord, 'createdAt'>) {
  return new Date(call.createdAt.getTime() + CALL_RING_TIMEOUT_MS);
}

function encodeCursor(call: { createdAt: Date; id: string }) {
  return `${call.createdAt.toISOString()}_${call.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const i = cursor.lastIndexOf('_');
  if (i < 0) return null;
  const createdAt = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

function agoraCredentials(call: Pick<CallRecord, 'agoraChannel' | 'type'>, userId: string) {
  const uid = stableUid(userId);
  return {
    appId: isAgoraConfigured() ? env.AGORA_APP_ID! : null,
    token: isAgoraConfigured() ? buildRtcToken(call.agoraChannel, uid, 'host') : null,
    channel: call.agoraChannel,
    uid,
    media: { audio: true, video: call.type === 'VIDEO' },
  };
}

function callData(call: CallRecord, action: 'incoming' | 'answered' | 'declined' | 'ended' | 'missed' | 'cancelled') {
  return {
    type: 'call',
    notificationType: 'CALL',
    route: 'CALL',
    screen: action === 'incoming' ? 'INCOMING_CALL' : 'CALL_DETAIL',
    clickAction: action === 'incoming' ? 'INCOMING_CALL' : 'OPEN_CALL',
    androidChannelId: 'calls',
    callAction: action,
    callId: call.id,
    channelId: call.channelId,
    callType: call.type,
    status: call.status,
    agoraChannel: call.agoraChannel,
    callerId: call.callerId,
    calleeId: call.calleeId,
    callerName: displayName(call.caller),
    callerAvatarUrl: call.caller.avatarUrl ?? '',
    createdAt: call.createdAt.toISOString(),
    expiresAt: ringingExpiresAt(call).toISOString(),
    deepLink: `dgc://channels/${call.channelId}/calls/${call.id}`,
  };
}

function serializeCall(call: CallRecord, viewerId: string) {
  return {
    ...call,
    direction: call.callerId === viewerId ? 'OUTGOING' : 'INCOMING',
    ringingExpiresAt: ringingExpiresAt(call),
  };
}

function withAgora(call: CallRecord, viewerId: string) {
  return {
    ...serializeCall(call, viewerId),
    agora: agoraCredentials(call, viewerId),
  };
}

function emitSerializedToParticipants(call: CallRecord, event: string) {
  emitToUser(call.callerId, event, serializeCall(call, call.callerId));
  if (call.calleeId !== call.callerId) emitToUser(call.calleeId, event, serializeCall(call, call.calleeId));
}

function emitWithAgoraToParticipants(call: CallRecord, event: string) {
  emitToUser(call.callerId, event, withAgora(call, call.callerId));
  if (call.calleeId !== call.callerId) emitToUser(call.calleeId, event, withAgora(call, call.calleeId));
}

async function lockUsers(tx: Tx, userIds: string[]) {
  for (const userId of [...new Set(userIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  }
}

async function requireDmPeer(tx: Tx, channelId: string, callerId: string) {
  const channel = await tx.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      type: true,
      memberships: {
        select: {
          userId: true,
          user: { select: USER_SELECT },
        },
      },
    },
  });
  if (!channel) throw NotFound('DM not found');
  if (channel.type !== 'DM') throw BadRequest('Calls are only available in DMs');
  if (channel.memberships.length !== 2) throw BadRequest('DM calls require exactly two participants');
  const caller = channel.memberships.find((m) => m.userId === callerId);
  if (!caller) throw Forbidden('You are not a participant in this DM');
  const callee = channel.memberships.find((m) => m.userId !== callerId);
  if (!callee) throw BadRequest('DM peer not found');
  return { calleeId: callee.userId, callee: callee.user };
}

async function requireDmMember(userId: string, channelId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      type: true,
      memberships: { select: { userId: true } },
    },
  });
  if (!channel) throw NotFound('DM not found');
  if (channel.type !== 'DM') throw BadRequest('Calls are only available in DMs');
  if (!channel.memberships.some((m) => m.userId === userId)) {
    throw Forbidden('You are not a participant in this DM');
  }
}

async function findActiveCallForUsers(tx: Tx, userIds: string[], excludeCallId?: string) {
  return tx.call.findFirst({
    where: {
      ...(excludeCallId ? { id: { not: excludeCallId } } : {}),
      status: { in: [...LIVE_STATUSES] },
      OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }],
    },
    select: { id: true, callerId: true, calleeId: true, channelId: true, status: true },
  });
}

export const callService = {
  async initiate(userId: string, channelId: string, dto: InitiateCallInput) {
    const result = await prisma.$transaction(async (tx) => {
      const { calleeId } = await requireDmPeer(tx, channelId, userId);
      await lockUsers(tx, [userId, calleeId]);

      const duplicate = await tx.call.findFirst({
        where: {
          channelId,
          callerId: userId,
          calleeId,
          status: 'RINGING',
          createdAt: { gte: new Date(Date.now() - CALL_RING_TIMEOUT_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: CALL_SELECT,
      });
      if (duplicate) return { kind: 'ok' as const, call: duplicate, created: false };

      const active = await findActiveCallForUsers(tx, [userId, calleeId]);
      if (active) {
        const selfBusy = active.callerId === userId || active.calleeId === userId;
        return {
          kind: 'busy' as const,
          userId: selfBusy ? userId : calleeId,
          activeCallId: active.id,
          selfBusy,
        };
      }

      const call = await tx.call.create({
        data: {
          channelId,
          callerId: userId,
          calleeId,
          type: dto.type,
          agoraChannel: `dgc_call_${randomUUID().replace(/-/g, '')}`,
        },
        select: CALL_SELECT,
      });
      return { kind: 'ok' as const, call, created: true };
    });

    if (result.kind === 'busy') {
      emitToUser(userId, 'call:busy', {
        channelId,
        userId: result.userId,
        activeCallId: result.activeCallId,
        selfBusy: result.selfBusy,
      });
      throw Conflict(result.selfBusy ? 'You are already on another call' : 'User is already on another call');
    }

    if (result.created) {
      const incomingPayload = serializeCall(result.call, result.call.calleeId);
      emitToUser(result.call.calleeId, 'call:incoming', incomingPayload);
      emitToUser(result.call.callerId, 'call:ringing', serializeCall(result.call, result.call.callerId));
      enqueue(
        notificationQueue,
        'call-incoming-push',
        { callId: result.call.id },
        { jobId: `call-incoming-${result.call.id}` },
      );
      enqueue(
        notificationQueue,
        'call-timeout',
        { callId: result.call.id },
        { delay: CALL_RING_TIMEOUT_MS, jobId: `call-timeout-${result.call.id}` },
      );
    }

    return withAgora(result.call, userId);
  },

  async listForDm(userId: string, _role: string, channelId: string, opts: ListCallsInput) {
    await requireDmMember(userId, channelId);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await prisma.call.findMany({
      where: {
        channelId,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: CALL_SELECT,
    });
    const hasMore = rows.length > opts.limit;
    const calls = rows.slice(0, opts.limit);
    const last = calls[calls.length - 1];
    return {
      calls: calls.map((call) => serializeCall(call, userId)),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  },

  async answer(userId: string, callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call) throw NotFound('Call not found');
    if (call.calleeId !== userId) throw Forbidden('Only the callee can answer this call');
    if (call.status !== 'RINGING') throw BadRequest('Call is no longer ringing');

    const active = await prisma.$transaction(async (tx) => {
      await lockUsers(tx, [call.callerId, call.calleeId]);
      return findActiveCallForUsers(tx, [userId], callId);
    });
    if (active) throw Conflict('You are already on another call');

    const now = new Date();
    const updated = await prisma.call.updateMany({
      where: { id: callId, status: 'RINGING' },
      data: { status: 'ANSWERED', answeredAt: now },
    });
    if (updated.count === 0) throw BadRequest('Call is no longer ringing');

    const answered = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!answered) throw NotFound('Call not found');
    emitWithAgoraToParticipants(answered, 'call:answered');
    return withAgora(answered, userId);
  },

  async decline(userId: string, callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call) throw NotFound('Call not found');
    if (call.calleeId !== userId) throw Forbidden('Only the callee can decline this call');
    if (call.status !== 'RINGING') throw BadRequest('Call is no longer ringing');

    const now = new Date();
    const updated = await prisma.call.updateMany({
      where: { id: callId, status: 'RINGING' },
      data: { status: 'DECLINED', endedAt: now, endedById: userId },
    });
    if (updated.count === 0) throw BadRequest('Call is no longer ringing');

    const declined = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!declined) throw NotFound('Call not found');
    emitSerializedToParticipants(declined, 'call:declined');
    return serializeCall(declined, userId);
  },

  async end(userId: string, callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call) throw NotFound('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw Forbidden('You are not a participant in this call');
    if (!LIVE_STATUSES.includes(call.status as (typeof LIVE_STATUSES)[number])) {
      throw BadRequest('Call is already finished');
    }
    if (call.status === 'RINGING' && call.callerId !== userId) {
      throw BadRequest('Use decline to reject an incoming call');
    }

    const now = new Date();
    const status = call.status === 'RINGING' ? 'CANCELLED' : 'ENDED';
    const durationMs = call.answeredAt ? Math.max(0, now.getTime() - call.answeredAt.getTime()) : null;
    const updated = await prisma.call.updateMany({
      where: { id: callId, status: { in: [...LIVE_STATUSES] } },
      data: { status, endedAt: now, endedById: userId, durationMs },
    });
    if (updated.count === 0) throw BadRequest('Call is already finished');

    const ended = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!ended) throw NotFound('Call not found');
    emitSerializedToParticipants(ended, 'call:ended');
    return serializeCall(ended, userId);
  },

  async token(userId: string, callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call) throw NotFound('Call not found');
    if (call.callerId !== userId && call.calleeId !== userId) throw Forbidden('You are not a participant in this call');
    if (call.status !== 'RINGING' && call.status !== 'ANSWERED') throw BadRequest('Call is not active');
    return agoraCredentials(call, userId);
  },

  async sendIncomingPush(callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call || call.status !== 'RINGING') return { ok: false, skipped: true };
    const named = directCallPush(displayName(call.caller), call.type);
    await pushService.sendIncomingCallToUser(call.calleeId, {
      title: named.title,
      body: named.body,
      data: callData(call, 'incoming'),
      ttlMs: Math.max(1_000, ringingExpiresAt(call).getTime() - Date.now()),
    });
    return { ok: true };
  },

  async markMissed(callId: string) {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!call || call.status !== 'RINGING') return { ok: false, skipped: true };

    const now = new Date();
    const updated = await prisma.call.updateMany({
      where: { id: callId, status: 'RINGING' },
      data: { status: 'MISSED', endedAt: now, durationMs: null },
    });
    if (updated.count === 0) return { ok: false, skipped: true };

    const missed = await prisma.call.findUnique({ where: { id: callId }, select: CALL_SELECT });
    if (!missed) return { ok: false, skipped: true };
    emitSerializedToParticipants(missed, 'call:ended');
    await notificationService.notify(missed.calleeId, {
      type: 'CALL',
      title: `Missed ${mediaLabel(missed.type)} call`,
      body: `${displayName(missed.caller)} tried to call you`,
      data: callData(missed, 'missed'),
    });
    return { ok: true, callId };
  },

  async markExpiredRingingCalls() {
    const cutoff = new Date(Date.now() - CALL_RING_TIMEOUT_MS);
    const rows = await prisma.call.findMany({
      where: { status: 'RINGING', createdAt: { lte: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    let missed = 0;
    for (const row of rows) {
      const result = await this.markMissed(row.id);
      if (result.ok) missed += 1;
    }
    return { calls: rows.length, missed };
  },
};

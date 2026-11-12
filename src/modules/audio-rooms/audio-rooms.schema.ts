import { z } from 'zod';

export const createRoomSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  branchId: z.string().optional(),
  clusterId: z.string().optional(),
  scheduledFor: z.coerce.date().optional(),
});

export const updateRoomSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  scheduledFor: z.coerce.date().optional(),
});

export const promoteSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['SPEAKER', 'LISTENER']),
});

export const micSchema = z.object({
  hold: z.boolean(),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;

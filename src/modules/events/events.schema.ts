import { z } from 'zod';

// Optional id that treats "" (common from forms/Swagger) as "not provided". Without this an empty
// string slips past the branch-vs-cluster guard, then hits the foreign key and causes a 500.
const optionalId = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

// "" clears the flyer on edit. A missing field leaves it unchanged. Only https is stored.
const optionalImageUrl = z
  .union([z.string().max(2000), z.literal('')])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length ? trimmed : null;
  })
  .refine((v) => v == null || v.startsWith('https://'), { message: 'Image must be an https link' });

export const createEventSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().optional(),
    imageUrl: optionalImageUrl,
    branchId: optionalId, // branch event
    clusterId: optionalId, // cluster event; neither = global
  })
  .strict();

// Edit an existing event — scope (branchId/clusterId) is fixed; delete + recreate to move scope.
export const updateEventSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    imageUrl: optionalImageUrl,
  })
  .strict();

export const rsvpSchema = z.object({ status: z.enum(['GOING', 'INTERESTED', 'NOT_GOING']) });

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

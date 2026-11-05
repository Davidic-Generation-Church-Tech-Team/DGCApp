import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { noStore } from '../../middleware/cacheControl';
import { asyncHandler } from '../../utils/asyncHandler';
import { createEventSchema, updateEventSchema, rsvpSchema } from './events.schema';
import { eventController } from './events.controller';

export const eventsRouter = Router();

eventsRouter.get('/', authenticate, noStore, asyncHandler(eventController.list));
eventsRouter.post('/', authenticate, validate(createEventSchema), asyncHandler(eventController.create));
eventsRouter.get('/:eventId', authenticate, noStore, asyncHandler(eventController.get));
eventsRouter.patch('/:eventId', authenticate, validate(updateEventSchema), asyncHandler(eventController.update));
eventsRouter.delete('/:eventId', authenticate, asyncHandler(eventController.remove));
eventsRouter.post('/:eventId/rsvp', authenticate, validate(rsvpSchema), asyncHandler(eventController.rsvp));
eventsRouter.delete('/:eventId/rsvp', authenticate, asyncHandler(eventController.unrsvp));
eventsRouter.post('/:eventId/checkin', authenticate, asyncHandler(eventController.checkIn));

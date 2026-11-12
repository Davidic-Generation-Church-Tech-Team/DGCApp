import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { createRoomSchema, updateRoomSchema, promoteSchema, micSchema } from './audio-rooms.schema';
import { audioRoomController } from './audio-rooms.controller';

export const audioRoomsRouter = Router();

audioRoomsRouter.post('/', authenticate, validate(createRoomSchema), asyncHandler(audioRoomController.create));
audioRoomsRouter.get('/', authenticate, asyncHandler(audioRoomController.list));
audioRoomsRouter.get('/:roomId', authenticate, asyncHandler(audioRoomController.get));
audioRoomsRouter.patch('/:roomId', authenticate, validate(updateRoomSchema), asyncHandler(audioRoomController.update));
audioRoomsRouter.post('/:roomId/start', authenticate, asyncHandler(audioRoomController.start));
audioRoomsRouter.post('/:roomId/end', authenticate, asyncHandler(audioRoomController.end));
audioRoomsRouter.post('/:roomId/join', authenticate, asyncHandler(audioRoomController.join));
audioRoomsRouter.post('/:roomId/leave', authenticate, asyncHandler(audioRoomController.leave));
audioRoomsRouter.post('/:roomId/raise-hand', authenticate, asyncHandler(audioRoomController.raiseHand));
audioRoomsRouter.delete('/:roomId/raise-hand', authenticate, asyncHandler(audioRoomController.lowerHand));
audioRoomsRouter.post('/:roomId/remind', authenticate, asyncHandler(audioRoomController.remind));
audioRoomsRouter.delete('/:roomId/remind', authenticate, asyncHandler(audioRoomController.unremind));
audioRoomsRouter.post('/:roomId/promote', authenticate, validate(promoteSchema), asyncHandler(audioRoomController.promote));
audioRoomsRouter.post('/:roomId/step-down', authenticate, asyncHandler(audioRoomController.stepDown));
audioRoomsRouter.post('/:roomId/mic', authenticate, validate(micSchema), asyncHandler(audioRoomController.setMic));
audioRoomsRouter.post('/:roomId/mute-all', authenticate, asyncHandler(audioRoomController.muteAll));
audioRoomsRouter.post('/:roomId/participants/:userId/mute', authenticate, asyncHandler(audioRoomController.mute));
audioRoomsRouter.post('/:roomId/participants/:userId/unmute', authenticate, asyncHandler(audioRoomController.unmute));
audioRoomsRouter.delete('/:roomId/participants/:userId', authenticate, asyncHandler(audioRoomController.kick));
audioRoomsRouter.post('/:roomId/token', authenticate, asyncHandler(audioRoomController.refreshToken));

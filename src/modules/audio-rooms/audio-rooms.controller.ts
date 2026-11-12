import type { Request, Response } from 'express';
import { audioRoomService } from './audio-rooms.service';

export const audioRoomController = {
  async create(req: Request, res: Response) {
    res.status(201).json(await audioRoomService.create(req.user!.sub, req.user!.role, req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await audioRoomService.update(req.user!.sub, req.user!.role, req.params.roomId as string, req.body));
  },
  async list(req: Request, res: Response) {
    const filter = (req.query.filter as 'live' | 'scheduled' | 'ended') || 'live';
    res.json(await audioRoomService.list(req.user!.sub, filter, req.query.branchId as string, req.query.clusterId as string));
  },
  async get(req: Request, res: Response) {
    res.json(await audioRoomService.get(req.user!.sub, req.params.roomId as string, req.user!.role));
  },
  async channelCallStatus(req: Request, res: Response) {
    res.json(await audioRoomService.channelCallStatus(req.user!.sub, req.user!.role, req.params.channelId as string));
  },
  async startChannelCall(req: Request, res: Response) {
    res.status(201).json(await audioRoomService.startChannelCall(
      req.user!.sub, req.user!.role, req.params.channelId as string, req.body?.preferPlayback === true,
    ));
  },
  async remind(req: Request, res: Response) {
    res.json(await audioRoomService.remind(req.user!.sub, req.params.roomId as string));
  },
  async unremind(req: Request, res: Response) {
    res.json(await audioRoomService.unremind(req.user!.sub, req.params.roomId as string));
  },
  async start(req: Request, res: Response) {
    res.json(await audioRoomService.start(req.user!.sub, req.user!.role, req.params.roomId as string));
  },
  async end(req: Request, res: Response) {
    res.json(await audioRoomService.end(req.user!.sub, req.user!.role, req.params.roomId as string));
  },
  async join(req: Request, res: Response) {
    res.json(await audioRoomService.join(
      req.user!.sub, req.user!.role, req.params.roomId as string, req.body?.preferPlayback === true,
    ));
  },
  async leave(req: Request, res: Response) {
    res.json(await audioRoomService.leave(req.user!.sub, req.params.roomId as string));
  },
  async raiseHand(req: Request, res: Response) {
    res.json(await audioRoomService.raiseHand(req.user!.sub, req.params.roomId as string));
  },
  async lowerHand(req: Request, res: Response) {
    res.json(await audioRoomService.lowerHand(req.user!.sub, req.params.roomId as string));
  },
  async promote(req: Request, res: Response) {
    res.json(await audioRoomService.promote(
      req.user!.sub, req.user!.role, req.params.roomId as string,
      req.body.userId, req.body.role,
    ));
  },
  async kick(req: Request, res: Response) {
    res.json(await audioRoomService.kick(req.user!.sub, req.user!.role, req.params.roomId as string, req.params.userId as string));
  },
  async setMic(req: Request, res: Response) {
    res.json(await audioRoomService.setMic(
      req.user!.sub, req.user!.role, req.params.roomId as string, req.body.hold,
    ));
  },
  async stepDown(req: Request, res: Response) {
    res.json(await audioRoomService.stepDown(req.user!.sub, req.params.roomId as string));
  },
  async muteAll(req: Request, res: Response) {
    res.json(await audioRoomService.muteAll(req.user!.sub, req.user!.role, req.params.roomId as string));
  },
  async mute(req: Request, res: Response) {
    res.json(await audioRoomService.mute(
      req.user!.sub, req.user!.role, req.params.roomId as string, req.params.userId as string,
    ));
  },
  async unmute(req: Request, res: Response) {
    res.json(await audioRoomService.unmute(
      req.user!.sub, req.user!.role, req.params.roomId as string, req.params.userId as string,
    ));
  },
  async refreshToken(req: Request, res: Response) {
    res.json(await audioRoomService.refreshToken(req.user!.sub, req.params.roomId as string));
  },
};

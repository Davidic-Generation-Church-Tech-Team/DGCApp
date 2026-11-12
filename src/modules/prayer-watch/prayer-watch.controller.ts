import type { Request, Response } from 'express';
import { prayerWatchService } from './prayer-watch.service';

export const prayerWatchController = {
  async status(_req: Request, res: Response) {
    res.json(await prayerWatchService.status());
  },
  async start(req: Request, res: Response) {
    res.status(201).json(await prayerWatchService.start(
      req.user!.sub, req.user!.role, req.body?.preferPlayback === true,
    ));
  },
  async end(req: Request, res: Response) {
    res.json(await prayerWatchService.end(req.user!.sub, req.user!.role, req.params.roomId as string));
  },
};

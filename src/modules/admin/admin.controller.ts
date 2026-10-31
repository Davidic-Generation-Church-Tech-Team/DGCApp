import type { Request, Response } from 'express';
import { adminService } from './admin.service';

export const adminController = {
  async analytics(_req: Request, res: Response) {
    res.json(await adminService.analytics());
  },
  async listUsers(req: Request, res: Response) {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json(await adminService.listUsers(search));
  },
  async onlineUsers(req: Request, res: Response) {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(await adminService.onlineUsers(offset, limit));
  },
  async suspend(req: Request, res: Response) {
    res.json(await adminService.setSuspended(req.params.userId as string, true));
  },
  async unsuspend(req: Request, res: Response) {
    res.json(await adminService.setSuspended(req.params.userId as string, false));
  },
  async setRole(req: Request, res: Response) {
    res.json(await adminService.setRole(req.params.userId as string, req.body.role));
  },
  async createBranch(req: Request, res: Response) {
    res.status(201).json(await adminService.createBranch(req.body));
  },
  async assignBranchAdmin(req: Request, res: Response) {
    res.json(
      await adminService.assignBranchAdmin(
        req.user!.sub,
        req.user!.role,
        req.params.branchId as string,
        req.body.userId,
      ),
    );
  },
  async assignClusterModerator(req: Request, res: Response) {
    res.json(
      await adminService.assignClusterModerator(
        req.user!.sub,
        req.user!.role,
        req.params.clusterId as string,
        req.body.userId,
      ),
    );
  },
  async archiveCluster(req: Request, res: Response) {
    res.json(await adminService.setClusterArchived(req.params.clusterId as string, true));
  },
  async unarchiveCluster(req: Request, res: Response) {
    res.json(await adminService.setClusterArchived(req.params.clusterId as string, false));
  },
  async globalDashboard(req: Request, res: Response) {
    res.json(await adminService.dashboardForAdmin(req.user!.sub, req.user!.role));
  },
  async globalMembers(req: Request, res: Response) {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(await adminService.membersForAdmin(req.user!.sub, req.user!.role, undefined, search, cursor));
  },
  async branchDashboard(req: Request, res: Response) {
    res.json(await adminService.dashboardForAdmin(req.user!.sub, req.user!.role, req.params.branchId as string));
  },
  async branchMembers(req: Request, res: Response) {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(
      await adminService.membersForAdmin(req.user!.sub, req.user!.role, req.params.branchId as string, search, cursor),
    );
  },
  async removeBranchMember(req: Request, res: Response) {
    res.json(
      await adminService.removeBranchMemberForAdmin(
        req.user!.sub,
        req.user!.role,
        req.params.branchId as string,
        req.params.userId as string,
      ),
    );
  },
  async createCluster(req: Request, res: Response) {
    res.status(201).json(await adminService.createCluster(req.body));
  },
  async updateCluster(req: Request, res: Response) {
    res.json(await adminService.updateCluster(req.params.clusterId as string, req.body));
  },
};

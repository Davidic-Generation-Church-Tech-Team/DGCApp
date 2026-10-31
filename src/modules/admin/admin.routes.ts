import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize, requireSuperAdmin } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { createBranchSchema, setRoleSchema, assignUserSchema, createClusterSchema, updateClusterSchema } from './admin.schema';
import { adminController } from './admin.controller';

export const adminRouter = Router();

adminRouter.use(authenticate);

adminRouter.get('/analytics', requireSuperAdmin, asyncHandler(adminController.analytics));
adminRouter.get('/users', requireSuperAdmin, asyncHandler(adminController.listUsers));
adminRouter.get('/online-users', requireSuperAdmin, asyncHandler(adminController.onlineUsers));
adminRouter.post('/users/:userId/suspend', requireSuperAdmin, asyncHandler(adminController.suspend));
adminRouter.post('/users/:userId/unsuspend', requireSuperAdmin, asyncHandler(adminController.unsuspend));
adminRouter.post('/users/:userId/role', requireSuperAdmin, validate(setRoleSchema), asyncHandler(adminController.setRole));
adminRouter.post('/branches', requireSuperAdmin, validate(createBranchSchema), asyncHandler(adminController.createBranch));
adminRouter.post('/branches/:branchId/admins', authorize('branch', ['ADMIN']), validate(assignUserSchema), asyncHandler(adminController.assignBranchAdmin));

// Admin panel. Super admin sees all branches; branch admins get their own branch scope.
adminRouter.get('/dashboard', asyncHandler(adminController.globalDashboard));
adminRouter.get('/members', asyncHandler(adminController.globalMembers));

// Branch-scoped admin panel (Overview + Members tabs): super admin or that branch's admin.
adminRouter.get('/branches/:branchId/dashboard', authorize('branch', ['ADMIN']), asyncHandler(adminController.branchDashboard));
adminRouter.get('/branches/:branchId/members', authorize('branch', ['ADMIN']), asyncHandler(adminController.branchMembers));
adminRouter.post(
  '/branches/:branchId/members/:userId/remove',
  authorize('branch', ['ADMIN']),
  asyncHandler(adminController.removeBranchMember),
);

// Cluster management
adminRouter.post('/clusters', requireSuperAdmin, validate(createClusterSchema), asyncHandler(adminController.createCluster));
adminRouter.patch('/clusters/:clusterId', requireSuperAdmin, validate(updateClusterSchema), asyncHandler(adminController.updateCluster));
adminRouter.post(
  '/clusters/:clusterId/moderators',
  validate(assignUserSchema),
  asyncHandler(adminController.assignClusterModerator),
);
adminRouter.post('/clusters/:clusterId/archive', requireSuperAdmin, asyncHandler(adminController.archiveCluster));
adminRouter.post('/clusters/:clusterId/unarchive', requireSuperAdmin, asyncHandler(adminController.unarchiveCluster));

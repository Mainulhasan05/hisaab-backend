const express = require('express');
const router = express.Router();
const branchService = require('../services/branch.service');
const { protect, ownerOnly } = require('../middleware/auth.middleware');
const { rbacAny } = require('../middleware/permission.middleware');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * Owner-facing branch routes — READ and EDIT only.
 *
 * Creating, deleting and enabling/disabling branches are platform-admin
 * actions, performed from the admin panel on the owner's behalf:
 *   POST   /api/admin/shops/:id/branches
 *   DELETE /api/admin/shops/:id/branches/:branchId
 *   POST   /api/admin/shops/:id/enable-multi-branch
 *
 * The owner-facing create/delete endpoints that used to live here are removed
 * rather than permission-gated, so a guessed URL 404s regardless of whether the
 * shop has multi-branch enabled (FEATURE_AUDIT.md H-13).
 */

// Branch reads expose the shop's branch list + staff counts. Owner bypasses;
// staff need a permission whose UI legitimately consumes the branch list.
const canViewBranches = rbacAny([
  ['stock_transfers', 'view'],
  ['staff', 'view'],
]);

// Middleware: ensure multi-branch is enabled for this shop
const requireMultiBranch = (req, res, next) => {
  if (!req.shop?.multiBranchEnabled) {
    return ApiResponse.forbidden(res, {
      message: 'Multi-branch is not enabled for this shop',
      messageBn: 'এই দোকানে মাল্টি-ব্রাঞ্চ সক্রিয় নয়'
    });
  }
  next();
};

// GET /api/branches — List branches.
// Owner sees all; staff see only the branch they are assigned to.
router.get('/',
  protect,
  canViewBranches,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branches = req.user.isOwner
      ? await branchService.getBranchesWithStaffCount(req.shop._id)
      : await branchService.getAssignedBranch(req.shop._id, req.branchId);

    return ApiResponse.success(res, {
      data: branches,
      message: 'Branches fetched',
      messageBn: 'শাখাসমূহ লোড হয়েছে'
    });
  })
);

// GET /api/branches/:id — Get single branch
router.get('/:id',
  protect,
  canViewBranches,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    // Staff may only read their own branch.
    if (!req.user.isOwner && String(req.branchId || '') !== String(req.params.id)) {
      return ApiResponse.forbidden(res, {
        message: 'You can only view your own branch',
        messageBn: 'আপনি শুধু নিজের শাখাই দেখতে পারবেন'
      });
    }

    const branch = await branchService.getBranch(req.params.id, req.shop._id);
    return ApiResponse.success(res, {
      data: branch,
      message: 'Branch fetched',
      messageBn: 'শাখা লোড হয়েছে'
    });
  })
);

// PATCH /api/branches/:id — Owner edits their own branch's details
// (name, address, phone). Code, active state and existence are admin-only.
router.patch('/:id',
  protect,
  ownerOnly,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branch = await branchService.updateBranch(req.params.id, req.shop._id, req.body, req);
    return ApiResponse.success(res, {
      data: branch,
      message: 'Branch updated',
      messageBn: 'শাখা আপডেট হয়েছে'
    });
  })
);

module.exports = router;

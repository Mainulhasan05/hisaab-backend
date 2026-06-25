const express = require('express');
const router = express.Router();
const branchService = require('../services/branch.service');
const { protect, ownerOnly } = require('../middleware/auth.middleware');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * All branch routes require:
 * 1. Authentication (protect)
 * 2. Owner access (ownerOnly) — only owners can manage branches
 * 3. Multi-branch to be enabled (checked in handlers)
 */

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

// GET /api/branches — List all branches
router.get('/',
  protect,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branches = await branchService.getBranchesWithStaffCount(req.shop._id);
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
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branch = await branchService.getBranch(req.params.id, req.shop._id);
    return ApiResponse.success(res, {
      data: branch,
      message: 'Branch fetched',
      messageBn: 'শাখা লোড হয়েছে'
    });
  })
);

// POST /api/branches — Create new branch
router.post('/',
  protect,
  ownerOnly,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branch = await branchService.createBranch(req.shop._id, req.body, req);
    return ApiResponse.created(res, {
      data: branch,
      message: 'Branch created',
      messageBn: 'নতুন শাখা তৈরি হয়েছে'
    });
  })
);

// PATCH /api/branches/:id — Update branch
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

// DELETE /api/branches/:id — Deactivate branch (soft delete)
router.delete('/:id',
  protect,
  ownerOnly,
  requireMultiBranch,
  asyncHandler(async (req, res) => {
    const branch = await branchService.deactivateBranch(req.params.id, req.shop._id, req);
    return ApiResponse.success(res, {
      data: branch,
      message: 'Branch deactivated',
      messageBn: 'শাখা নিষ্ক্রিয় হয়েছে'
    });
  })
);

module.exports = router;

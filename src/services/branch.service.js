const Branch = require('../models/Branch.model');
const User = require('../models/User.model');
const Sale = require('../models/Sale.model');
const BranchStock = require('../models/BranchStock.model');
const AuditLog = require('../models/AuditLog.model');
const { AUDIT_ACTIONS } = require('../config/constants');
const cacheService = require('./cache.service');
const { invalidateBranchCache } = require('../utils/authCache.util');

class BranchService {
  /**
   * Get all branches for a shop
   */
  async getBranches(shopId) {
    return Branch.getShopBranches(shopId);
  }

  /**
   * Get a single branch by ID (with ownership check)
   */
  async getBranch(branchId, shopId) {
    const branch = await Branch.validateBranchOwnership(branchId, shopId);
    if (!branch) {
      const error = new Error('শাখা পাওয়া যায়নি');
      error.statusCode = 404;
      throw error;
    }
    return branch;
  }

  /**
   * Create a new branch
   */
  async createBranch(shopId, data, req) {
    // Validate code uniqueness within shop
    const existing = await Branch.findOne({
      shop: shopId,
      code: data.code?.toUpperCase()
    });

    if (existing) {
      const error = new Error('এই কোডের শাখা আগে থেকেই আছে');
      error.statusCode = 400;
      throw error;
    }

    const branch = await Branch.create({
      shop: shopId,
      name: data.name,
      code: data.code,
      address: data.address,
      phone: data.phone,
      isDefault: false,
      createdBy: req.user._id
    });

    // Invalidate default branch cache
    await invalidateBranchCache(shopId, branch._id);

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      user: req.user._id,
      action: AUDIT_ACTIONS.BRANCH_CREATE.en,
      description: `নতুন শাখা "${branch.name}" (${branch.code}) যোগ করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name },
      req
    });

    return branch;
  }

  /**
   * Update a branch
   */
  async updateBranch(branchId, shopId, data, req) {
    const branch = await this.getBranch(branchId, shopId);

    // Check code uniqueness if being changed
    if (data.code && data.code.toUpperCase() !== branch.code) {
      const existing = await Branch.findOne({
        shop: shopId,
        code: data.code.toUpperCase(),
        _id: { $ne: branchId }
      });
      if (existing) {
        const error = new Error('এই কোডের শাখা আগে থেকেই আছে');
        error.statusCode = 400;
        throw error;
      }
    }

    const before = { name: branch.name, code: branch.code, address: branch.address, phone: branch.phone };

    if (data.name) branch.name = data.name;
    if (data.code) branch.code = data.code;
    if (data.address !== undefined) branch.address = data.address;
    if (data.phone !== undefined) branch.phone = data.phone;

    await branch.save();

    // Invalidate default branch cache
    await invalidateBranchCache(shopId, branch._id);

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      user: req.user._id,
      action: AUDIT_ACTIONS.BRANCH_UPDATE.en,
      description: `শাখা "${branch.name}" আপডেট করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name },
      changes: { before, after: { name: branch.name, code: branch.code, address: branch.address, phone: branch.phone } },
      req
    });

    return branch;
  }

  /**
   * Deactivate a branch (soft delete)
   * Cannot deactivate the default branch
   */
  async deactivateBranch(branchId, shopId, req) {
    const branch = await this.getBranch(branchId, shopId);

    if (branch.isDefault) {
      const error = new Error('প্রধান শাখা নিষ্ক্রিয় করা যাবে না');
      error.statusCode = 400;
      throw error;
    }

    // Check if any active staff are assigned to this branch
    const staffCount = await User.countDocuments({
      shop: shopId,
      branch: branchId,
      isActive: true,
      isOwner: false
    });

    if (staffCount > 0) {
      const error = new Error(`এই শাখায় ${staffCount} জন কর্মী আছেন। প্রথমে তাদের অন্য শাখায় বদলি করুন।`);
      error.statusCode = 400;
      throw error;
    }

    branch.isActive = false;
    branch.deletedAt = new Date();
    await branch.save();

    // Invalidate default branch cache
    await invalidateBranchCache(shopId, branch._id);

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      user: req.user._id,
      action: AUDIT_ACTIONS.BRANCH_DEACTIVATE.en,
      description: `শাখা "${branch.name}" নিষ্ক্রিয় করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name },
      req
    });

    return branch;
  }

  /**
   * Get branch with staff count
   */
  async getBranchesWithStaffCount(shopId) {
    const branches = await Branch.getShopBranches(shopId);
    const branchIds = branches.map((branch) => branch._id);

    const [staffCounts, salesStats, itemCounts] = await Promise.all([
      User.aggregate([
        { $match: { shop: shopId, branch: { $in: branchIds }, isActive: true, isOwner: false } },
        { $group: { _id: '$branch', staffCount: { $sum: 1 } } },
      ]),
      Sale.aggregate([
        { $match: { shop: shopId, branch: { $in: branchIds }, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: '$branch',
            salesCount: { $sum: 1 },
            totalSales: { $sum: '$total' },
            lastActivity: { $max: '$createdAt' },
          },
        },
      ]),
      BranchStock.aggregate([
        { $match: { shop: shopId, branch: { $in: branchIds }, stock: { $gt: 0 } } },
        { $group: { _id: { branch: '$branch', product: '$product' } } },
        { $group: { _id: '$_id.branch', itemCount: { $sum: 1 } } },
      ]),
    ]);

    const staffMap = new Map(staffCounts.map((row) => [row._id?.toString(), row.staffCount]));
    const salesMap = new Map(salesStats.map((row) => [row._id?.toString(), row]));
    const itemMap = new Map(itemCounts.map((row) => [row._id?.toString(), row.itemCount]));

    return branches.map((branch) => {
      const id = branch._id.toString();
      const sales = salesMap.get(id) || {};
      return {
        ...branch.toObject(),
        staffCount: staffMap.get(id) || 0,
        itemCount: itemMap.get(id) || 0,
        salesCount: sales.salesCount || 0,
        totalSales: sales.totalSales || 0,
        lastActivity: sales.lastActivity || null,
      };
    });
  }

  async getBranchDeletionImpact(branchId, shopId) {
    const branch = await this.getBranch(branchId, shopId);
    const [staffCount, salesCount, itemCount, stockRecordCount] = await Promise.all([
      User.countDocuments({ shop: shopId, branch: branchId, isActive: true, isOwner: false }),
      Sale.countDocuments({ shop: shopId, branch: branchId }),
      BranchStock.distinct('product', { shop: shopId, branch: branchId, stock: { $gt: 0 } }).then((ids) => ids.length),
      BranchStock.countDocuments({ shop: shopId, branch: branchId }),
    ]);

    return {
      branch: {
        _id: branch._id,
        name: branch.name,
        code: branch.code,
        isDefault: branch.isDefault,
      },
      staffCount,
      salesCount,
      itemCount,
      stockRecordCount,
      canDeactivate: !branch.isDefault && staffCount === 0,
    };
  }
}

module.exports = new BranchService();

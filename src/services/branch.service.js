const Branch = require('../models/Branch.model');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const { AUDIT_ACTIONS } = require('../config/constants');

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
    await branch.save();

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

    const branchesWithCount = await Promise.all(
      branches.map(async (branch) => {
        const staffCount = await User.countDocuments({
          shop: shopId,
          branch: branch._id,
          isActive: true,
          isOwner: false
        });
        return {
          ...branch.toObject(),
          staffCount
        };
      })
    );

    return branchesWithCount;
  }
}

module.exports = new BranchService();

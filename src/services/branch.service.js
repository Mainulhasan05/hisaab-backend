const mongoose = require('mongoose');
const Branch = require('../models/Branch.model');
const User = require('../models/User.model');
const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const AuditLog = require('../models/AuditLog.model');
const CashRegister = require('../models/CashRegister.model');
const HeldCart = require('../models/HeldCart.model');
const StockTransfer = require('../models/StockTransfer.model');
const { AUDIT_ACTIONS } = require('../config/constants');
const cacheService = require('./cache.service');
const { invalidateBranchCache } = require('../utils/authCache.util');
const { normalizeInvoicePhones } = require('../utils/phone.util');

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
   * Update a branch
   */
  /**
   * Update a branch's descriptive details.
   *
   * This is the owner-facing edit. `code` (invoice-number prefix) and
   * `isActive` (existence) are deliberately NOT editable here — those are
   * platform-admin actions via adminService.updateShopBranch.
   */
  async updateBranch(branchId, shopId, data, req) {
    const branch = await this.getBranch(branchId, shopId);

    const before = {
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      invoicePhones: [...(branch.invoicePhones || [])],
    };

    if (data.name) branch.name = data.name;
    if (data.address !== undefined) branch.address = data.address;
    if (data.phone !== undefined) branch.phone = data.phone;
    // `in` rather than `!== undefined`: `[]` is how the owner clears the last
    // extra number, and it must reach the document as an instruction rather
    // than be mistaken for "not sent". Same rule, same normaliser, as the
    // shop-level route in auth.controller.
    if ('invoicePhones' in data) {
      branch.invoicePhones = normalizeInvoicePhones(data.invoicePhones);
    }

    await branch.save();

    // Invalidate default branch cache
    await invalidateBranchCache(shopId);

    // Log audit
    await AuditLog.log({
      shop: shopId,
      branch: branch._id,
      user: req.user._id,
      action: AUDIT_ACTIONS.BRANCH_UPDATE.en,
      description: `শাখা "${branch.name}" আপডেট করা হয়েছে`,
      entity: { type: 'branch', id: branch._id, name: branch.name },
      changes: {
        before,
        after: {
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
          invoicePhones: [...(branch.invoicePhones || [])],
        },
      },
      req
    });

    return branch;
  }

  /**
   * The single branch a staff member is assigned to, in the same array shape
   * the owner's list uses so the frontend needs no special case.
   */
  async getAssignedBranch(shopId, branchId) {
    if (!branchId) return [];
    const branch = await Branch.findOne({ _id: branchId, shop: shopId, isActive: true }).lean();
    return branch ? [branch] : [];
  }

  /**
   * Get branch with staff count
   */
  async getBranchesWithStaffCount(shopId) {
    const branches = await Branch.getShopBranches(shopId);
    const branchIds = branches.map((branch) => branch._id);

    // $match does not cast. This is safe today only because req.shop is
    // Shop.hydrate()'d, so its _id happens to be an ObjectId — the same
    // accident that did NOT hold for the branch list and silently zeroed the
    // sales summary. Cast explicitly so the rule "every aggregation casts its
    // ids" is true here with no exception to remember.
    const shopOid = new mongoose.Types.ObjectId(shopId);

    const [staffCounts, salesStats, itemCounts] = await Promise.all([
      User.aggregate([
        { $match: { shop: shopOid, branch: { $in: branchIds }, isActive: true, isOwner: false } },
        { $group: { _id: '$branch', staffCount: { $sum: 1 } } },
      ]),
      Sale.aggregate([
        { $match: { shop: shopOid, branch: { $in: branchIds }, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: '$branch',
            salesCount: { $sum: 1 },
            totalSales: { $sum: '$total' },
            lastActivity: { $max: '$createdAt' },
          },
        },
      ]),
      Product.aggregate([
        { $match: { shop: shopOid, branch: { $in: branchIds }, isDeleted: { $ne: true }, stock: { $gt: 0 } } },
        { $group: { _id: '$branch', itemCount: { $sum: 1 } } },
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

  /**
   * What would be affected by deactivating this branch.
   *
   * Blocking conditions are work-in-progress that would be stranded: assigned
   * staff (they would be locked out on their next request), an open cash
   * register (the day's till would never close), held carts (unreachable), and
   * in-transit transfers (stock deducted from source, never received).
   * Sales history and stock are NOT blocking — they stay readable.
   */
  async getBranchDeletionImpact(branchId, shopId) {
    const branch = await this.getBranch(branchId, shopId);
    const [staffCount, salesCount, itemCount, productCount, openRegisters, heldCarts, inTransit] =
      await Promise.all([
        User.countDocuments({ shop: shopId, branch: branchId, isActive: true, isOwner: false }),
        Sale.countDocuments({ shop: shopId, branch: branchId }),
        Product.countDocuments({ shop: shopId, branch: branchId, isDeleted: { $ne: true }, stock: { $gt: 0 } }),
        Product.countDocuments({ shop: shopId, branch: branchId, isDeleted: { $ne: true } }),
        CashRegister.countDocuments({ shop: shopId, branch: branchId, status: 'open' }),
        HeldCart.countDocuments({ shop: shopId, branch: branchId, status: 'held' }),
        StockTransfer.countDocuments({
          shop: shopId,
          status: { $in: ['pending', 'in_transit'] },
          $or: [{ fromBranch: branchId }, { toBranch: branchId }],
        }),
      ]);

    const blockers = [];
    if (branch.isDefault) blockers.push('এটি প্রধান শাখা');
    if (staffCount > 0) blockers.push(`${staffCount} জন কর্মী এই শাখায় আছেন`);
    if (openRegisters > 0) blockers.push(`${openRegisters}টি ক্যাশ রেজিস্টার এখনো খোলা`);
    if (heldCarts > 0) blockers.push(`${heldCarts}টি হোল্ড করা কার্ট আছে`);
    if (inTransit > 0) blockers.push(`${inTransit}টি স্টক ট্রান্সফার চলমান`);

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
      productCount,
      openRegisters,
      heldCarts,
      inTransit,
      blockers,
      canDeactivate: blockers.length === 0,
    };
  }
}

module.exports = new BranchService();

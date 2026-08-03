const User = require('../models/User.model');
const Role = require('../models/Role.model');
const Shop = require('../models/Shop.model');
const Branch = require('../models/Branch.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { normalizePhone } = require('../utils/phone.util');
const { getBranchForCreate } = require('../utils/branchScope.util');
const { invalidateUserAuthCache } = require('../utils/authCache.util');

// One phone may hold accounts in multiple shops (owner of one, staff at
// another), but unbounded reuse is abuse — cap total memberships per phone.
const MAX_SHOPS_PER_PHONE = 5;

class StaffService {
  /**
   * List all non-owner employees in the shop
   */
  async getStaff(shopId) {
    return await User.find({
      shop: shopId,
      isOwner: false,
    })
      .populate('role', 'name permissions')
      .populate('branch', 'name code')
      .select('-password -otp')
      .sort({ createdAt: -1 });
  }

  /**
   * Get single staff member
   */
  async getStaffMember(staffId, shopId) {
    const staff = await User.findOne({ _id: staffId, shop: shopId, isOwner: false })
      .populate('role', 'name permissions');
    if (!staff) {
      throw new AppError('Staff member not found', 'কর্মচারী পাওয়া যায়নি', 404);
    }
    return staff;
  }

  /**
   * Pre-create phone check for the staff form: does this phone already exist
   * in this shop, and in how many other shops?
   */
  async checkPhone(shopId, phone) {
    const normalizedPhone = normalizePhone(phone);
    const [inThisShop, otherShopCount] = await Promise.all([
      User.findOne({ phone: normalizedPhone, shop: shopId }).select('isActive').lean(),
      User.countDocuments({ phone: normalizedPhone, shop: { $ne: shopId } }),
    ]);
    return {
      existsInThisShop: !!inThisShop,
      isDeactivatedHere: !!inThisShop && inThisShop.isActive === false,
      otherShopCount,
      maxShops: MAX_SHOPS_PER_PHONE,
      capReached: otherShopCount >= MAX_SHOPS_PER_PHONE,
    };
  }

  /**
   * Create a new staff member (employee)
   */
  async createStaff(shopId, ownerId, data, req) {
    const { phone, password, name, roleId } = data;
    const normalizedPhone = normalizePhone(phone);

    // Check if phone already exists in this shop — including deactivated
    // accounts, which the {phone, shop} unique index would reject anyway
    const existing = await User.findOne({ phone: normalizedPhone, shop: shopId });
    if (existing) {
      if (!existing.isActive) {
        throw new AppError(
          'This phone belongs to a deactivated staff account. Reactivate it from the staff list instead.',
          'এই নম্বরে একটি নিষ্ক্রিয় স্টাফ অ্যাকাউন্ট আছে। নতুন না বানিয়ে তালিকা থেকে সক্রিয় করুন।',
          409
        );
      }
      throw new AppError(
        'Phone number already registered in this shop',
        'এই ফোন নম্বর এই দোকানে ইতোমধ্যে নিবন্ধিত',
        409
      );
    }

    // Cross-shop check: cap total memberships, and remember whether this
    // phone belongs to someone with accounts elsewhere
    const otherShopCount = await User.countDocuments({
      phone: normalizedPhone,
      shop: { $ne: shopId },
    });
    if (otherShopCount >= MAX_SHOPS_PER_PHONE) {
      throw new AppError(
        `This phone number is already used in ${otherShopCount} shops (maximum ${MAX_SHOPS_PER_PHONE})`,
        `এই ফোন নম্বর ইতোমধ্যে ${otherShopCount}টি দোকানে ব্যবহৃত হচ্ছে (সর্বোচ্চ ${MAX_SHOPS_PER_PHONE}টি)`,
        409
      );
    }

    // Validate role belongs to this shop
    const role = await Role.findOne({ _id: roleId, shop: shopId, isActive: true });
    if (!role) {
      throw new AppError(
        'Invalid role selected',
        'অবৈধ ভূমিকা নির্বাচিত হয়েছে',
        400
      );
    }

    // Resolve branch assignment
    let resolvedBranchId = null;
    if (data.branchId) {
      const branch = await Branch.validateBranchOwnership(data.branchId, shopId);
      if (!branch) {
        throw new AppError('Invalid branch', 'অবৈধ শাখা', 400);
      }
      resolvedBranchId = branch._id;
    } else if (req) {
      try {
        resolvedBranchId = getBranchForCreate(req);
      } catch (err) {
        // If owner is in "All Branches" context, default to the default branch of the shop
        const defaultBranch = await Branch.getDefaultBranch(shopId);
        if (defaultBranch) {
          resolvedBranchId = defaultBranch._id;
        }
      }
    }

    // Consent: if this phone already belongs to someone in another shop, the
    // real owner of the number must verify via OTP at their first login here.
    // A phone new to the platform stays pre-verified (owner vouches for it).
    const requiresConsent = otherShopCount > 0;

    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shopId,
      isOwner: false,
      role: role._id,
      branch: resolvedBranchId,
      isPhoneVerified: !requiresConsent,
      createdBy: ownerId,
    });

    // Log action
    await AuditLog.log({
      shop: shopId,
      user: ownerId,
      action: AUDIT_ACTIONS.TEAM_MEMBER_ADD.en,
      description: `Staff member "${name}" added with role "${role.name}"`,
      entity: { type: 'user', id: user._id, name },
      req,
    });

    return await User.findById(user._id).populate('role', 'name permissions');
  }

  /**
   * Update a staff member (name, phone, role, active status)
   */
  async updateStaff(staffId, shopId, ownerId, data, req) {
    const staff = await User.findOne({ _id: staffId, shop: shopId, isOwner: false });
    if (!staff) {
      throw new AppError('Staff member not found', 'কর্মচারী পাওয়া যায়নি', 404);
    }

    if (data.name !== undefined) staff.name = data.name;

    if (data.phone !== undefined) {
      const normalizedPhone = normalizePhone(data.phone);
      // Check uniqueness within shop
      const existing = await User.findOne({ phone: normalizedPhone, shop: shopId, _id: { $ne: staffId } });
      if (existing) {
        throw new AppError('Phone number already in use', 'এই ফোন নম্বর অন্যত্র ব্যবহৃত', 409);
      }
      staff.phone = normalizedPhone;
    }

    if (data.roleId !== undefined) {
      const role = await Role.findOne({ _id: data.roleId, shop: shopId, isActive: true });
      if (!role) {
        throw new AppError('Invalid role selected', 'অবৈধ ভূমিকা', 400);
      }
      staff.role = role._id;
    }

    if (typeof data.isActive === 'boolean') {
      staff.isActive = data.isActive;
    }

    // Branch assignment (for multi-branch shops)
    if (data.branchId !== undefined) {
      if (data.branchId) {
        const branch = await Branch.validateBranchOwnership(data.branchId, shopId);
        if (!branch) {
          throw new AppError('Invalid branch', 'অবৈধ শাখা', 400);
        }
        staff.branch = branch._id;
      } else {
        staff.branch = null;
      }
    }

    await staff.save();
    // Role/branch/active changes must take effect before the auth cache TTL
    await invalidateUserAuthCache(staff._id);

    // Log action
    await AuditLog.log({
      shop: shopId,
      user: ownerId,
      action: AUDIT_ACTIONS.TEAM_MEMBER_UPDATE.en,
      description: `Staff member "${staff.name}" updated`,
      entity: { type: 'user', id: staff._id, name: staff.name },
      req,
    });

    return await User.findById(staff._id).populate('role', 'name permissions');
  }

  /**
   * Deactivate a staff member (soft-delete)
   */
  async deactivateStaff(staffId, shopId, ownerId, req) {
    const staff = await User.findOne({ _id: staffId, shop: shopId, isOwner: false });
    if (!staff) {
      throw new AppError('Staff member not found', 'কর্মচারী পাওয়া যায়নি', 404);
    }

    staff.isActive = false;
    await staff.save();
    // Deactivation must take effect before the auth cache TTL
    await invalidateUserAuthCache(staff._id);

    // Log action
    await AuditLog.log({
      shop: shopId,
      user: ownerId,
      action: AUDIT_ACTIONS.TEAM_MEMBER_REMOVE.en,
      description: `Staff member "${staff.name}" deactivated`,
      entity: { type: 'user', id: staff._id, name: staff.name },
      req,
    });

    return { message: 'Staff member deactivated' };
  }
}

module.exports = new StaffService();

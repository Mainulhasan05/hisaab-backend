const User = require('../models/User.model');
const Role = require('../models/Role.model');
const Shop = require('../models/Shop.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { normalizePhone } = require('../utils/phone.util');

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
   * Create a new staff member (employee)
   */
  async createStaff(shopId, ownerId, data, req) {
    const { phone, password, name, roleId } = data;
    const normalizedPhone = normalizePhone(phone);

    // Check if phone already exists in this shop
    const existing = await User.findByPhoneAndShop(normalizedPhone, shopId);
    if (existing) {
      throw new AppError(
        'Phone number already registered in this shop',
        'এই ফোন নম্বর এই দোকানে ইতোমধ্যে নিবন্ধিত',
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

    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shopId,
      isOwner: false,
      role: role._id,
      isPhoneVerified: true, // Owner-created employees are pre-verified
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

    await staff.save();

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

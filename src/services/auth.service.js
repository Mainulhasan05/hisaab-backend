const User = require('../models/User.model');
const Role = require('../models/Role.model');
const Shop = require('../models/Shop.model');
const Admin = require('../models/Admin.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('./sms.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS, TRIAL_PERIOD_DAYS } = require('../config/constants');
const { ROLE_PRESETS, buildPermissionsFromConfig, buildPermissions, LEGACY_PERMISSION_MAP } = require('../config/permissions');
const { normalizePhone } = require('../utils/phone.util');
const { seedCategories } = require('../seeds/categorySeeder');

class AuthService {
  /**
   * Register new shop with owner
   */
  async register(data, req) {
    const { phone, password, name, shopName, shopType, shopAddress, shopPhone } = data;

    const normalizedPhone = normalizePhone(phone);

    // Check if phone already exists as owner
    const existingOwner = await User.findOne({
      phone: normalizedPhone,
      isOwner: true
    });

    if (existingOwner) {
      throw new AppError(
        'Phone number already registered as shop owner',
        'এই ফোন নম্বর দিয়ে ইতোমধ্যে দোকান নিবন্ধিত আছে',
        409
      );
    }

    const defaultVariantTypesMap = {
      cloth: ['size', 'color'],
      grocery: ['weight', 'pack-size'],
      electronics: ['color', 'storage', 'warranty'],
      pharmacy: ['strength', 'pack-size'],
      hardware: ['size', 'weight'],
      cosmetics: ['shade', 'pack-size', 'weight'],
      bookshop: [],
      other: ['size', 'color', 'weight']
    };

    // Create shop first
    const shop = await Shop.create({
      name: shopName,
      type: shopType || 'other',
      address: shopAddress,
      phone: shopPhone || normalizedPhone,
      subscription: {
        plan: 'trial',
        status: 'active',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000)
      },
      settings: {
        enabledVariantTypes: defaultVariantTypesMap[shopType || 'other']
      }
    });

    // Seed default categories for this shop type
    try {
      await seedCategories(shop._id, shopType || 'other');
    } catch (error) {
      console.error('Failed to seed categories:', error.message);
    }

    // Seed default roles for the shop
    try {
      await this.seedDefaultRoles(shop._id);
    } catch (error) {
      console.error('Failed to seed default roles:', error.message);
    }

    // Create owner user — isOwner: true, no role needed
    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shop._id,
      isOwner: true,
      role: null,
      isPhoneVerified: false
    });

    // Update shop with owner reference
    shop.owner = user._id;
    await shop.save();

    // Generate OTP for verification
    const otp = user.generateOTP();
    await user.save();

    // Send OTP via SMS
    try {
      await SMSService.sendOTP(normalizedPhone, otp);
    } catch (error) {
      console.error('Failed to send OTP:', error);
      // Don't fail registration if SMS fails
    }

    // Log action
    await AuditLog.log({
      shop: shop._id,
      user: user._id,
      action: AUDIT_ACTIONS.USER_REGISTER.en,
      description: `New shop "${shopName}" registered`,
      entity: { type: 'shop', id: shop._id, name: shopName },
      req
    });

    // Generate token
    const token = user.generateToken();

    return {
      user: user.toJSON(),
      shop: shop.toJSON(),
      token,
      otpSent: true
    };
  }

  /**
   * Seed default roles (Manager, Cashier) for a new shop
   */
  async seedDefaultRoles(shopId) {
    const roleDocs = [];
    for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
      roleDocs.push({
        shop: shopId,
        name: preset.name,
        permissions: preset.permissions,
        isDefault: true,
        isActive: true,
      });
    }
    await Role.insertMany(roleDocs, { ordered: false }).catch(() => {
      // Ignore duplicate key errors (roles already seeded)
    });
  }

  _buildTeamPermissions(permissions = [], presetRole = 'staff') {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      const preset = ROLE_PRESETS[presetRole] || ROLE_PRESETS.staff;
      return preset.permissions;
    }

    const normalized = buildPermissions(false);

    for (const permissionKey of permissions) {
      const mapped = LEGACY_PERMISSION_MAP[permissionKey];
      if (!mapped) continue;
      if (!normalized[mapped.module]) continue;
      if (normalized[mapped.module][mapped.action] !== undefined) {
        normalized[mapped.module][mapped.action] = true;
      }
    }

    return normalized;
  }

  async _getOrCreateTeamRole(shopId, roleName, permissions = []) {
    const presetKey = roleName === 'manager' ? 'manager' : 'cashier';
    const preset = ROLE_PRESETS[presetKey] || ROLE_PRESETS.cashier;

    if (!permissions || permissions.length === 0) {
      const existing = await Role.findOne({ shop: shopId, name: preset.name });
      if (existing) return existing;

      return Role.create({
        shop: shopId,
        name: preset.name,
        permissions: preset.permissions,
        isDefault: false,
        isActive: true,
      });
    }

    const permissionsObject = this._buildTeamPermissions(permissions, presetKey);
    const customRoleName = `${preset.name} Custom`;
    const existing = await Role.findOne({ shop: shopId, name: customRoleName });

    if (existing) {
      existing.permissions = permissionsObject;
      await existing.save();
      return existing;
    }

    return Role.create({
      shop: shopId,
      name: customRoleName,
      permissions: permissionsObject,
      isDefault: false,
      isActive: true,
    });
  }

  /**
   * Create a team member for an existing shop
   */
  async createTeamMember(shopId, ownerId, data, req) {
    const { phone, password, name, role = 'staff', permissions = [] } = data;
    const normalizedPhone = normalizePhone(phone);

    const existingMember = await User.findOne({ phone: normalizedPhone, shop: shopId });
    if (existingMember) {
      throw new AppError('User already exists in this shop', 'এই নম্বরের ব্যবহারকারী আগে থেকেই আছে', 409);
    }

    const roleDoc = await this._getOrCreateTeamRole(shopId, role, permissions);

    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shopId,
      isOwner: false,
      role: roleDoc._id,
      branch: null,
      isPhoneVerified: true,
      createdBy: ownerId,
    });

    await AuditLog.log({
      shop: shopId,
      user: ownerId,
      action: AUDIT_ACTIONS.USER_REGISTER.en,
      description: `Team member ${name} created`,
      entity: { type: 'user', id: user._id, name },
      req,
    });

    return user.populate('role');
  }

  /**
   * Send OTP for phone verification
   */
  async sendOTP(phone) {
    const normalizedPhone = normalizePhone(phone);

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    if (user.isPhoneVerified) {
      throw new AppError(
        'Phone already verified',
        'ফোন নম্বর ইতোমধ্যে যাচাই করা হয়েছে',
        400
      );
    }

    // Rate limit: 60-second cooldown between OTP sends
    if (!user.canResendOTP()) {
      const secondsLeft = Math.ceil(
        (60 * 1000 - (Date.now() - new Date(user.otp.sentAt).getTime())) / 1000
      );
      throw new AppError(
        `Please wait ${secondsLeft} seconds before requesting a new OTP`,
        `অনুগ্রহ করে ${secondsLeft} সেকেন্ড পর আবার ওটিপি নিন`,
        429
      );
    }

    const otp = user.generateOTP();
    await user.save();

    // Send OTP via SMS
    await SMSService.sendOTP(normalizedPhone, otp);

    return { message: 'OTP sent successfully' };
  }

  /**
   * Verify OTP
   */
  async verifyOTP(phone, otp) {
    const normalizedPhone = normalizePhone(phone);

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    if (!user.verifyOTP(otp)) {
      throw new AppError(
        'Invalid or expired OTP',
        'অবৈধ বা মেয়াদোত্তীর্ণ ওটিপি',
        400
      );
    }

    user.isPhoneVerified = true;
    user.clearOTP();
    await user.save();

    return { message: 'Phone verified successfully' };
  }

  /**
   * Login user
   */
  async login(data, req) {
    const { phone, password, shopSlug } = data;
    const normalizedPhone = normalizePhone(phone);

    let user;

    if (shopSlug) {
      // Team member login - find by phone and shop
      const shop = await Shop.findBySlug(shopSlug);
      if (!shop) {
        throw new AppError(
          'Shop not found',
          'দোকান পাওয়া যায়নি',
          404
        );
      }
      user = await User.findByPhoneAndShop(normalizedPhone, shop._id);
    } else {
      // Owner login - find owner by phone
      user = await User.findOne({
        phone: normalizedPhone,
        isOwner: true,
        isActive: true
      }).populate('shop');
    }

    if (!user) {
      throw new AppError(
        'Invalid phone number or password',
        'ফোন নম্বর বা পাসওয়ার্ড ভুল',
        401
      );
    }

    // Get password for comparison
    const userWithPassword = await User.findById(user._id).select('+password');

    if (!(await userWithPassword.comparePassword(password))) {
      throw new AppError(
        'Invalid phone number or password',
        'ফোন নম্বর বা পাসওয়ার্ড ভুল',
        401
      );
    }

    // Check if phone is verified
    if (!user.isPhoneVerified) {
      let otpMessage = 'ফোন নম্বর যাচাই করা হয়নি।';

      // Only send a new OTP if there's no active one
      if (!user.hasValidOTP()) {
        const otp = user.generateOTP();
        await user.save();

        try {
          await SMSService.sendOTP(normalizedPhone, otp);
          otpMessage = 'ফোন নম্বর যাচাই করা হয়নি। নতুন ওটিপি পাঠানো হয়েছে।';
        } catch (error) {
          console.error('Failed to send OTP:', error);
          otpMessage = 'ফোন নম্বর যাচাই করা হয়নি। ওটিপি পাঠাতে সমস্যা হয়েছে।';
        }
      } else {
        otpMessage = 'ফোন নম্বর যাচাই করা হয়নি। আগের ওটিপি ব্যবহার করুন অথবা নতুন ওটিপি নিন।';
      }

      const err = new AppError(
        'Phone number not verified.',
        otpMessage,
        403
      );
      err.code = 'PHONE_NOT_VERIFIED';
      err.phone = normalizedPhone;
      throw err;
    }

    // Check if shop is active
    const shop = await Shop.findById(user.shop);
    if (!shop || !shop.isActive) {
      throw new AppError(
        'Shop is deactivated',
        'দোকান নিষ্ক্রিয়',
        403
      );
    }

    // Check subscription
    const subscriptionExpired = !shop.isSubscriptionValid;
    if (subscriptionExpired) {
      if (
        shop.subscription &&
        shop.subscription.status === 'active' &&
        shop.subscription.expiresAt &&
        shop.subscription.expiresAt < new Date()
      ) {
        shop.subscription.status = 'expired';
        shop.save().catch(() => {});
      }
    }

    // Populate role for employees (to embed permissions in JWT)
    if (!user.isOwner && user.role) {
      await user.populate('role');
    }

    // Update last login
    await user.updateLastLogin();

    // Log action
    await AuditLog.log({
      shop: user.shop,
      user: user._id,
      action: AUDIT_ACTIONS.USER_LOGIN.en,
      description: `User ${user.name} logged in${subscriptionExpired ? ' (subscription expired — read-only mode)' : ''}`,
      req
    });

    // Generate token (permissions embedded via populated role)
    const token = user.generateToken();

    // Build permissions response for frontend
    let permissions = null;
    if (!user.isOwner && user.role && user.role.permissions) {
      permissions = user.role.permissions;
    }

    return {
      user: user.toJSON(),
      shop: shop.toJSON(),
      permissions,
      token,
      ...(subscriptionExpired && {
        subscriptionExpired: true,
        subscriptionMessage: 'আপনার সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে। আপনি ডেটা দেখতে পারবেন, কিন্তু পরিবর্তন করতে পারবেন না।',
      }),
    };
  }

  /**
   * Get current user profile
   */
  async getMe(userId) {
    const user = await User.findById(userId).populate('shop').populate('role');

    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    // Build permissions for frontend
    let permissions = null;
    if (!user.isOwner && user.role && user.role.permissions) {
      permissions = user.role.permissions;
    }

    return { user, permissions };
  }

  /**
   * Change password
   */
  async changePassword(userId, data, req) {
    const { currentPassword, newPassword } = data;

    const user = await User.findById(userId).select('+password');

    if (!(await user.comparePassword(currentPassword))) {
      throw new AppError(
        'Current password is incorrect',
        'বর্তমান পাসওয়ার্ড ভুল',
        400
      );
    }

    user.password = newPassword;
    await user.save();

    // Log action
    await AuditLog.log({
      shop: user.shop,
      user: user._id,
      action: AUDIT_ACTIONS.PASSWORD_CHANGE.en,
      description: 'Password changed',
      req
    });

    return { message: 'Password changed successfully' };
  }

  /**
   * Admin login
   */
  async adminLogin(data, req) {
    const { phone, password } = data;
    const normalizedPhone = normalizePhone(phone);

    const admin = await Admin.findByPhone(normalizedPhone);

    if (!admin) {
      throw new AppError(
        'Invalid credentials',
        'ভুল তথ্য',
        401
      );
    }

    if (admin.isLocked) {
      throw new AppError(
        'Account locked. Try again later',
        'অ্যাকাউন্ট লক। পরে চেষ্টা করুন',
        423
      );
    }

    const adminWithPassword = await Admin.findById(admin._id).select('+password');

    if (!(await adminWithPassword.comparePassword(password))) {
      await admin.incrementLoginAttempts();
      throw new AppError(
        'Invalid credentials',
        'ভুল তথ্য',
        401
      );
    }

    await admin.updateLastLogin();

    // Log action
    await AuditLog.log({
      admin: admin._id,
      action: AUDIT_ACTIONS.USER_LOGIN.en,
      description: `Admin ${admin.name} logged in`,
      req
    });

    const token = admin.generateToken();

    return {
      admin: admin.toJSON(),
      token
    };
  }

  /**
   * Update user profile (name, avatar)
   */
  async updateProfile(userId, data, req) {
    const { name, avatar } = data;

    const user = await User.findById(userId).populate('shop');
    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    if (name !== undefined) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;

    await user.save();

    // Log action
    await AuditLog.log({
      shop: user.shop?._id || user.shop,
      user: user._id,
      action: AUDIT_ACTIONS.PROFILE_UPDATE.en,
      description: `User profile updated: ${name || user.name}`,
      req
    });

    return { user: user.toJSON() };
  }
}

module.exports = new AuthService();

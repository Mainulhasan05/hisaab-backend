const User = require('../models/User.model');
const Shop = require('../models/Shop.model');
const Admin = require('../models/Admin.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('./sms.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS, USER_ROLES, TRIAL_PERIOD_DAYS } = require('../config/constants');
const { getDefaultPermissions } = require('../config/permissions');
const { normalizePhone } = require('../utils/phone.util');
const { seedCategories } = require('../seeds/categorySeeder');

class AuthService {
  /**
   * Register new shop with owner
   */
  async register(data, req) {
    const { phone, password, name, shopName, shopType, shopAddress, shopPhone } = data;

    // Normalize phone
    const normalizedPhone = normalizePhone(phone);

    // Check if phone already exists as owner
    const existingOwner = await User.findOne({
      phone: normalizedPhone,
      role: USER_ROLES.OWNER
    });

    if (existingOwner) {
      throw new AppError(
        'Phone number already registered as shop owner',
        'এই ফোন নম্বর দিয়ে ইতোমধ্যে দোকান নিবন্ধিত আছে',
        409
      );
    }

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
      }
    });

    // Seed default categories for this shop type
    try {
      await seedCategories(shop._id, shopType || 'other');
    } catch (error) {
      console.error('Failed to seed categories:', error.message);
    }

    // Create owner user
    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shop._id,
      role: USER_ROLES.OWNER,
      permissions: getDefaultPermissions(USER_ROLES.OWNER),
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
        role: USER_ROLES.OWNER,
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
      // Generate and send a new OTP so user can verify
      const otp = user.generateOTP();
      await user.save();

      try {
        await SMSService.sendOTP(normalizedPhone, otp);
      } catch (error) {
        console.error('Failed to send OTP:', error);
      }

      const err = new AppError(
        'Phone number not verified. A new OTP has been sent.',
        'ফোন নম্বর যাচাই করা হয়নি। নতুন ওটিপি পাঠানো হয়েছে।',
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

    // Check subscription — auto-update DB status if expired but still marked active
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
      // Do NOT throw — allow login so users can still view their data (read-only mode)
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

    // Generate token
    const token = user.generateToken();

    return {
      user: user.toJSON(),
      shop: shop.toJSON(),
      token,
      // Inform the frontend that the subscription is expired (read-only mode)
      ...(subscriptionExpired && {
        subscriptionExpired: true,
        subscriptionMessage: 'আপনার সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে। আপনি ডেটা দেখতে পারবেন, কিন্তু পরিবর্তন করতে পারবেন না। পুনরায় সক্রিয় করতে সাপোর্টে যোগাযোগ করুন।',
      }),
    };
  }

  /**
   * Get current user profile
   */
  async getMe(userId) {
    const user = await User.findById(userId).populate('shop');

    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    return user;
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
   * Create team member
   */
  async createTeamMember(shopId, ownerId, data, req) {
    const { phone, password, name, role, permissions } = data;
    const normalizedPhone = normalizePhone(phone);

    // Check if phone already exists in this shop
    const existingUser = await User.findByPhoneAndShop(normalizedPhone, shopId);
    if (existingUser) {
      throw new AppError(
        'Phone number already registered in this shop',
        'এই ফোন নম্বর এই দোকানে ইতোমধ্যে নিবন্ধিত',
        409
      );
    }

    const user = await User.create({
      phone: normalizedPhone,
      password,
      name,
      shop: shopId,
      role: role || USER_ROLES.STAFF,
      permissions: permissions || getDefaultPermissions(role || USER_ROLES.STAFF),
      isPhoneVerified: true, // Owner verified
      createdBy: ownerId
    });

    // Update shop stats
    await Shop.findByIdAndUpdate(shopId, { $inc: { 'stats.totalUsers': 1 } });

    // Log action
    await AuditLog.log({
      shop: shopId,
      user: ownerId,
      action: AUDIT_ACTIONS.TEAM_MEMBER_ADD.en,
      description: `Team member ${name} added`,
      entity: { type: 'user', id: user._id, name },
      req
    });

    return user;
  }
}

module.exports = new AuthService();

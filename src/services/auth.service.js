const User = require('../models/User.model');
const Role = require('../models/Role.model');
const Shop = require('../models/Shop.model');
const Admin = require('../models/Admin.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('./sms.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS, TRIAL_PERIOD_DAYS } = require('../config/constants');
const { ROLE_PRESETS, buildPermissionsFromConfig, buildPermissions, LEGACY_PERMISSION_MAP } = require('../config/permissions');
const jwt = require('jsonwebtoken');
const cacheService = require('./cache.service');
const { seedCategories } = require('../seeds/categorySeeder');
const { INITIAL_SHOP_CATEGORIES } = require('../seeds/shopCategorySeeder');
const ShopCategory = require('../models/ShopCategory.model');
const { normalizePhone } = require('../utils/phone.util');
const metaCapi = require('./metaCapi.service');

class AuthService {
  /**
   * Register new shop with owner
   */
  async register(data, req) {
    const { phone, password, name, shopName, shopType, shopAddress, shopPhone, tracking } = data;

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

    // Variant types come from the shop category the owner picked. Admin-managed
    // categories live in the DB, so read there first and fall back to the seed
    // definitions (and finally to a generic set for unknown/custom keys).
    const resolvedShopType = shopType || 'other';
    const enabledVariantTypes = await this.resolveDefaultVariantTypes(resolvedShopType);

    // Create shop first
    const shop = await Shop.create({
      name: shopName,
      type: resolvedShopType,
      address: shopAddress,
      phone: shopPhone || normalizedPhone,
      subscription: {
        plan: 'trial',
        status: 'active',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000)
      },
      settings: {
        enabledVariantTypes
      }
    });

    // Seed default categories for this shop type
    try {
      await seedCategories(shop._id, resolvedShopType);
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

    // Meta Conversions API — the phone isn't verified yet, so this is a Lead.
    // Non-blocking; the returned id is echoed to the browser so its Pixel event
    // carries the same event_id and Meta dedupes the pair.
    const metaEventId = metaCapi.trackSignupLead({ user, shop, tracking, req });

    return {
      user: user.toJSON(),
      shop: shop.toJSON(),
      token,
      otpSent: true,
      metaEventId
    };
  }

  /**
   * Resolve the variant types a new shop starts with, based on its shop type.
   * DB (admin-managed) wins over the static seed list; unknown keys get a
   * generic set so custom categories never register with no variant support.
   */
  async resolveDefaultVariantTypes(shopType) {
    const GENERIC_VARIANT_TYPES = ['size', 'color', 'weight'];

    try {
      const dbCategory = await ShopCategory.findOne({ key: shopType }).select('defaultVariantTypes').lean();
      if (dbCategory && Array.isArray(dbCategory.defaultVariantTypes)) {
        return dbCategory.defaultVariantTypes;
      }
    } catch (error) {
      console.error('Failed to read shop category variant types:', error.message);
    }

    const seed = INITIAL_SHOP_CATEGORIES.find((cat) => cat.key === shopType);
    return seed ? seed.defaultVariantTypes : GENERIC_VARIANT_TYPES;
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

// Legacy team-member creation removed — staff are created via staff.service
  // (/api/staff), which validates roles per-shop and never mutates shared roles.

  /**
   * Send OTP for phone verification
   */
  async sendOTP(phone) {
    const normalizedPhone = normalizePhone(phone);

    // The same phone may hold accounts in multiple shops — target the one
    // still awaiting verification, not an arbitrary (already verified) match
    const user =
      (await User.findOne({ phone: normalizedPhone, isPhoneVerified: false })) ||
      (await User.findOne({ phone: normalizedPhone }));
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
  async verifyOTP(phone, otp, { tracking, req } = {}) {
    const normalizedPhone = normalizePhone(phone);

    // Prefer the account awaiting verification (multi-shop phones)
    const user =
      (await User.findOne({ phone: normalizedPhone, isPhoneVerified: false })) ||
      (await User.findOne({ phone: normalizedPhone }));
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

    // The account only becomes usable here, so this — not the signup form
    // submit — is the CompleteRegistration worth optimising ad spend against.
    const metaEventId = metaCapi.trackRegistrationCompleted({ user, tracking, req });

    return { message: 'Phone verified successfully', metaEventId };
  }

  /**
   * Login user
   */
  async login(data, req) {
    const { phone, password, shopSlug } = data;
    const normalizedPhone = normalizePhone(phone);

    let user;

    if (shopSlug) {
      // Explicit shop selection (second step of a multi-shop login, or direct)
      const shop = await Shop.findBySlug(shopSlug);
      if (!shop) {
        throw new AppError(
          'Shop not found',
          'দোকান পাওয়া যায়নি',
          404
        );
      }
      user = await User.findByPhoneAndShop(normalizedPhone, shop._id).populate('shop').populate('role');

      if (!user) {
        await AuditLog.log({
          shop: null,
          user: null,
          action: AUDIT_ACTIONS.AUTH_FAILED.en,
          description: `Failed login attempt for phone: ${normalizedPhone} (Account not found)`,
          entity: { type: 'auth', name: normalizedPhone },
          req
        }).catch(() => {});

        throw new AppError(
          'Invalid phone number or password',
          'ফোন নম্বর বা পাসওয়ার্ড ভুল',
          401
        );
      }

      const userWithPassword = await User.findById(user._id).select('+password');
      if (!(await userWithPassword.comparePassword(password))) {
        await AuditLog.log({
          shop: user.shop,
          user: user._id,
          action: AUDIT_ACTIONS.AUTH_FAILED.en,
          description: `Failed login attempt for ${user.name} (${normalizedPhone}) — Incorrect password`,
          entity: { type: 'auth', id: user._id, name: user.name },
          req
        }).catch(() => {});

        throw new AppError(
          'Invalid phone number or password',
          'ফোন নম্বর বা পাসওয়ার্ড ভুল',
          401
        );
      }
    } else {
      // The same phone may hold accounts in multiple shops ({phone, shop} is
      // the unique key — e.g. an owner of one shop working as staff in another).
      // Verify the password against every candidate; ask the client to pick a
      // shop only when more than one account matches these credentials.
      const candidates = await User.find({
        phone: normalizedPhone,
        isActive: true
      }).sort({ isOwner: -1 }).select('+password').populate('shop').populate('role');

      if (candidates.length === 0) {
        await AuditLog.log({
          shop: null,
          user: null,
          action: AUDIT_ACTIONS.AUTH_FAILED.en,
          description: `Failed login attempt for phone: ${normalizedPhone} (Account not found)`,
          entity: { type: 'auth', name: normalizedPhone },
          req
        }).catch(() => {});

        throw new AppError(
          'Invalid phone number or password',
          'ফোন নম্বর বা পাসওয়ার্ড ভুল',
          401
        );
      }

      const matches = [];
      for (const candidate of candidates) {
        if (await candidate.comparePassword(password)) matches.push(candidate);
      }

      if (matches.length === 0) {
        await AuditLog.log({
          shop: candidates[0].shop,
          user: candidates[0]._id,
          action: AUDIT_ACTIONS.AUTH_FAILED.en,
          description: `Failed login attempt for ${candidates[0].name} (${normalizedPhone}) — Incorrect password`,
          entity: { type: 'auth', id: candidates[0]._id, name: candidates[0].name },
          req
        }).catch(() => {});

        throw new AppError(
          'Invalid phone number or password',
          'ফোন নম্বর বা পাসওয়ার্ড ভুল',
          401
        );
      }

      const activeMatches = matches.filter((m) => m.shop && m.shop.isActive);

      if (activeMatches.length > 1) {
        // Credentials verified — let the client choose which shop to enter.
        // Only shop identity is disclosed, and only after password check.
        return {
          requiresShopSelection: true,
          accounts: activeMatches.map((m) => ({
            shopSlug: m.shop.slug,
            shopName: m.shop.name,
            isOwner: m.isOwner === true,
            roleName: m.isOwner ? null : (m.role?.name || null),
          })),
        };
      }

      // Single usable account (or all shops inactive — fall through so the
      // shop-deactivated error below fires with the right message).
      // Re-fetch WITHOUT the password field: the comparison copy has +password
      // selected, and any later save() on it would mark password modified and
      // re-hash undefined ("data and salt arguments required").
      const chosen = activeMatches[0] || matches[0];
      user = await User.findById(chosen._id).populate('shop').populate('role');
    }

    // Check if phone is verified
    if (!user.isPhoneVerified) {
      await AuditLog.log({
        shop: user.shop,
        user: user._id,
        action: AUDIT_ACTIONS.AUTH_FAILED.en,
        description: `Failed login attempt for ${user.name} (${normalizedPhone}) — Phone not verified`,
        entity: { type: 'auth', id: user._id, name: user.name },
        req
      }).catch(() => {});

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
      await AuditLog.log({
        shop: user.shop,
        user: user._id,
        action: AUDIT_ACTIONS.AUTH_FAILED.en,
        description: `Failed login attempt for ${user.name} (${normalizedPhone}) — Shop deactivated`,
        entity: { type: 'auth', id: user._id, name: user.name },
        req
      }).catch(() => {});

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

    // Generate auth tokens (access token + refresh token)
    const tokens = user.generateAuthTokens();

    // Build permissions response for frontend
    let permissions = null;
    if (!user.isOwner && user.role && user.role.permissions) {
      permissions = user.role.permissions;
    }

    return {
      user: user.toJSON(),
      shop: shop.toJSON(),
      permissions,
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(subscriptionExpired && {
        subscriptionExpired: true,
        subscriptionMessage: 'আপনার সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে। আপনি ডেটা দেখতে পারবেন, কিন্তু পরিবর্তন করতে পারবেন না।',
      }),
    };
  }

  /**
   * Refresh Token service with Token Rotation
   */
  async refreshToken(refreshTokenStr) {
    if (!refreshTokenStr) {
      throw new AppError('Refresh token required', 'রিফ্রেশ টোকেন প্রয়োজন', 400);
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshTokenStr, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    } catch (err) {
      throw new AppError('Invalid or expired refresh token', 'অবৈধ বা মেয়াাদোত্তীর্ণ রিফ্রেশ টোকেন', 401);
    }

    if (decoded.type !== 'refresh') {
      throw new AppError('Invalid token type', 'অবৈধ টোকেন টাইপ', 401);
    }

    // Check if refresh token has been revoked
    if (decoded.jti) {
      const isRevoked = await cacheService.get(`blacklist:token:${decoded.jti}`);
      if (isRevoked) {
        throw new AppError('Refresh token has been revoked', 'রিফ্রেশ টোকেনটি বাতিল করা হয়েছে', 401);
      }
    }

    const user = await User.findById(decoded.id).populate('shop').populate('role');
    if (!user || !user.isActive) {
      throw new AppError('User account inactive or not found', 'ইউজার অ্যাকাউন্ট নিষ্ক্রিয়', 401);
    }

    // Revoke old refresh token (Token Rotation)
    if (decoded.jti && decoded.exp) {
      const remainingSeconds = Math.max(1, Math.ceil(decoded.exp - Date.now() / 1000));
      await cacheService.set(`blacklist:token:${decoded.jti}`, 'revoked', remainingSeconds);
    }

    // Issue new token pair
    const tokens = user.generateAuthTokens();

    return {
      user: user.toJSON(),
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /**
   * Logout service with token blacklisting
   */
  async logout(accessTokenStr, refreshTokenStr) {
    if (accessTokenStr) {
      try {
        const decodedAccess = jwt.decode(accessTokenStr);
        if (decodedAccess && decodedAccess.jti && decodedAccess.exp) {
          const remainingSeconds = Math.max(1, Math.ceil(decodedAccess.exp - Date.now() / 1000));
          await cacheService.set(`blacklist:token:${decodedAccess.jti}`, 'logout_revoked', remainingSeconds);
        }
      } catch (e) {
        // Silently ignore decode error
      }
    }

    if (refreshTokenStr) {
      try {
        const decodedRefresh = jwt.decode(refreshTokenStr);
        if (decodedRefresh && decodedRefresh.jti && decodedRefresh.exp) {
          const remainingSeconds = Math.max(1, Math.ceil(decodedRefresh.exp - Date.now() / 1000));
          await cacheService.set(`blacklist:token:${decodedRefresh.jti}`, 'logout_revoked', remainingSeconds);
        }
      } catch (e) {
        // Silently ignore decode error
      }
    }

    return { message: 'Logged out successfully', messageBn: 'সফলভাবে লগআউট করা হয়েছে' };
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

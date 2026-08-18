const User = require('../models/User.model');
const Role = require('../models/Role.model');
const Shop = require('../models/Shop.model');
const Admin = require('../models/Admin.model');
const AuditLog = require('../models/AuditLog.model');
const PasswordReset = require('../models/PasswordReset.model');
const SMSService = require('./sms.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS, TRIAL_PERIOD_DAYS, SUBSCRIPTION_PRICE } = require('../config/constants');
const { resolveSubscription, buildSubscriptionNotice } = require('../utils/subscriptionState.util');
const { addBangladeshDays } = require('../utils/bdTime.util');
const billingService = require('./billing.service');
const { ROLE_PRESETS, PRESET_VERSION, buildPermissionsFromConfig, buildPermissions, LEGACY_PERMISSION_MAP } = require('../config/permissions');
const jwt = require('jsonwebtoken');
const cacheService = require('./cache.service');
const { seedCategories } = require('../seeds/categorySeeder');
const { INITIAL_SHOP_CATEGORIES } = require('../seeds/shopCategorySeeder');
const ShopCategory = require('../models/ShopCategory.model');
const { normalizePhone } = require('../utils/phone.util');
const { applyPresetUpgrades } = require('../utils/rolePreset.util');
const { invalidateUserAuthCache } = require('../utils/authCache.util');
const { toBengaliNumber } = require('../utils/bengali.util');
const logger = require('../utils/logger.util');
const metaCapi = require('./metaCapi.service');
const platformNotify = require('./platformNotify.service');

/**
 * Timings for the forgot-password flow. Gathered here rather than inlined
 * because four of the six are quoted back to the user — "wait 60 seconds",
 * "valid for 5 minutes", "5 attempts remaining" — and a number that appears in
 * both a check and a sentence has to come from one place or the app eventually
 * lies to somebody.
 */
const PASSWORD_RESET = {
  /** How long a texted code stays usable. Matches `User.generateOTP`. */
  CODE_TTL_MS: 5 * 60 * 1000,
  /** Minimum gap between two codes to the same number. */
  RESEND_COOLDOWN_MS: 60 * 1000,
  /** The window `MAX_SENDS_PER_WINDOW` is counted over. */
  SEND_WINDOW_MS: 60 * 60 * 1000,
  /**
   * Codes per number per window. This is the real anti-SMS-bombing control —
   * the IP limiter in front of the route is defeated by rotating IPs, this is
   * not defeated by anything, because the budget belongs to the number being
   * texted rather than to whoever is asking.
   */
  MAX_SENDS_PER_WINDOW: 5,
  /**
   * Wrong guesses per code. 6 digits is a million-wide space, so this is not
   * really about brute force; it is about the 1-in-200,000 lucky guess an
   * unlimited retry loop turns into a certainty.
   */
  MAX_VERIFY_ATTEMPTS: 5,
  /** How long the post-verification token is spendable for. */
  TOKEN_TTL_MS: 10 * 60 * 1000,
  /** TTL floor on the record itself — outlives both secrets by a margin. */
  PURGE_MS: 60 * 60 * 1000,
};

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

    // Trial length and starting prices come from the platform settings document
    // so the operator can change them without a deploy. The constants remain the
    // fallback: a Mongo hiccup here must not be what stops a shop registering.
    const settings = await billingService.getSettings();
    const trialDays = settings?.defaultTrialDays ?? TRIAL_PERIOD_DAYS;

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
        // End of the trial's last Bangladesh day, not a timestamp N×24h out —
        // otherwise a shop that signed up at 9pm loses most of its final day.
        expiresAt: addBangladeshDays(new Date(), trialDays),
        trialDays
      },
      billing: {
        monthlyPrice: settings?.defaultMonthlyPrice ?? SUBSCRIPTION_PRICE,
        smsUnitPrice: settings?.defaultSmsUnitPrice ?? 0.4
      },
      settings: {
        enabledVariantTypes
      }
    });

    /**
     * Categories are NO LONGER pre-created here by default.
     *
     * This ran unconditionally and gave a new grocery shop 85 categories, a
     * cosmetics shop 78 and a cloth shop 63 — before either had a single
     * product. Around eight in ten of those rows never held one. The first
     * screen after signup was a required dropdown full of names the shopkeeper
     * had not chosen and largely did not stock, which is a wall, not a
     * head start.
     *
     * The lists still exist and are still offered — from the suggestions panel,
     * parents first, nothing pre-ticked, once the shop has actually seen the
     * app (`category.service.getSuggestions`). Same data, asked instead of
     * assumed.
     *
     * `autoSeedCategoriesOnSignup` defaults false and is the way back if
     * activation moves the wrong way. Reading it through `?.` with a `=== true`
     * fallback keeps registration working when the settings read fails, and
     * fails toward the new behaviour rather than the old one.
     */
    if (settings?.autoSeedCategoriesOnSignup === true) {
      try {
        await seedCategories(shop._id, resolvedShopType);
      } catch (error) {
        console.error('Failed to seed categories:', error.message);
      }
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

    // Tell the founder, over Telegram, before any dashboard could show it.
    // Not awaited: an alert is never worth delaying — or failing — a signup.
    platformNotify.newShop({ shop, user, req });

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
        // Seeded from the current presets, so no upgrade pass is owed.
        presetVersion: PRESET_VERSION,
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

        // Counted, not sent. One wrong password is a typo; the notifier only
        // speaks once a burst forms. See platformNotify.failedLogin.
        platformNotify.failedLogin({
          phone: normalizedPhone,
          name: user.name,
          shopName: user.shop?.name || null,
          req,
        });

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

        platformNotify.failedLogin({
          phone: normalizedPhone,
          name: candidates[0].name,
          shopName: candidates[0].shop?.name || null,
          req,
        });

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

    // Subscription & access — same resolver the request middleware and the
    // owner's banner use, so what login says and what the next request does can
    // never disagree.
    const shop = await Shop.findById(user.shop);
    const access = resolveSubscription(shop);

    if (!shop || access.isBlocked) {
      await AuditLog.log({
        shop: user.shop,
        user: user._id,
        action: AUDIT_ACTIONS.AUTH_FAILED.en,
        description: `Failed login attempt for ${user.name} (${normalizedPhone}) — shop access blocked`,
        entity: { type: 'auth', id: user._id, name: user.name },
        req
      }).catch(() => {});

      throw new AppError(
        'Access to this shop has been suspended. Please contact support on 01757995016.',
        'আপনার দোকানের অ্যাক্সেস বন্ধ করা হয়েছে। যোগাযোগ করুন — ০১৭৫৭৯৯৫০১৬',
        403
      );
    }

    const subscriptionExpired = !access.canWrite;
    if (subscriptionExpired && shop.subscription?.status === 'active') {
      // Keep the denormalised label in step with the date; nothing reads it for
      // enforcement, so a failed write here changes nothing.
      shop.subscription.status = 'expired';
      shop.save().catch(() => {});
    }

    // Populate role for employees (to embed permissions in JWT)
    if (!user.isOwner && user.role) {
      await user.populate('role');

      // Bring a preset-derived role up to the current PRESET_VERSION. The
      // roles page can also do this, but only an owner can open it — without
      // this a cashier would never receive permissions added by a later
      // release. No-ops once the role is stamped, so it costs one indexed read
      // per login thereafter.
      if (user.role) {
        await applyPresetUpgrades([user.role]).catch(() => {});
      }
    }

    // Update last login, and learn whether this device has been seen before.
    // The verdict is what turns a routine "someone logged in" alert into
    // "someone logged in FROM SOMEWHERE NEW", which is the version worth a
    // notification at 11pm.
    const loginContext = await user.updateLastLogin({
      ip: req?.ip || null,
      userAgent: req?.headers?.['user-agent'] || null,
    });

    // Founder alert. Not awaited — see platformNotify's header. A failure here
    // must never turn a successful login into an error.
    platformNotify.userLogin({
      user,
      shop,
      req,
      isFirstLogin: loginContext.isFirstLogin,
      isNewDevice: loginContext.isNewDevice,
    });

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
      // The banner, computed server-side. null when there is nothing to say, so
      // the client renders on truthiness and never has to know the 3-day rule.
      subscriptionNotice: buildSubscriptionNotice(shop),
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
   * Change password (signed in, current password known)
   *
   * Returns a FRESH TOKEN PAIR, and the caller is expected to put the access
   * token back in the cookie. That is not a convenience — without it this
   * endpoint logs the user out of the tab they just used it from, unpredictably.
   *
   * The chain: `user.save()` stamps `passwordChangedAt`, and `protect` rejects
   * any token issued before that stamp (`changedPasswordAfter`). So the session
   * that made this very request is invalid the moment it succeeds. It does not
   * FEEL that way, because `getCachedUser` holds the pre-change document for up
   * to five minutes — so the user carries on working and is then bounced to the
   * login screen at some arbitrary point up to five minutes later, with nothing
   * on screen connecting the two events.
   *
   * Re-issuing here makes the rule do what it is for: every OTHER session on
   * this account dies immediately, and this one continues. The cache is dropped
   * explicitly for the same reason — a stale entry would let the old tokens
   * keep working for the rest of the TTL, which is exactly backwards.
   */
  async changePassword(userId, data, req) {
    const { currentPassword, newPassword } = data;

    const user = await User.findById(userId).select('+password');

    if (!user) {
      throw new AppError(
        'User not found',
        'ইউজার পাওয়া যায়নি',
        404
      );
    }

    if (!(await user.comparePassword(currentPassword))) {
      throw new AppError(
        'Current password is incorrect',
        'বর্তমান পাসওয়ার্ড ভুল',
        400
      );
    }

    // A no-op change would still stamp `passwordChangedAt` and kill every other
    // session on the account, which is a surprising amount of damage for a form
    // submitted by accident.
    if (currentPassword === newPassword) {
      throw new AppError(
        'New password must be different from the current one',
        'নতুন পাসওয়ার্ড আগেরটির থেকে আলাদা হতে হবে',
        400
      );
    }

    user.password = newPassword;
    await user.save();

    await invalidateUserAuthCache(user._id);

    // Log action
    await AuditLog.log({
      shop: user.shop,
      user: user._id,
      action: AUDIT_ACTIONS.PASSWORD_CHANGE.en,
      description: 'Password changed',
      req
    });

    return {
      message: 'Password changed successfully',
      tokens: user.generateAuthTokens()
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * FORGOT PASSWORD
   *
   * Three steps, three endpoints, one `PasswordReset` document per phone:
   *
   *   1. ask    → a 6-digit code goes out by SMS
   *   2. verify → the code is spent, a short-lived reset token comes back
   *   3. reset  → the token is spent, the password is written
   *
   * Two decisions run through all of it and are worth stating once.
   *
   * ── THE FLOW IS KEYED ON THE PHONE, AND RESETS EVERY ACCOUNT ON IT ──────────
   *
   * `{phone, shop}` is the unique key on `User`, so one number can hold an
   * owner account in one shop and a staff account in another. A reset therefore
   * cannot pick "the" account without asking, and asking is both an extra
   * screen and a disclosure of every shop the number works at.
   *
   * So step 3 writes the new password to ALL active accounts on the number, and
   * step 2 tells the caller how many that will be so it is never a surprise.
   * This gives up nothing: whoever received the SMS controls the number, and
   * control of the number is already sufficient to reset each of those accounts
   * one at a time. It also removes the failure this flow would otherwise
   * produce most often — "I reset my password and it still says wrong" from
   * someone who reset one shop and logged into another.
   *
   * ── STEP 1 NEVER SAYS WHETHER THE NUMBER IS REGISTERED ─────────────────────
   *
   * `/auth/send-otp` does (it 404s), and that is a pre-existing leak on a route
   * with a narrower purpose. This one must not: it is the endpoint an attacker
   * would point at a list of numbers to learn which belong to shop owners, which
   * is the input to a targeted phishing call. So a `PasswordReset` row is
   * written for ANY number asked about — registered or not — which is what makes
   * the throttles, the timings and the response identical either way. A code is
   * only minted when there is somebody to send it to.
   * ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Step 1 — send a reset code.
   *
   * @returns {Promise<object>} Always the same shape, whether or not the number
   *          has an account. Only the throttles can make this fail.
   */
  async requestPasswordReset(phone, req) {
    const normalizedPhone = normalizePhone(phone);
    const now = new Date();

    let record = await PasswordReset.findOne({ phone: normalizedPhone });
    if (!record) {
      record = new PasswordReset({
        phone: normalizedPhone,
        purgeAt: new Date(now.getTime() + PASSWORD_RESET.PURGE_MS)
      });

      // `phone` is unique, so a double-tapped "send code" can have both
      // requests find nothing and both try to insert. Losing that race is not
      // an error — the row the winner wrote is exactly the row this request
      // wanted — but left unhandled it surfaces as a 500 on a button people
      // double-tap precisely because they are anxious about being locked out.
      // Adopting the winner's row also means the cooldown below is evaluated
      // against it, so the loser gets a throttle rather than a second SMS.
      try {
        await record.save();
      } catch (error) {
        if (error?.code !== 11000) throw error;
        record = await PasswordReset.findOne({ phone: normalizedPhone });
        if (!record) throw error;
      }
    }

    // Roll the hourly window before reading the count, so a shop that asked
    // five times yesterday is not still locked out today.
    if (
      !record.windowStartedAt ||
      now.getTime() - new Date(record.windowStartedAt).getTime() >= PASSWORD_RESET.SEND_WINDOW_MS
    ) {
      record.windowStartedAt = now;
      record.sendCount = 0;
    }

    // ── The throttles that actually protect the victim ──
    //
    // Checked BEFORE the user lookup, deliberately. They are decided purely by
    // the phone's own history, so they behave identically for a number with no
    // account — which is what keeps the endpoint from answering "is this
    // registered?" through its error codes.
    if (record.sentAt) {
      const elapsed = now.getTime() - new Date(record.sentAt).getTime();
      if (elapsed < PASSWORD_RESET.RESEND_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((PASSWORD_RESET.RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new AppError(
          `Please wait ${secondsLeft} seconds before requesting another code`,
          `অনুগ্রহ করে ${toBengaliNumber(secondsLeft)} সেকেন্ড পর আবার কোড নিন`,
          429
        );
      }
    }

    if (record.sendCount >= PASSWORD_RESET.MAX_SENDS_PER_WINDOW) {
      throw new AppError(
        'Too many reset codes requested for this number. Please try again in an hour.',
        'এই নম্বরে অনেকবার কোড পাঠানো হয়েছে। এক ঘণ্টা পর আবার চেষ্টা করুন।',
        429
      );
    }

    const users = await User.find({ phone: normalizedPhone, isActive: true })
      .select('_id')
      .lean();

    record.sentAt = now;
    record.sendCount += 1;
    record.lastIp = req?.ip || null;
    record.attempts = 0;
    // Asking for a new code invalidates any token an earlier verification
    // handed out — otherwise a token obtained from a code sent to the OLD
    // holder of a recycled number would survive the real owner starting over.
    record.resetTokenHash = null;
    record.resetTokenExpiresAt = null;
    record.purgeAt = new Date(now.getTime() + PASSWORD_RESET.PURGE_MS);

    if (users.length === 0) {
      // The attempt is recorded — that is what keeps the throttles honest for
      // an attacker walking a number list — but nothing is minted and nothing
      // is sent. The caller's response is byte-identical to the success case.
      record.otpHash = null;
      record.otpExpiresAt = null;
      await record.save();

      logger.warn(`Password reset requested for unregistered phone ${normalizedPhone}`);
      return {
        cooldownSeconds: PASSWORD_RESET.RESEND_COOLDOWN_MS / 1000,
        expiresInSeconds: PASSWORD_RESET.CODE_TTL_MS / 1000
      };
    }

    const code = PasswordReset.generateCode();
    record.otpHash = PasswordReset.hashSecret(code);
    record.otpExpiresAt = new Date(now.getTime() + PASSWORD_RESET.CODE_TTL_MS);
    await record.save();

    try {
      await SMSService.sendPasswordResetOtp(normalizedPhone, code);
    } catch (error) {
      // Swallowed on purpose. Surfacing a gateway failure here would answer
      // "does this number have an account?" for anyone who can make the gateway
      // fail, because the no-account path never touches the gateway at all. The
      // shopkeeper's recourse is the resend button; ours is this log line and
      // the `system_password_reset` row `sendPasswordResetOtp` always writes.
      logger.error(`Failed to send password reset OTP to ${normalizedPhone}: ${error.message}`);
    }

    return {
      cooldownSeconds: PASSWORD_RESET.RESEND_COOLDOWN_MS / 1000,
      expiresInSeconds: PASSWORD_RESET.CODE_TTL_MS / 1000
    };
  }

  /**
   * Step 2 — spend the code, get a reset token.
   *
   * The token exists so the last step does not have to re-send the code or ask
   * the browser to hold it: the code is destroyed here, so it cannot be replayed
   * once used, and the token it is traded for is single-use and expires in ten
   * minutes.
   */
  async verifyPasswordResetCode(phone, otp, req) {
    const normalizedPhone = normalizePhone(phone);
    const now = new Date();

    const record = await PasswordReset.findOne({ phone: normalizedPhone });

    // One message for "no such request", "expired" and "never had a code"
    // (the unregistered-number path). Distinguishing them here would give back
    // exactly the oracle step 1 goes to some trouble to withhold.
    const rejected = () => new AppError(
      'Invalid or expired code',
      'কোডটি ভুল বা মেয়াদ শেষ। নতুন কোড নিন।',
      400
    );

    if (!record || !record.hasLiveCode()) {
      throw rejected();
    }

    if (record.attempts >= PASSWORD_RESET.MAX_VERIFY_ATTEMPTS) {
      throw new AppError(
        'Too many incorrect attempts. Request a new code.',
        'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড নিন।',
        429
      );
    }

    if (!PasswordReset.matchesHash(otp, record.otpHash)) {
      record.attempts += 1;
      await record.save();

      const left = PASSWORD_RESET.MAX_VERIFY_ATTEMPTS - record.attempts;
      throw new AppError(
        left > 0 ? `Incorrect code. ${left} attempts remaining.` : 'Incorrect code. Request a new one.',
        left > 0
          ? `কোডটি ভুল। আর ${toBengaliNumber(left)} বার চেষ্টা করতে পারবেন।`
          : 'কোডটি ভুল। নতুন কোড নিন।',
        400
      );
    }

    const resetToken = PasswordReset.generateResetToken();
    record.resetTokenHash = PasswordReset.hashSecret(resetToken);
    record.resetTokenExpiresAt = new Date(now.getTime() + PASSWORD_RESET.TOKEN_TTL_MS);
    // Single use. The code has done its job and must not survive to be replayed
    // against a second token if this one is abandoned.
    record.otpHash = null;
    record.otpExpiresAt = null;
    record.attempts = 0;
    record.purgeAt = new Date(now.getTime() + PASSWORD_RESET.TOKEN_TTL_MS + 5 * 60 * 1000);
    await record.save();

    // Which accounts this will change. Disclosed only after the SMS code was
    // entered correctly — the same bar login sets before it lists a phone's
    // shops — and shown up front so "all your shops" is never a surprise.
    const users = await User.find({ phone: normalizedPhone, isActive: true })
      .select('isOwner shop')
      .populate('shop', 'name')
      .lean();

    logger.info(`Password reset code verified for ${normalizedPhone} (${users.length} account(s))`);

    return {
      resetToken,
      expiresInSeconds: PASSWORD_RESET.TOKEN_TTL_MS / 1000,
      accounts: users.map((u) => ({
        shopName: u.shop?.name || null,
        isOwner: u.isOwner === true
      }))
    };
  }

  /**
   * Step 3 — spend the token, write the password.
   *
   * Every active account on the number is updated; see the block comment above
   * for why. Each save stamps `passwordChangedAt`, which is what invalidates
   * whatever sessions the account had — including, importantly, any session an
   * attacker had already established, which is half of what a reset is FOR. The
   * cache is dropped per user so that takes effect now rather than within five
   * minutes.
   */
  async resetPassword(data, req) {
    const { phone, resetToken, newPassword } = data;
    const normalizedPhone = normalizePhone(phone);
    const now = new Date();

    const record = await PasswordReset.findOne({ phone: normalizedPhone });

    const expired = () => new AppError(
      'This reset session has expired. Please start again.',
      'সময় শেষ হয়ে গেছে। আবার নতুন করে শুরু করুন।',
      400
    );

    if (
      !record ||
      !record.resetTokenHash ||
      !record.resetTokenExpiresAt ||
      record.resetTokenExpiresAt <= now
    ) {
      throw expired();
    }

    if (!PasswordReset.matchesHash(resetToken, record.resetTokenHash)) {
      throw expired();
    }

    const users = await User.find({ phone: normalizedPhone, isActive: true });

    if (users.length === 0) {
      // Only reachable if every account on the number was deactivated between
      // step 2 and step 3. Burn the token anyway — it has no accounts left to
      // act on and must not stay spendable.
      await PasswordReset.deleteOne({ _id: record._id });
      throw new AppError(
        'No active account found for this number',
        'এই নম্বরে সক্রিয় কোনো অ্যাকাউন্ট নেই',
        400
      );
    }

    const shops = [];

    for (const user of users) {
      user.password = newPassword;
      // They just proved they hold the number, which is the whole content of
      // phone verification. Without this an owner who never finished signup
      // resets their password and is still bounced to the OTP screen at login —
      // the exact dead end this feature exists to open up.
      user.isPhoneVerified = true;
      user.clearOTP();
      await user.save();

      await invalidateUserAuthCache(user._id);

      await AuditLog.log({
        shop: user.shop,
        user: user._id,
        action: AUDIT_ACTIONS.PASSWORD_RESET.en,
        description: `Password reset via SMS code for ${user.name} (${normalizedPhone})`,
        entity: { type: 'user', id: user._id, name: user.name },
        req
      }).catch(() => {});

      shops.push(String(user.shop));
    }

    // Single use, and nothing left worth keeping.
    await PasswordReset.deleteOne({ _id: record._id });

    logger.info(`Password reset completed for ${normalizedPhone} across ${users.length} account(s)`);

    return {
      message: 'Password reset successfully',
      accountsUpdated: users.length,
      shopCount: new Set(shops).size
    };
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

    // Always announced, never collapsed. There are a handful of these a week
    // and an admin login the founder did not perform is the worst event this
    // system can have.
    platformNotify.adminLogin({ admin, req });

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

const AuthService = require('../services/auth.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const User = require('../models/User.model');
const cacheService = require('../services/cache.service');
const { invalidateShopAuthCache } = require('../utils/authCache.util');
const { featureMap } = require('../utils/features.util');
const { buildSubscriptionNotice } = require('../utils/subscriptionState.util');
const {
  setUserTokenCookie,
  setAdminTokenCookie,
  clearUserTokenCookie,
  clearAdminTokenCookie,
  COOKIE_NAMES,
  setRefreshTokenCookie,
} = require('../utils/cookie.util');

/**
 * @desc    Register new shop with owner
 * @route   POST /api/auth/register
 * @access  Public
 */
const register = asyncHandler(async (req, res) => {
  const result = await AuthService.register(req.body, req);

  // Set httpOnly cookie
  setUserTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.created(res, {
    data: responseData,
    message: 'Registration successful. Please verify your phone number.',
    messageBn: 'নিবন্ধন সফল। অনুগ্রহ করে ফোন নম্বর যাচাই করুন।'
  });
});

/**
 * @desc    Send OTP for verification
 * @route   POST /api/auth/send-otp
 * @access  Public
 */
const sendOTP = asyncHandler(async (req, res) => {
  const result = await AuthService.sendOTP(req.body.phone);

  return ApiResponse.success(res, {
    data: result,
    message: 'OTP sent successfully',
    messageBn: 'ওটিপি পাঠানো হয়েছে'
  });
});

/**
 * @desc    Verify OTP
 * @route   POST /api/auth/verify-otp
 * @access  Public
 */
const verifyOTP = asyncHandler(async (req, res) => {
  const result = await AuthService.verifyOTP(req.body.phone, req.body.otp, {
    tracking: req.body.tracking,
    req
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Phone verified successfully',
    messageBn: 'ফোন নম্বর যাচাই সফল'
  });
});

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const result = await AuthService.login(req.body, req);

  // Same phone with valid credentials in multiple shops: no session yet —
  // the client shows a shop picker and re-submits with shopSlug
  if (result.requiresShopSelection) {
    return ApiResponse.success(res, {
      data: result,
      message: 'Select a shop to continue',
      messageBn: 'কোন দোকানে ঢুকবেন তা নির্বাচন করুন'
    });
  }

  // Set httpOnly cookie for user (admin cookie stays intact for coexistence)
  setUserTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.success(res, {
    data: responseData,
    message: 'Login successful',
    messageBn: 'লগইন সফল'
  });
});

/**
 * @desc    Logout user and revoke tokens
 * @route   POST /api/auth/logout
 * @access  Private
 */
const logout = asyncHandler(async (req, res) => {
  const accessToken = req.cookies?.[COOKIE_NAMES.USER_TOKEN] || (req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization.split(' ')[1] : null);
  const refreshTokenStr = req.cookies?.refreshToken || req.body?.refreshToken;

  await AuthService.logout(accessToken, refreshTokenStr);

  // Clear the httpOnly cookie
  clearUserTokenCookie(res);
  if (res.clearCookie) {
    res.clearCookie('refreshToken');
  }

  return ApiResponse.success(res, {
    message: 'Logout successful',
    messageBn: 'লগআউট সফল'
  });
});

/**
 * @desc    Refresh access token using refresh token
 * @route   POST /api/auth/refresh
 * @access  Public
 */
const refreshToken = asyncHandler(async (req, res) => {
  const tokenFromCookie = req.cookies?.refreshToken || req.cookies?.[COOKIE_NAMES.USER_TOKEN];
  const refreshTokenStr = req.body?.refreshToken || tokenFromCookie;

  const result = await AuthService.refreshToken(refreshTokenStr);

  setUserTokenCookie(res, result.accessToken);
  if (res.cookie) {
    /**
     * Hand-rolled options here were wrong in two ways that only showed up in
     * production:
     *
     *   1. `sameSite: 'lax'` — hardcoded, while every other cookie in this app
     *      uses `'none'` in production because the frontend and the API are on
     *      different origins. A Lax cookie is NOT sent on a cross-site request,
     *      so the refresh token was unusable in exactly the deployment it was
     *      written for. It worked locally (same-site) and silently did nothing
     *      live.
     *   2. a hardcoded 7-day maxAge next to a token signed for a different
     *      length — the pair of clocks this module exists to keep in step.
     *
     * `setRefreshTokenCookie` derives both from USER_SESSION_DAYS and shares
     * `getCookieOptions` with every other cookie, so there is one definition of
     * "how our cookies are set" rather than one per call site.
     */
    setRefreshTokenCookie(res, result.refreshToken);
  }

  return ApiResponse.success(res, {
    data: result,
    message: 'Token refreshed successfully',
    messageBn: 'টোকেন সফলভাবে রিফ্রেশ করা হয়েছে'
  });
});

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
const getMe = asyncHandler(async (req, res) => {
  // Handle regular user token
  if (req.user) {
    const result = await AuthService.getMe(req.user._id);

    // Branch context, already resolved by `protect` for this request — no extra
    // query. Returning it here is what lets the client hydrate its branch state
    // on the very first paint: previously the switcher rendered "All Branches"
    // while axios was already sending a branch header from localStorage, so the
    // label and the data disagreed (FEATURE_AUDIT.md H-15).
    //
    // `branches` is the owner's switcher list; staff get only their own, so the
    // response never reveals branches they cannot use.
    const isMultiBranch = Boolean(req.shop?.multiBranchEnabled);
    const allBranches = req.user.branchList || [];
    const branches = !isMultiBranch
      ? []
      : (result.user.isOwner
        ? allBranches
        : allBranches.filter((b) => String(b._id) === String(req.branchId || '')));

    return ApiResponse.success(res, {
      data: {
        user: result.user,
        shop: req.shop,
        permissions: result.permissions,
        multiBranchEnabled: isMultiBranch,
        activeBranchId: req.branchId ? String(req.branchId) : null,
        activeBranch: req.branch
          ? { _id: String(req.branch._id), name: req.branch.name, code: req.branch.code }
          : null,
        branches,
        // Whether customers and dues are per-branch (Phase 7). The UI needs it
        // only to label the customer pages: an owner who switches branch and
        // sees the customer count change reads that as a bug unless the page
        // says which book it is showing. Always 'shop' for single-branch shops,
        // so nothing about their UI changes.
        customerScope: isMultiBranch ? (req.shop?.customerScope || 'branch') : 'shop',
        // Opt-in capabilities (Shop.features). Sent as a COMPLETE map — every
        // known key present as a real boolean, never only the enabled ones —
        // because the client renders "off" differently from "not loaded yet",
        // and a sparse object makes those two indistinguishable on first paint.
        //
        // The client does not receive the unit catalogue here; it builds that
        // locally from `lib/units.js` (mirrored from `config/units.js`, kept
        // honest by `scripts/check-unit-parity.mjs`). Sending ~50 units on the
        // hottest endpoint to save a file that has to exist anyway is a bad
        // trade.
        features: featureMap(req.shop),
        // The subscription banner, decided server-side by the same resolver
        // that decides whether this request may write. null = nothing to say.
        // Every user gets it, staff included: a cashier who sees "৩ দিন পর
        // মেয়াদ শেষ" tells the owner, and when writes do stop they already
        // know why instead of thinking the app broke.
        subscriptionNotice: buildSubscriptionNotice(req.shop),
      },
      message: 'Profile retrieved',
      messageBn: 'প্রোফাইল পাওয়া গেছে'
    });
  }

  // Handle guest (not authenticated)
  return ApiResponse.success(res, {
    data: { user: null, shop: null, permissions: null },
    message: 'Not authenticated',
    messageBn: 'লগইন করা নেই'
  });
});

/**
 * @desc    Change password
 * @route   POST /api/auth/change-password
 * @access  Private
 */
const changePassword = asyncHandler(async (req, res) => {
  const { tokens, ...result } = await AuthService.changePassword(req.user._id, req.body, req);

  // The old cookie is dead the instant the password changed — `protect` rejects
  // any token minted before `passwordChangedAt`. Swapping in the fresh one here
  // is what keeps THIS session alive while killing every other one; see the
  // service for the full reasoning.
  if (tokens?.accessToken) {
    setUserTokenCookie(res, tokens.accessToken);
  }

  return ApiResponse.success(res, {
    data: result,
    message: 'Password changed successfully',
    messageBn: 'পাসওয়ার্ড পরিবর্তন সফল'
  });
});

/**
 * @desc    Send a password reset code by SMS
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const result = await AuthService.requestPasswordReset(req.body.phone, req);

  // Worded so it is true, and equally true, whether or not the number has an
  // account — the response must not be the thing that tells an attacker which.
  // The client shows the same sentence, so a shopkeeper who mistyped their
  // number learns it from the code never arriving rather than from us
  // confirming the typo exists as somebody else's account.
  return ApiResponse.success(res, {
    data: result,
    message: 'If this number has an account, a reset code has been sent to it',
    messageBn: 'এই নম্বরে অ্যাকাউন্ট থাকলে একটি কোড পাঠানো হয়েছে'
  });
});

/**
 * @desc    Verify a password reset code, exchanging it for a reset token
 * @route   POST /api/auth/forgot-password/verify
 * @access  Public
 */
const verifyPasswordResetCode = asyncHandler(async (req, res) => {
  const result = await AuthService.verifyPasswordResetCode(req.body.phone, req.body.otp, req);

  return ApiResponse.success(res, {
    data: result,
    message: 'Code verified',
    messageBn: 'কোড যাচাই সফল'
  });
});

/**
 * @desc    Set a new password using a verified reset token
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
const resetPassword = asyncHandler(async (req, res) => {
  const result = await AuthService.resetPassword(req.body, req);

  // Deliberately NOT logged in afterwards. A reset can be performed from a
  // device that is not the owner's — a shop phone, a relative's handset — and
  // handing that device a session is a worse default than one more login. It
  // also means the new password is used once immediately, which is how a typo
  // in a password box nobody can read is caught while the user still remembers
  // what they typed.
  return ApiResponse.success(res, {
    data: result,
    message: 'Password reset successfully. Please log in.',
    messageBn: 'পাসওয়ার্ড পরিবর্তন হয়েছে। এখন লগইন করুন।'
  });
});

/**
 * @desc    Admin login
 * @route   POST /api/auth/admin/login
 * @access  Public
 */
const adminLogin = asyncHandler(async (req, res) => {
  const result = await AuthService.adminLogin(req.body, req);

  // Set httpOnly cookie for admin (user cookie stays intact for coexistence)
  setAdminTokenCookie(res, result.token);

  // Remove token from response data (it's in the cookie now)
  const { token, ...responseData } = result;

  return ApiResponse.success(res, {
    data: responseData,
    message: 'Admin login successful',
    messageBn: 'অ্যাডমিন লগইন সফল'
  });
});

// Legacy /api/auth/team handlers removed — superseded by /api/staff + /api/roles.

/**
 * @desc    Update shop settings
 * @route   PATCH /api/auth/shop/settings
 * @access  Private (Owner only)
 */
const updateShopSettings = asyncHandler(async (req, res) => {
  const Shop = require('../models/Shop.model');

  // Basic shop info fields that can be updated directly
  const allowedBasicFields = ['name', 'phone', 'address'];

  // Settings fields that go under settings object
  const allowedSettings = [
    'lowStockThreshold',
    'invoicePrefix',
    'taxEnabled',
    'taxRate',
    'showUnitOnInvoice',
    'enabledVariantTypes'
  ];

  const updates = {};

  // Handle basic fields
  for (const key of allowedBasicFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // ── The extra numbers printed on the invoice header ────────────────────────
  //
  // Not in `allowedBasicFields`, because an array cannot be written through
  // untouched the way a string can: an unnormalised one reaches the invoice as
  // whatever the client sent, blanks and duplicates included, and prints that
  // way. `normalizeInvoicePhones` is the single place those rules live, shared
  // with the branch route so the two cannot drift.
  //
  // `[]` IS A REAL VALUE here — it is how the owner removes the last extra
  // number — so presence is tested with `in`, not with `!== undefined`. An
  // ABSENT key still means "leave it alone".
  if ('invoicePhones' in req.body) {
    const { normalizeInvoicePhones } = require('../utils/phone.util');
    updates.invoicePhones = normalizeInvoicePhones(req.body.invoicePhones);
  }

  // Handle settings fields
  for (const key of allowedSettings) {
    if (req.body[key] !== undefined) {
      updates[`settings.${key}`] = req.body[key];
    }
  }

  // ── The per-line discount cap ──────────────────────────────────────────────
  //
  // NOT in `allowedSettings` above, because it needs three things that list
  // cannot express.
  //
  // 1. IT IS OWNER-ONLY. `rbac('settings', 'update')` can be granted to a
  //    manager, and a manager who can raise the discount ceiling can raise
  //    their own — which is the same escalation `resolveWholesaleFlag` exists
  //    to prevent for `isWholesale`.
  //
  // 2. IT IS CAPABILITY-GATED. Storing a cap for a shop that cannot give line
  //    discounts is a setting that does nothing, which is a support ticket
  //    waiting to happen.
  //
  // 3. `null` IS A REAL VALUE. Every other key here is "absent means leave it
  //    alone"; this one additionally needs "explicitly cleared means no cap".
  //    An empty box on the form must therefore reach the database as `null`,
  //    not be skipped — while an ABSENT key still means untouched, which is
  //    what keeps the form reversible when the capability is switched off
  //    (AGENT_WORKFLOW.md I-7).
  if ('maxLineDiscountPercent' in req.body) {
    const { hasFeature } = require('../utils/features.util');
    const raw = req.body.maxLineDiscountPercent;

    if (!hasFeature(req, 'lineDiscount')) {
      return ApiResponse.forbidden(res, {
        message: 'Per-item discount is not enabled for this shop',
        messageBn: 'এই দোকানে পণ্যভিত্তিক ছাড় সুবিধা চালু নেই',
      });
    }
    if (!req.user?.isOwner && !req.isAdmin) {
      return ApiResponse.forbidden(res, {
        message: 'Only the shop owner can set the discount limit',
        messageBn: 'শুধুমাত্র দোকান মালিক ছাড়ের সীমা ঠিক করতে পারবেন',
      });
    }

    if (raw === null || raw === '') {
      updates['settings.maxLineDiscountPercent'] = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return ApiResponse.badRequest(res, {
          message: 'Discount limit must be between 0 and 100',
          messageBn: 'ছাড়ের সীমা ০ থেকে ১০০ এর মধ্যে দিন',
        });
      }
      updates['settings.maxLineDiscountPercent'] = n;
    }
  }

  // ── খাতা বন্ধ: the period lock ────────────────────────────────────────────
  //
  // NOT in `allowedSettings`, for two of the three reasons the discount cap is
  // not, plus one of its own.
  //
  // 1. IT IS OWNER-ONLY. `rbac('settings','update')` can be granted to a
  //    manager, and this is the one setting whose whole purpose is to bind the
  //    people who hold `sales.backdate` — a manager who could move the line
  //    could open a closed month, post into it, and close it again. The lock
  //    would then be exactly as strong as the honesty it was built to stop
  //    relying on.
  //
  // 2. `null` IS A REAL VALUE. Clearing the box means "nothing is closed", and
  //    it must reach the database as `null` rather than being skipped. An
  //    ABSENT key still means untouched.
  //
  // 3. MOVING IT BACKWARD IS NOT REFUSED, BUT IT IS LOUD. A shop that closed
  //    July and then finds a missing invoice has to be able to reopen it —
  //    refusing would leave them with a book they know is wrong and no way to
  //    fix it, which is how people go back to paper. So the move is allowed and
  //    AUDITED: the entry below names both dates, so "who reopened June, and
  //    when" has an answer. That is the same trade the credit-limit override
  //    makes, for the same reason.
  if ('booksClosedThrough' in req.body) {
    const raw = req.body.booksClosedThrough;

    if (!req.user?.isOwner && !req.isAdmin) {
      return ApiResponse.forbidden(res, {
        message: 'Only the shop owner can close or reopen the books',
        messageBn: 'শুধুমাত্র দোকান মালিক খাতা বন্ধ বা খুলতে পারবেন',
      });
    }

    if (raw === null || raw === '') {
      updates['settings.booksClosedThrough'] = null;
    } else {
      const { getBangladeshDayRange, getBangladeshTodayStr } = require('../utils/bdTime.util');
      const bare = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
        ? raw.trim() : null;
      const when = bare ? getBangladeshDayRange(bare).endOfDay : new Date(raw);

      if (Number.isNaN(when.getTime())) {
        return ApiResponse.badRequest(res, {
          message: 'Invalid closing date',
          messageBn: 'খাতা বন্ধের তারিখ ঠিকভাবে দিন',
        });
      }
      // Closing a day that has not finished trading would refuse the rest of
      // today's sales — the one thing this feature must never do.
      const todayEnd = getBangladeshDayRange(getBangladeshTodayStr()).endOfDay;
      if (when.getTime() >= todayEnd.getTime()) {
        return ApiResponse.badRequest(res, {
          message: 'The books can only be closed through a day that has already ended',
          messageBn: 'আজ বা পরের তারিখ পর্যন্ত খাতা বন্ধ করা যাবে না — গতকাল পর্যন্ত করুন',
        });
      }
      updates['settings.booksClosedThrough'] = when;
    }
  }

  // ── The shop's own variant vocabulary ─────────────────────────────────────
  //
  // Only the three things that CANNOT be derived from the shop's products: a
  // type they invented, a type they want renamed, and a value they want the app
  // to stop offering. The options themselves are read out of
  // `Product.variants[].attributes` and are not settable here at all — see
  // `variantCatalog.service` for why that is the whole point.
  //
  // Bounded on every axis. This document is loaded on every authenticated
  // request, so an unbounded blob here is a tax on every page load in the app;
  // and the values arrive from a form, which means they arrive from anyone who
  // can reach the form.
  if (req.body.variantCatalog !== undefined) {
    const incoming = req.body.variantCatalog;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      return ApiResponse.badRequest(res, {
        message: 'variantCatalog must be an object',
        messageBn: 'ভ্যারিয়েন্ট সেটিংস সঠিক নয়',
      });
    }

    // A type id becomes a KEY under `attributes.custom`, so it has to be a
    // legal Mongo field name: no dots, no leading `$`. Slugged rather than
    // rejected, because the shopkeeper types a Bangla label and should never
    // meet the concept of an id at all.
    const slug = (raw) =>
      String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);

    if (incoming.customTypes !== undefined) {
      if (!Array.isArray(incoming.customTypes)) {
        return ApiResponse.badRequest(res, {
          message: 'customTypes must be a list',
          messageBn: 'ভ্যারিয়েন্টের ধরন তালিকা সঠিক নয়',
        });
      }
      const seen = new Set();
      const types = [];
      for (const raw of incoming.customTypes.slice(0, 12)) {
        const label = String(raw?.label || '').trim().slice(0, 40);
        if (!label) continue;
        // Falls back to slugging the LABEL, so a client that never sends an id
        // still gets a stable one — and a Bangla-only label that slugs to
        // nothing gets a positional id rather than being silently dropped.
        const id = slug(raw?.id) || slug(label) || `type-${types.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        types.push({ id, label, icon: String(raw?.icon || '🏷️').trim().slice(0, 8) });
      }
      updates['settings.variantCatalog.customTypes'] = types;
    }

    if (incoming.labels !== undefined) {
      if (typeof incoming.labels !== 'object' || incoming.labels === null || Array.isArray(incoming.labels)) {
        return ApiResponse.badRequest(res, {
          message: 'labels must be an object',
          messageBn: 'ভ্যারিয়েন্টের নাম সঠিক নয়',
        });
      }
      const labels = {};
      for (const [key, value] of Object.entries(incoming.labels).slice(0, 24)) {
        const id = slug(key);
        const label = String(value || '').trim().slice(0, 40);
        // An empty label is how the form clears an override back to the
        // built-in name, so it is dropped rather than stored as ''.
        if (id && label) labels[id] = label;
      }
      updates['settings.variantCatalog.labels'] = labels;
    }

    if (incoming.hidden !== undefined) {
      if (typeof incoming.hidden !== 'object' || incoming.hidden === null || Array.isArray(incoming.hidden)) {
        return ApiResponse.badRequest(res, {
          message: 'hidden must be an object',
          messageBn: 'লুকানো অপশন সঠিক নয়',
        });
      }
      const hidden = {};
      for (const [key, value] of Object.entries(incoming.hidden).slice(0, 24)) {
        const id = slug(key);
        if (!id || !Array.isArray(value)) continue;
        const values = [
          ...new Set(
            value
              .map((v) => String(v || '').trim().slice(0, 60))
              .filter(Boolean)
          ),
        ].slice(0, 100);
        if (values.length > 0) hidden[id] = values;
      }
      updates['settings.variantCatalog.hidden'] = hidden;
    }
  }

  // ── Which messages this shop sends its customers automatically ────────────
  //
  // `smsSettings` has been on the Shop document for as long as the SMS feature
  // has existed, and NOTHING outside the admin panel could write it. So the
  // switch that decides whether a customer gets a receipt when they clear their
  // খাতা was reachable only by us — a shopkeeper paying for SMS could not turn
  // their own receipts on, and support was doing it by hand, one shop at a
  // time. That is the gap this closes.
  //
  // ── What deliberately stays admin-only ─────────────────────────────────────
  //
  // `invoiceTemplate` and `numerals`. A bad template is billed to the shop's
  // quota on EVERY sale, which is why the segment ceiling that guards it lives
  // in `admin.service`; widening this allowlist to reach it would route around
  // that check rather than duplicate it. See the note on the field in
  // Shop.model.js. `numerals` only decorates a custom template, so it follows
  // the template.
  //
  // ── On `language` ─────────────────────────────────────────────────────────
  //
  // Allowed here, and it is a MONEY decision rather than a taste one: a Bangla
  // body is UCS-2, which halves the characters per segment and typically turns
  // a one-segment receipt into two. The shop pays that difference on every
  // message, so the shop chooses. The composer shows the segment count beside
  // the toggle for exactly this reason.
  //
  // Nested one level down, so each key is written as its own `settings.x.y`
  // path. Writing the OBJECT would silently drop whichever sibling the client
  // did not send — including the admin-only template.
  if (req.body.smsSettings !== undefined) {
    const incoming = req.body.smsSettings;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      return ApiResponse.badRequest(res, {
        message: 'smsSettings must be an object',
        messageBn: 'এসএমএস সেটিংস সঠিক নয়',
      });
    }

    if (incoming.autoSendOnSale !== undefined) {
      updates['settings.smsSettings.autoSendOnSale'] = Boolean(incoming.autoSendOnSale);
    }
    if (incoming.autoSendOnDuePayment !== undefined) {
      updates['settings.smsSettings.autoSendOnDuePayment'] = Boolean(incoming.autoSendOnDuePayment);
    }
    if (incoming.sendToCustomersWithPhone !== undefined) {
      updates['settings.smsSettings.sendToCustomersWithPhone'] = Boolean(
        incoming.sendToCustomersWithPhone
      );
    }
    if (incoming.minSaleAmountForSms !== undefined) {
      const minimum = Number(incoming.minSaleAmountForSms);
      if (!Number.isFinite(minimum) || minimum < 0) {
        return ApiResponse.badRequest(res, {
          message: 'Minimum sale amount must be 0 or more',
          messageBn: 'সর্বনিম্ন বিক্রয় পরিমাণ ০ বা তার বেশি দিন',
        });
      }
      updates['settings.smsSettings.minSaleAmountForSms'] = minimum;
    }
    if (incoming.language !== undefined) {
      if (!['bn', 'en'].includes(incoming.language)) {
        return ApiResponse.badRequest(res, {
          message: 'SMS language must be bn or en',
          messageBn: 'এসএমএস ভাষা bn অথবা en হতে হবে',
        });
      }
      updates['settings.smsSettings.language'] = incoming.language;
    }
  }

  if (Object.keys(updates).length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'No valid settings provided',
      messageBn: 'কোন বৈধ সেটিংস প্রদান করা হয়নি'
    });
  }

  const shop = await Shop.findByIdAndUpdate(
    req.shop._id,
    { $set: updates },
    { new: true }
  );

  await invalidateShopAuthCache(req.shop._id);

  /**
   * ── Moving the period lock is on the record ──────────────────────────────
   *
   * The only setting on this route that gets its own audit entry, because it is
   * the only one that decides whether OTHER records can be rewritten. Closing
   * the books is a sign-off; reopening them is the act that makes a signed-off
   * month editable again, and "who reopened June, and when" has to have an
   * answer — otherwise the lock protects nothing that honesty was not already
   * protecting.
   *
   * Both dates are recorded, so a reopen is distinguishable from a close at a
   * glance rather than by reading two entries side by side.
   *
   * Fire-and-forget: a settings save that failed because its logging did would
   * leave the owner unable to close their books at all.
   */
  if ('settings.booksClosedThrough' in updates) {
    const AuditLog = require('../models/AuditLog.model');
    const before = req.shop?.settings?.booksClosedThrough || null;
    const after = updates['settings.booksClosedThrough'];
    const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'none');
    const reopened = Boolean(before) && (!after || new Date(after) < new Date(before));

    AuditLog.create({
      shop: req.shop._id,
      user: req.user?._id,
      action: reopened ? 'books_reopened' : 'books_closed',
      actionBn: reopened ? 'খাতা খোলা হয়েছে' : 'খাতা বন্ধ করা হয়েছে',
      description: `Books closed-through moved: ${fmt(before)} → ${fmt(after)}`,
      descriptionBn: `খাতা বন্ধের তারিখ পরিবর্তন: ${fmt(before)} → ${fmt(after)}`,
      entity: { type: 'shop', id: req.shop._id, name: req.shop?.name },
      changes: {
        before: { booksClosedThrough: before },
        after: { booksClosedThrough: after },
      },
    }).catch(() => {});
  }

  return ApiResponse.success(res, {
    data: { shop },
    message: 'Settings updated successfully',
    messageBn: 'সেটিংস আপডেট হয়েছে'
  });
});

/**
 * @desc    Admin logout
 * @route   POST /api/auth/admin/logout
 * @access  Private (Admin)
 */
const adminLogout = asyncHandler(async (req, res) => {
  // Clear the httpOnly admin cookie
  clearAdminTokenCookie(res);

  return ApiResponse.success(res, {
    message: 'Admin logout successful',
    messageBn: 'অ্যাডমিন লগআউট সফল'
  });
});

/**
 * @desc    Update user profile
 * @route   PATCH /api/auth/profile
 * @access  Private
 */
const updateProfile = asyncHandler(async (req, res) => {
  const result = await AuthService.updateProfile(req.user._id, req.body, req);

  return ApiResponse.success(res, {
    data: result,
    message: 'Profile updated successfully',
    messageBn: 'প্রোফাইল আপডেট সফল হয়েছে'
  });
});

/**
 * @desc    Verify current user's password for delete actions
 * @route   POST /api/auth/verify-password
 * @access  Private
 */
const verifyPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return ApiResponse.badRequest(res, {
      message: 'Password is required',
      messageBn: 'পাসওয়ার্ড দেওয়া আবশ্যক'
    });
  }

  const user = await User.findById(req.user._id).select('+password');
  if (!user) {
    return ApiResponse.unauthorized(res, {
      message: 'User not found',
      messageBn: 'ব্যবহারকারী পাওয়া যায়নি'
    });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return ApiResponse.badRequest(res, {
      message: 'Incorrect password',
      messageBn: 'পাসওয়ার্ড সঠিক নয়'
    });
  }

  return ApiResponse.success(res, {
    message: 'Password verified successfully',
    messageBn: 'পাসওয়ার্ড সফলভাবে যাচাই করা হয়েছে'
  });
});

module.exports = {
  register,
  sendOTP,
  verifyOTP,
  login,
  logout,
  refreshToken,
  getMe,
  changePassword,
  forgotPassword,
  verifyPasswordResetCode,
  resetPassword,
  adminLogin,
  adminLogout,
  updateShopSettings,
  updateProfile,
  verifyPassword
};

/**
 * Platform billing — admin endpoints.
 *
 * Thin by design: every rule (a free extension needs a reason, a block needs a
 * reason, extending never unblocks) lives in `billing.service` because the
 * panel is not the only caller. These handlers translate HTTP to that service
 * and nothing else.
 */

const billingService = require('../services/billing.service');
const PlatformSetting = require('../models/PlatformSetting.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');

/** Who did it, in the shape the service and the ledger both store. */
const actorOf = (req) => ({ kind: 'admin', id: req.admin?._id, name: req.admin?.name });

/**
 * Accept the pre-billing request shapes the existing admin screens still send.
 *
 * The payments page posts `{ months }` and the SMS page posts
 * `{ price, paymentMethod }`. Translating here rather than widening the service
 * signature keeps the old vocabulary at the edge, where it can be deleted in
 * one place once those screens are rebuilt.
 */
const withLegacyPaymentFields = (body) => ({
  ...body,
  mode: body.mode || 'months',
  value: body.value ?? body.months ?? 1,
  // `backdate` arrives from a checkbox, so it can be the string "false".
  backdate: body.backdate === true || body.backdate === 'true',
});

const withLegacySmsFields = (body) => ({
  ...body,
  amount: body.amount ?? body.price,
  method: body.method || body.paymentMethod,
});

// ── one shop ──────────────────────────────────────────────────────────────

exports.getShopBilling = asyncHandler(async (req, res) => {
  const data = await billingService.getShopBilling(req.params.id);
  return ApiResponse.success(res, {
    data,
    message: 'Billing details retrieved',
    messageBn: 'বিলিং তথ্য লোড হয়েছে',
  });
});

exports.startTrial = asyncHandler(async (req, res) => {
  const data = await billingService.startTrial(actorOf(req), req.params.id, req.body);
  return ApiResponse.success(res, {
    data,
    message: 'Trial started',
    messageBn: 'ট্রায়াল চালু হয়েছে',
  });
});

exports.extendSubscription = asyncHandler(async (req, res) => {
  const data = await billingService.extendSubscription(actorOf(req), req.params.id, req.body);
  return ApiResponse.success(res, {
    data,
    message: 'Subscription extended',
    messageBn: 'মেয়াদ বাড়ানো হয়েছে',
  });
});

/**
 * Block or unblock. Unblock is deliberately the same endpoint and the same
 * permission as block — a shop that can be switched off must always be
 * switchable back on by whoever can reach this route (invariant §8.2).
 */
exports.setAccess = asyncHandler(async (req, res) => {
  const data = await billingService.setAccess(actorOf(req), req.params.id, req.body);
  const blocked = req.body.action === 'block';
  return ApiResponse.success(res, {
    data,
    message: blocked ? 'Shop access blocked' : 'Shop access restored',
    messageBn: blocked ? 'দোকানের অ্যাক্সেস বন্ধ করা হয়েছে' : 'দোকানের অ্যাক্সেস চালু করা হয়েছে',
  });
});

exports.updateBillingProfile = asyncHandler(async (req, res) => {
  const data = await billingService.updateBillingProfile(actorOf(req), req.params.id, req.body);
  return ApiResponse.success(res, {
    data,
    message: 'Billing profile updated',
    messageBn: 'বিলিং তথ্য আপডেট হয়েছে',
  });
});

// ── money ─────────────────────────────────────────────────────────────────

exports.listPayments = asyncHandler(async (req, res) => {
  const result = await billingService.listPayments(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Payments retrieved',
    messageBn: 'পেমেন্ট তালিকা লোড হয়েছে',
  });
});

/**
 * Record a payment.
 *
 * `extend: false`, or any type other than `subscription`, books the money
 * without moving the expiry — a setup fee or a correction. The default is to
 * extend, because that is what a subscription payment is for.
 */
exports.recordPayment = asyncHandler(async (req, res) => {
  const type = req.body.type || 'subscription';
  const buysTime = type === 'subscription' && req.body.extend !== false;

  const data = buysTime
    ? await billingService.applySubscriptionPayment({
      ...withLegacyPaymentFields(req.body),
      actor: actorOf(req),
      source: 'manual',
    })
    : await billingService.recordCharge(actorOf(req), { ...req.body, type });
  return ApiResponse.success(res, {
    data,
    message: 'Payment recorded',
    messageBn: 'পেমেন্ট রেকর্ড হয়েছে',
    statusCode: 201,
  });
});

/**
 * Correct a payment's details in place — the received date, the TrxID, the
 * method, the note. Not the amount and not the shop: those are a reversal.
 */
exports.amendPayment = asyncHandler(async (req, res) => {
  const data = await billingService.amendPayment(actorOf(req), req.params.paymentId, req.body);
  return ApiResponse.success(res, {
    data,
    message: 'Payment details corrected',
    messageBn: 'পেমেন্টের তথ্য সংশোধন করা হয়েছে',
  });
});

exports.reversePayment = asyncHandler(async (req, res) => {
  const data = await billingService.reversePayment(actorOf(req), req.params.paymentId, req.body?.reason);
  return ApiResponse.success(res, {
    data,
    message: 'Payment reversed',
    messageBn: 'পেমেন্ট বাতিল করা হয়েছে',
  });
});

exports.allocateSms = asyncHandler(async (req, res) => {
  const data = await billingService.recordSmsPurchase(actorOf(req), withLegacySmsFields(req.body));
  return ApiResponse.success(res, {
    data,
    message: 'SMS allocated',
    messageBn: 'এসএমএস বরাদ্দ হয়েছে',
  });
});

// ── worklist & summary ────────────────────────────────────────────────────

/**
 * The operator's daily call list. With no outbound reminders, this endpoint is
 * the collection process — see SUBSCRIPTION_PLAN.md §11.5.
 */
exports.getWorklist = asyncHandler(async (req, res) => {
  const [result, counts] = await Promise.all([
    billingService.getWorklist(req.query),
    billingService.getWorklistCounts(Number(req.query.days) || 3),
  ]);
  return ApiResponse.paginated(res, {
    ...result,
    counts,
    message: 'Subscription worklist retrieved',
    messageBn: 'সাবস্ক্রিপশন তালিকা লোড হয়েছে',
  });
});

exports.getSummary = asyncHandler(async (req, res) => {
  const data = await billingService.getSummary();
  return ApiResponse.success(res, {
    data,
    message: 'Billing summary retrieved',
    messageBn: 'বিলিং সারাংশ লোড হয়েছে',
  });
});

// ── platform settings ─────────────────────────────────────────────────────

exports.getPlatformSettings = asyncHandler(async (req, res) => {
  const data = await PlatformSetting.current();
  return ApiResponse.success(res, {
    data,
    message: 'Platform settings retrieved',
    messageBn: 'প্ল্যাটফর্ম সেটিংস লোড হয়েছে',
  });
});

/**
 * Clean an incoming tier ladder.
 *
 * Validated here rather than left to the schema because the failure modes are
 * shapes Mongoose would happily store: a tier with a blank price casts to 0 and
 * becomes a free pack, and two tiers at the same quantity render as duplicate
 * tiles the operator cannot tell apart. Sorted ascending on the way in so the
 * panel never has to sort a list that is supposed to be a ladder.
 */
/**
 * Same job as `normalizeSmsTiers`, for the subscription ladder.
 *
 * Rejects what Mongoose would happily store: a package with a blank price casts
 * to 0 and becomes a free year, and two rungs at the same month count render as
 * duplicate tiles an owner cannot tell apart. Sorted ascending on the way in, so
 * neither panel has to sort a list that is supposed to already be a ladder.
 *
 * It does NOT reject a flat or inverted ladder. That is a pricing judgement, not
 * a data error — the admin form flags it on the row instead, because an operator
 * mid-way through re-pricing has a legitimate reason to save an odd-looking
 * intermediate state, and refusing the save would lose the rest of their edits.
 */
const normalizeSubscriptionPackages = (packages) => {
  if (!Array.isArray(packages)) {
    throw new AppError('Subscription packages must be a list', 'প্যাকেজ তালিকা সঠিক নয়', 400);
  }

  const seen = new Set();
  const clean = packages.map((pkg, index) => {
    const months = Number(pkg?.months);

    /* Blank is NOT zero.
     *
     * `Number('')` is 0, which is finite and non-negative, so a price field the
     * operator simply never filled in would sail through a `Number.isFinite`
     * check and be stored as a free package. ৳0 is a legitimate value — a
     * complimentary period is recorded that way elsewhere — so it cannot be
     * rejected outright; what has to be rejected is the ABSENCE of a value,
     * before the coercion erases the difference. */
    const rawPrice = pkg?.price;
    if (rawPrice === '' || rawPrice === null || rawPrice === undefined) {
      throw new AppError(
        `Package ${index + 1}: price must be zero or more`,
        `${index + 1} নম্বর প্যাকেজের দাম সঠিক নয়`,
        400
      );
    }
    const price = Number(rawPrice);

    if (!Number.isInteger(months) || months < 1 || months > 120) {
      throw new AppError(
        `Package ${index + 1}: months must be a whole number between 1 and 120`,
        `${index + 1} নম্বর প্যাকেজের মেয়াদ সঠিক নয়`,
        400
      );
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new AppError(
        `Package ${index + 1}: price must be zero or more`,
        `${index + 1} নম্বর প্যাকেজের দাম সঠিক নয়`,
        400
      );
    }
    if (seen.has(months)) {
      throw new AppError(
        `Two packages both offer ${months} month(s)`,
        `${months} মাসের প্যাকেজ দুইবার আছে`,
        400
      );
    }
    seen.add(months);

    return {
      months,
      price,
      label: typeof pkg?.label === 'string' ? pkg.label.trim() : '',
      badge: typeof pkg?.badge === 'string' ? pkg.badge.trim() : '',
    };
  });

  return clean.sort((a, b) => a.months - b.months);
};

const normalizeSmsTiers = (tiers) => {
  if (!Array.isArray(tiers)) {
    throw new AppError('SMS tiers must be a list', 'এসএমএস প্যাকেজ তালিকা সঠিক নয়', 400);
  }

  const seen = new Set();
  const clean = tiers.map((tier, index) => {
    const quantity = Number(tier?.quantity);
    const price = Number(tier?.price);

    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new AppError(
        `Tier ${index + 1}: quantity must be at least 1`,
        `${index + 1} নম্বর প্যাকেজের পরিমাণ সঠিক নয়`,
        400
      );
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new AppError(
        `Tier ${index + 1}: price must be zero or more`,
        `${index + 1} নম্বর প্যাকেজের দাম সঠিক নয়`,
        400
      );
    }
    if (seen.has(quantity)) {
      throw new AppError(
        `Two tiers both offer ${quantity} SMS`,
        `${quantity}টি এসএমএসের প্যাকেজ দুইবার আছে`,
        400
      );
    }
    seen.add(quantity);

    return {
      quantity,
      price,
      label: tier?.label?.trim() || `${quantity} এসএমএস`,
      badge: tier?.badge?.trim() || undefined,
    };
  });

  return clean.sort((a, b) => a.quantity - b.quantity);
};

exports.updatePlatformSettings = asyncHandler(async (req, res) => {
  const allowed = [
    'defaultTrialDays',
    'defaultMonthlyPrice',
    'defaultSmsUnitPrice',
    'platformSmsCost',
    'warningDays',
    'smsTiers',
    'supportPhone',
    'billingProvider',
    // Self-serve checkout. A key absent from this list is DROPPED SILENTLY —
    // the operator saves, gets a success toast, and the price list is unchanged
    // — so every new settings field has to be added here as well as to the
    // model and the form.
    'subscriptionPackages',
    'minSmsPurchaseAmount',
    'maxSelfServeAmount',
    // The way back to pre-creating a shop's category taxonomy at signup.
    // Defaults false; see PlatformSetting.model.js for why.
    'autoSeedCategoriesOnSignup',
  ];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }

  if (patch.smsTiers !== undefined) {
    patch.smsTiers = normalizeSmsTiers(patch.smsTiers);
  }
  if (patch.subscriptionPackages !== undefined) {
    patch.subscriptionPackages = normalizeSubscriptionPackages(patch.subscriptionPackages);
  }
  // Clearing the cost is meaningful — it is the difference between "we sell at
  // cost" and "nobody has told this system what a message costs". An empty
  // string from the form has to reach the model as null, not as 0.
  if (patch.platformSmsCost === '' || patch.platformSmsCost === null) {
    patch.platformSmsCost = null;
  }

  patch.updatedBy = req.admin?._id;

  const data = await PlatformSetting.findOneAndUpdate({ key: 'platform' }, patch, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
    runValidators: true,
  });
  return ApiResponse.success(res, {
    data,
    message: 'Platform settings updated',
    messageBn: 'প্ল্যাটফর্ম সেটিংস আপডেট হয়েছে',
  });
});

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

exports.updatePlatformSettings = asyncHandler(async (req, res) => {
  const allowed = [
    'defaultTrialDays',
    'defaultMonthlyPrice',
    'defaultSmsUnitPrice',
    'warningDays',
    'smsTiers',
    'supportPhone',
    'billingProvider',
  ];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
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

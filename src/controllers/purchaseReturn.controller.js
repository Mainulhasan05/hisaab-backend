const purchaseReturnService = require('../services/purchaseReturn.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizePurchases } = require('../utils/dataSanitizer.util');

/**
 * কেনা ফেরত endpoints.
 *
 * ── Every read goes through `sanitizePurchases`, without exception ──────────
 *
 * These rows carry `unitPrice`, `landedUnitPrice`, `total`, `totalAmount` and
 * the discount shares — the exact figures `purchases.view_cost` exists to
 * withhold, reached by a new door. The routes ask only for `purchases.view`,
 * which a stock handler holds, so a payload that skipped the strip would hand
 * them the shop's buying prices on every line.
 *
 * `sanitizeReport` is the WRONG strip here (it is what the sales-return
 * controller uses): its denylist is profit- and cost-NAMED keys, and none of
 * `totalAmount` / `total` / `unitPrice` appear in it. Purchase money keys are
 * generic words and live in their own set.
 */

// Create a purchase return
exports.createReturn = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.createReturn(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );
  return ApiResponse.created(res, {
    // The whole `{purchaseReturn, purchase, allocations}` envelope, stripped as
    // one object — `allocations[].amount` is money too, and it names which
    // older bills a credit landed on.
    data: sanitizePurchases(result, req),
    message: 'Purchase return recorded successfully',
    messageBn: 'কেনা ফেরত সফলভাবে রেকর্ড হয়েছে',
  });
});

// Settle a return that was recorded as "পরে নেবো"
exports.settleRefund = asyncHandler(async (req, res) => {
  const purchaseReturn = await purchaseReturnService.settleRefund(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizePurchases(purchaseReturn, req),
    message: 'Refund received successfully',
    messageBn: 'ফেরতের টাকা পাওয়া রেকর্ড হয়েছে',
  });
});

// List returns (paginated)
exports.getReturns = asyncHandler(async (req, res) => {
  // Branch is assigned unconditionally, OVERWRITING anything the query string
  // carried: spreading `req.query` first would let a client-supplied `branchId`
  // survive whenever the resolved scope is null, slicing the list by a branch
  // the scope never granted. Same defect the sales-return list fixed.
  const options = { ...req.query, branchId: req.branchId || null };
  const result = await purchaseReturnService.getReturns(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    data: sanitizePurchases(result.data, req),
    message: 'Purchase returns retrieved successfully',
    messageBn: 'কেনা ফেরতের তালিকা লোড হয়েছে',
  });
});

// Single return
exports.getReturn = asyncHandler(async (req, res) => {
  const purchaseReturn = await purchaseReturnService.getReturnById(
    req.shop._id,
    req.params.id,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizePurchases(purchaseReturn, req),
    message: 'Purchase return retrieved successfully',
    messageBn: 'কেনা ফেরত লোড হয়েছে',
  });
});

// Every return raised against one purchase
exports.getReturnsByPurchase = asyncHandler(async (req, res) => {
  const returns = await purchaseReturnService.getReturnsByPurchase(
    req.shop._id,
    req.params.purchaseId,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizePurchases(returns, req),
    message: 'Purchase returns retrieved successfully',
    messageBn: 'এই ক্রয়ের ফেরত তালিকা লোড হয়েছে',
  });
});

// What can still go back, and how much of it is on the shelf
exports.getReturnableItems = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.getReturnableItems(
    req.shop._id,
    req.params.purchaseId,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizePurchases(result, req),
    message: 'Returnable items retrieved successfully',
    messageBn: 'ফেরতযোগ্য আইটেম লোড হয়েছে',
  });
});

// Summary for the stat tiles and the pending banner
exports.getReturnsSummary = asyncHandler(async (req, res) => {
  // Only the date window comes from the query string. `branchId` comes from the
  // resolved scope and is NOT spread in, so a caller cannot ask for another
  // branch's totals — and the cards always count the rows `getReturns` lists.
  const summary = await purchaseReturnService.getReturnsSummary(req.shop._id, {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    branchId: req.branchId || null,
  });
  return ApiResponse.success(res, {
    data: sanitizePurchases(summary, req),
    message: 'Purchase returns summary retrieved successfully',
    messageBn: 'কেনা ফেরতের সারাংশ লোড হয়েছে',
  });
});

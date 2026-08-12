/**
 * Admin storage endpoints — thin wrappers, same shape as admin.controller.
 * All policy lives in adminStorage.service; nothing here decides anything.
 */

const adminStorageService = require('../services/adminStorage.service');
const storageService = require('../services/storage.service');
const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');

// ── Account pool ────────────────────────────────────────────────────────────

exports.listAccounts = asyncHandler(async (req, res) => {
  const accounts = await adminStorageService.listAccounts();
  return ApiResponse.success(res, {
    data: accounts,
    message: 'Storage accounts retrieved successfully',
  });
});

exports.createAccount = asyncHandler(async (req, res) => {
  const account = await adminStorageService.createAccount(req.admin._id, req.body);
  return ApiResponse.created(res, {
    data: account,
    message: 'Storage account added successfully',
  });
});

exports.updateAccount = asyncHandler(async (req, res) => {
  const account = await adminStorageService.updateAccount(req.params.id, req.admin._id, req.body);
  return ApiResponse.success(res, {
    data: account,
    message: 'Storage account updated successfully',
  });
});

exports.testAccount = asyncHandler(async (req, res) => {
  const result = await adminStorageService.testAccount(req.params.id);
  return ApiResponse.success(res, {
    data: result,
    message: result.ok ? 'Connection verified' : `Connection failed: ${result.error}`,
  });
});

/**
 * Test credentials that have not been saved yet.
 *
 * Deliberately takes the secret in the body: the whole point is to let an admin
 * check a fresh credential before it is stored. Nothing is persisted here.
 */
exports.testDraftAccount = asyncHandler(async (req, res) => {
  const { endpoint, accessKeyId, secretAccessKey, bucket } = req.body || {};
  const result = await storageService.testConnection({ endpoint, accessKeyId, secretAccessKey, bucket });
  return ApiResponse.success(res, {
    data: result,
    message: result.ok ? 'Connection verified' : `Connection failed: ${result.error}`,
  });
});

exports.setAccountDraining = asyncHandler(async (req, res) => {
  const draining = req.body?.draining === true;
  const account = await adminStorageService.setAccountDraining(req.params.id, req.admin._id, draining);
  return ApiResponse.success(res, {
    data: account,
    message: draining ? 'Account is now draining' : 'Account reactivated',
  });
});

// There is deliberately no deleteAccount handler. Retiring a bucket is
// drain → isActive:false, which keeps the account row that maps every stored
// object back to its bucket. See the note in admin.routes.js.

// ── Pool-wide ───────────────────────────────────────────────────────────────

exports.getSummary = asyncHandler(async (req, res) => {
  const summary = await adminStorageService.getSummary();
  return ApiResponse.success(res, {
    data: summary,
    message: 'Storage summary retrieved successfully',
  });
});

// ── Per-shop allocation ─────────────────────────────────────────────────────

exports.listShopStorage = asyncHandler(async (req, res) => {
  const { shops, pagination } = await adminStorageService.listShopStorage(req.query);
  return ApiResponse.paginated(res, {
    data: shops,
    pagination,
    message: 'Shop storage usage retrieved successfully',
  });
});

exports.getShopStorage = asyncHandler(async (req, res) => {
  const data = await adminStorageService.getShopStorage(req.params.id);
  return ApiResponse.success(res, {
    data,
    message: 'Shop storage retrieved successfully',
  });
});

exports.setShopStorage = asyncHandler(async (req, res) => {
  const data = await adminStorageService.setShopStorage(req.params.id, req.admin._id, {
    enabled: req.body?.enabled,
    quotaMb: req.body?.quotaMb,
  });
  return ApiResponse.success(res, {
    data,
    message: 'Shop storage updated successfully',
    messageBn: 'দোকানের স্টোরেজ সেটিংস আপডেট হয়েছে',
  });
});

exports.recalculateShopStorage = asyncHandler(async (req, res) => {
  const data = await adminStorageService.recalculateShopStorage(req.params.id);
  return ApiResponse.success(res, {
    data,
    message: 'Storage usage recalculated',
    messageBn: 'স্টোরেজ ব্যবহার পুনর্গণনা হয়েছে',
  });
});

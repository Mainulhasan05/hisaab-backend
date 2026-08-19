const paymentAccountService = require('../services/paymentAccount.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * `openingBalance` is owner-only and the check lives in the SERVICE, not here
 * and not on the route — the same shape as `Customer.openingDue`. The
 * controller's job is only to say who is asking.
 */
// `isOwner` on the user document, matching `auth.middleware.ownerOnly`. Not
// `role` — that became an ObjectId reference when RBAC landed, and comparing it
// to a role NAME is the exact bug that got `restrictTo` deleted.
const isOwner = (req) => req.user?.isOwner === true;

exports.getAccounts = asyncHandler(async (req, res) => {
  const result = await paymentAccountService.getAccounts(req.shop._id, req, {
    includeInactive: req.query.includeInactive === 'true',
  });
  ApiResponse.success(res, {
    data: result,
    message: 'Fund accounts',
    messageBn: 'অ্যাকাউন্ট তালিকা',
  });
});

exports.getAccountOptions = asyncHandler(async (req, res) => {
  const accounts = await paymentAccountService.getAccountOptions(req.shop._id, req);
  ApiResponse.success(res, {
    data: accounts,
    message: 'Account options',
    messageBn: 'অ্যাকাউন্ট তালিকা',
  });
});

exports.getAccount = asyncHandler(async (req, res) => {
  const account = await paymentAccountService.getAccount(req.shop._id, req.params.id, req);
  ApiResponse.success(res, {
    data: account,
    message: 'Fund account',
    messageBn: 'অ্যাকাউন্ট',
  });
});

exports.createAccount = asyncHandler(async (req, res) => {
  const account = await paymentAccountService.createAccount(
    req.shop._id,
    req.user._id,
    req.body,
    req,
    isOwner(req)
  );
  ApiResponse.created(res, {
    data: account,
    message: 'Account created',
    messageBn: 'অ্যাকাউন্ট তৈরি হয়েছে',
  });
});

exports.updateAccount = asyncHandler(async (req, res) => {
  const account = await paymentAccountService.updateAccount(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body,
    req,
    isOwner(req)
  );
  ApiResponse.success(res, {
    data: account,
    message: 'Account updated',
    messageBn: 'অ্যাকাউন্ট আপডেট হয়েছে',
  });
});

exports.getTransfers = asyncHandler(async (req, res) => {
  const result = await paymentAccountService.getTransfers(req.shop._id, req, {
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
    accountId: req.query.accountId,
  });
  ApiResponse.success(res, {
    data: result,
    message: 'Fund transfers',
    messageBn: 'ফান্ড ট্রান্সফার',
  });
});

exports.createTransfer = asyncHandler(async (req, res) => {
  const transfer = await paymentAccountService.createTransfer(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );
  ApiResponse.created(res, {
    data: transfer,
    message: 'Transfer recorded',
    messageBn: 'ট্রান্সফার রেকর্ড হয়েছে',
  });
});

exports.getEntries = asyncHandler(async (req, res) => {
  const result = await paymentAccountService.getEntries(req.shop._id, req, {
    page: parseInt(req.query.page, 10) || 1,
    limit: parseInt(req.query.limit, 10) || 20,
    accountId: req.query.accountId,
  });
  ApiResponse.success(res, {
    data: result,
    message: 'Account entries',
    messageBn: 'অ্যাকাউন্ট এন্ট্রি',
  });
});

exports.createEntry = asyncHandler(async (req, res) => {
  const entry = await paymentAccountService.createEntry(
    req.shop._id,
    req.user._id,
    req.body,
    req,
    isOwner(req)
  );
  ApiResponse.created(res, {
    data: entry,
    message: 'Entry recorded',
    messageBn: 'এন্ট্রি রেকর্ড হয়েছে',
  });
});

exports.getReconciliations = asyncHandler(async (req, res) => {
  const rows = await paymentAccountService.getReconciliations(req.shop._id, req, {
    accountId: req.query.accountId,
    limit: parseInt(req.query.limit, 10) || 20,
  });
  ApiResponse.success(res, {
    data: rows,
    message: 'Reconciliations',
    messageBn: 'মিলকরণের হিসাব',
  });
});

exports.reconcileAccount = asyncHandler(async (req, res) => {
  const row = await paymentAccountService.reconcileAccount(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );
  ApiResponse.created(res, {
    data: row,
    message: 'Reconciliation recorded',
    messageBn: 'মিলকরণ রেকর্ড হয়েছে',
  });
});

exports.getMoneyPosition = asyncHandler(async (req, res) => {
  const result = await paymentAccountService.getMoneyPosition(req.shop._id, req, {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });
  ApiResponse.success(res, {
    data: result,
    message: 'Money position',
    messageBn: 'আমার টাকা কোথায়',
  });
});

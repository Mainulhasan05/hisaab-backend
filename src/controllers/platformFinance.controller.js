/**
 * Platform finance — admin endpoints. Thin, like billing.controller: every rule
 * (amount is not editable, void needs a reason, no future-dated bills) lives in
 * the service.
 */

const financeService = require('../services/platformFinance.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

const actorOf = (req) => ({ kind: 'admin', id: req.admin?._id, name: req.admin?.name });

exports.getOverview = asyncHandler(async (req, res) => {
  const data = await financeService.getOverview({ from: req.query.from, to: req.query.to });
  return ApiResponse.success(res, {
    data,
    message: 'Finance overview retrieved',
    messageBn: 'আয়-ব্যয়ের হিসাব লোড হয়েছে',
  });
});

exports.getAdvances = asyncHandler(async (req, res) => {
  const data = await financeService.getAdvances();
  return ApiResponse.success(res, {
    data,
    message: 'Advances retrieved',
    messageBn: 'অগ্রিম পেমেন্টের হিসাব লোড হয়েছে',
  });
});

exports.listExpenses = asyncHandler(async (req, res) => {
  const result = await financeService.listExpenses(req.query);
  return ApiResponse.success(res, {
    data: result,
    message: 'Expenses retrieved',
    messageBn: 'খরচের তালিকা লোড হয়েছে',
  });
});

exports.createExpense = asyncHandler(async (req, res) => {
  const data = await financeService.createExpense(actorOf(req), req.body);
  return ApiResponse.created(res, {
    data,
    message: 'Expense recorded',
    messageBn: 'খরচ যোগ হয়েছে',
  });
});

exports.amendExpense = asyncHandler(async (req, res) => {
  const data = await financeService.amendExpense(actorOf(req), req.params.id, req.body);
  return ApiResponse.success(res, {
    data,
    message: 'Expense corrected',
    messageBn: 'খরচ সংশোধন হয়েছে',
  });
});

exports.voidExpense = asyncHandler(async (req, res) => {
  const data = await financeService.voidExpense(actorOf(req), req.params.id, req.body?.reason);
  return ApiResponse.success(res, {
    data,
    message: 'Expense voided',
    messageBn: 'খরচ বাতিল হয়েছে',
  });
});

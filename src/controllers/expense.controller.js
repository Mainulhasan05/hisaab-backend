const expenseService = require('../services/expense.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all expenses
exports.getExpenses = asyncHandler(async (req, res) => {
  const result = await expenseService.getExpenses(req.shop._id, req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Expenses retrieved successfully',
    messageBn: 'খরচের তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Create expense
exports.createExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.createExpense(req.shop._id, req.user._id, req.body);
  return ApiResponse.created(res, {
    data: expense,
    message: 'Expense added successfully',
    messageBn: 'খরচ সফলভাবে যোগ হয়েছে',
  });
});

// Update expense
exports.updateExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.updateExpense(req.shop._id, req.user._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: expense,
    message: 'Expense updated successfully',
    messageBn: 'খরচ সফলভাবে আপডেট হয়েছে',
  });
});

// Delete expense
exports.deleteExpense = asyncHandler(async (req, res) => {
  await expenseService.deleteExpense(req.shop._id, req.user._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Expense deleted successfully',
    messageBn: 'খরচ সফলভাবে মুছে ফেলা হয়েছে',
  });
});

// Get expense summary
exports.getSummary = asyncHandler(async (req, res) => {
  const summary = await expenseService.getSummary(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Expense summary retrieved',
    messageBn: 'খরচের সারাংশ লোড হয়েছে',
  });
});

// Get expense categories
exports.getCategories = asyncHandler(async (req, res) => {
  const categories = await expenseService.getCategories(req.shop._id);
  return ApiResponse.success(res, {
    data: categories,
    message: 'Expense categories retrieved',
    messageBn: 'খরচের ক্যাটাগরি লোড হয়েছে',
  });
});

// Create custom expense category
exports.createCategory = asyncHandler(async (req, res) => {
  const category = await expenseService.createCategory(req.shop._id, req.body);
  return ApiResponse.created(res, {
    data: category,
    message: 'Category created successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে তৈরি হয়েছে',
  });
});

// Delete custom expense category
exports.deleteCategory = asyncHandler(async (req, res) => {
  await expenseService.deleteCategory(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Category deleted successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে মুছে ফেলা হয়েছে',
  });
});

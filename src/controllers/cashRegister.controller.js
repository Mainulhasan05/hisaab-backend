const cashRegisterService = require('../services/cashRegister.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

exports.getToday = asyncHandler(async (req, res) => {
  const result = await cashRegisterService.getTodayRegister(req.shop._id, req.user._id);
  ApiResponse.success(res, {
    data: result,
    message: 'Today\'s cash register',
    messageBn: 'আজকের ক্যাশ রেজিস্টার',
  });
});

exports.openDay = asyncHandler(async (req, res) => {
  const { openingBalance } = req.body;
  const register = await cashRegisterService.openRegister(
    req.shop._id,
    req.user._id,
    parseFloat(openingBalance) || 0
  );
  ApiResponse.created(res, {
    data: register,
    message: 'Cash register opened',
    messageBn: 'ক্যাশ রেজিস্টার খোলা হয়েছে',
  });
});

exports.updateDay = asyncHandler(async (req, res) => {
  const register = await cashRegisterService.updateRegister(
    req.shop._id,
    req.user._id,
    req.body
  );
  ApiResponse.success(res, {
    data: register,
    message: 'Cash register updated',
    messageBn: 'ক্যাশ রেজিস্টার আপডেট হয়েছে',
  });
});

exports.closeDay = asyncHandler(async (req, res) => {
  const { actualClosing, notes } = req.body;
  if (actualClosing == null) {
    return ApiResponse.badRequest(res, {
      message: 'Actual closing amount is required',
      messageBn: 'প্রকৃত ক্যাশ পরিমাণ দিন',
    });
  }
  const register = await cashRegisterService.closeRegister(
    req.shop._id,
    req.user._id,
    parseFloat(actualClosing),
    notes
  );
  ApiResponse.success(res, {
    data: register,
    message: 'Cash register closed',
    messageBn: 'ক্যাশ রেজিস্টার বন্ধ হয়েছে',
  });
});

exports.getHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, startDate, endDate } = req.query;
  const result = await cashRegisterService.getHistory(req.shop._id, {
    page,
    limit,
    startDate,
    endDate,
  });
  ApiResponse.paginated(res, {
    data: result.data,
    page,
    limit,
    total: result.pagination.total,
    message: 'Cash register history',
    messageBn: 'ক্যাশ রেজিস্টার ইতিহাস',
  });
});

exports.reopenDay = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const register = await cashRegisterService.reopenRegister(
    req.shop._id,
    req.user._id,
    reason
  );
  ApiResponse.success(res, {
    data: register,
    message: 'Cash register reopened',
    messageBn: 'ক্যাশ রেজিস্টার পুনরায় খোলা হয়েছে',
  });
});

exports.closePreviousDay = asyncHandler(async (req, res) => {
  const { actualClosing, notes } = req.body;
  const { id } = req.params;

  if (actualClosing == null) {
    return ApiResponse.badRequest(res, {
      message: 'Actual closing amount is required',
      messageBn: 'প্রকৃত ক্যাশ পরিমাণ দিন',
    });
  }

  const register = await cashRegisterService.closePreviousRegister(
    req.shop._id,
    req.user._id,
    id,
    parseFloat(actualClosing),
    notes
  );
  ApiResponse.success(res, {
    data: register,
    message: 'Previous day register closed',
    messageBn: 'আগের দিনের রেজিস্টার বন্ধ হয়েছে',
  });
});

const smsService = require('../services/sms.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { validateSms, countSms } = require('../utils/smsCounter.util');

// Get SMS quota
exports.getQuota = asyncHandler(async (req, res) => {
  const quota = await smsService.getQuota(req.shop._id);
  return ApiResponse.success(res, {
    data: quota,
    message: 'SMS quota retrieved successfully',
    messageBn: 'এসএমএস কোটা সফলভাবে লোড হয়েছে',
  });
});

// Send SMS (single, bulk, or dynamic)
exports.sendSMS = asyncHandler(async (req, res) => {
  const { type, message } = req.body;

  // Server-side SMS segment validation (never trust frontend)
  if (message) {
    const validation = validateSms(message, 10);
    if (!validation.valid) {
      return ApiResponse.badRequest(res, {
        message: `Message exceeds segment limit: ${validation.info.segments} segments`,
        messageBn: validation.reason,
      });
    }
  }

  let result;

  switch (type) {
    case 'single':
      result = await smsService.sendSingleSMS(req.shop._id, req.user._id, req.body, req);
      break;
    case 'bulk':
      result = await smsService.sendBulkSMS(req.shop._id, req.user._id, req.body, req);
      break;
    case 'dynamic':
      result = await smsService.sendDynamicSMS(req.shop._id, req.user._id, req.body.recipients, req);
      break;
    default:
      return ApiResponse.badRequest(res, {
        message: 'Invalid SMS type',
        messageBn: 'অবৈধ এসএমএস টাইপ',
      });
  }

  return ApiResponse.success(res, {
    data: result,
    message: 'SMS sent successfully',
    messageBn: 'এসএমএস সফলভাবে পাঠানো হয়েছে',
  });
});

// Send due reminder
exports.sendDueReminder = asyncHandler(async (req, res) => {
  const { customerIds } = req.body;

  if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'Customer IDs required',
      messageBn: 'কাস্টমার নির্বাচন করুন',
    });
  }

  const result = await smsService.sendDueReminder(req.shop._id, req.user._id, customerIds, req);
  return ApiResponse.success(res, {
    data: result,
    message: 'Due reminders sent successfully',
    messageBn: 'বাকির রিমাইন্ডার সফলভাবে পাঠানো হয়েছে',
  });
});

// Get SMS history
exports.getHistory = asyncHandler(async (req, res) => {
  const result = await smsService.getSMSHistory(req.shop._id, req.query, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'SMS history retrieved successfully',
    messageBn: 'এসএমএস ইতিহাস সফলভাবে লোড হয়েছে',
  });
});

// Get SMS templates
exports.getTemplates = asyncHandler(async (req, res) => {
  const templates = smsService.getTemplates();
  return ApiResponse.success(res, {
    data: templates,
    message: 'SMS templates retrieved successfully',
    messageBn: 'এসএমএস টেমপ্লেট সফলভাবে লোড হয়েছে',
  });
});

const smsService = require('../services/sms.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { validateSms, countSms } = require('../utils/smsCounter.util');
const { appendShopSignature } = require('../utils/smsTemplates.util');

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

  // Server-side SMS segment validation (never trust frontend).
  //
  // Validated WITH the shop's sign-off attached, because that is the message
  // the shop will be billed for. Checking the draft and sending the signed
  // version is how a message that passed at ten segments goes out at eleven.
  if (message) {
    const validation = validateSms(appendShopSignature(message, req.shop?.name), 10);
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

/**
 * How many customers each audience holds — and how many are actually reachable.
 *
 * The composer calls this instead of downloading the customer book to count it
 * locally. It is also the only place the two figures can honestly differ: a
 * shop with 820 customers of whom 40 have no usable number reaches 780, and a
 * cost quoted against 820 is wrong before the send even starts.
 */
exports.getAudienceCounts = asyncHandler(async (req, res) => {
  const counts = await smsService.getAudienceCounts(req.shop._id, req);

  return ApiResponse.success(res, {
    data: {
      ...counts,
      // The composer needs this to render the sign-off it cannot let the
      // shopkeeper delete, and to price the message including it.
      shopName: req.shop?.name || '',
    },
    message: 'Audience counts retrieved successfully',
    messageBn: 'প্রাপকের সংখ্যা সফলভাবে লোড হয়েছে',
  });
});

/**
 * Launch a bulk campaign from an audience name and a template.
 *
 * The client posts `{ message, audience, customerIds }` — never a list of phone
 * numbers. See `smsService.resolveAudience` for why that matters under separate
 * books, and what a client-chosen recipient list would let a caller do.
 */
exports.sendCampaign = asyncHandler(async (req, res) => {
  const { message, audience = 'all', customerIds = [] } = req.body;

  if (!message || !message.trim()) {
    return ApiResponse.badRequest(res, {
      message: 'Message is required',
      messageBn: 'মেসেজ লিখুন',
    });
  }

  const allowed = ['all', 'due', 'selected'];
  if (!allowed.includes(audience)) {
    return ApiResponse.badRequest(res, {
      message: `Invalid audience. Expected one of: ${allowed.join(', ')}`,
      messageBn: 'অবৈধ প্রাপক নির্বাচন',
    });
  }

  if (audience === 'selected' && (!Array.isArray(customerIds) || customerIds.length === 0)) {
    return ApiResponse.badRequest(res, {
      message: 'Select at least one customer',
      messageBn: 'কমপক্ষে একজন কাস্টমার সিলেক্ট করুন',
    });
  }

  // Segments are checked against the SIGNED body — the one that gets billed.
  // The per-recipient bodies are checked again inside the service, where the
  // longest customer name is known.
  const validation = validateSms(appendShopSignature(message, req.shop?.name), 10);
  if (!validation.valid) {
    return ApiResponse.badRequest(res, {
      message: `Message exceeds segment limit: ${validation.info.segments} segments`,
      messageBn: validation.reason,
    });
  }

  const result = await smsService.createCampaign(
    req.shop._id,
    req.user._id,
    { message, audience, customerIds },
    req
  );

  if (result.reason === 'no_valid_recipients') {
    return ApiResponse.badRequest(res, {
      data: result,
      message: 'No recipient has a usable phone number',
      messageBn: 'ব্যবহারযোগ্য মোবাইল নম্বরসহ কোনো প্রাপক পাওয়া যায়নি',
    });
  }

  return ApiResponse.success(res, {
    data: result,
    // A queued campaign has not sent anything yet, and saying it has is how a
    // shopkeeper closes the tab on a send that then dies at batch three.
    message: result.queued ? 'Campaign started' : 'Campaign completed',
    messageBn: result.queued ? 'ক্যাম্পেইন শুরু হয়েছে' : 'ক্যাম্পেইন সম্পন্ন হয়েছে',
  });
});

/** Progress of a running campaign, for the dashboard to poll. */
exports.getCampaign = asyncHandler(async (req, res) => {
  const campaign = await smsService.getCampaign(req.shop._id, req.params.id);

  if (!campaign) {
    return ApiResponse.badRequest(res, {
      message: 'Campaign not found',
      messageBn: 'ক্যাম্পেইন পাওয়া যায়নি',
    });
  }

  return ApiResponse.success(res, {
    data: campaign,
    message: 'Campaign status retrieved successfully',
    messageBn: 'ক্যাম্পেইনের অবস্থা লোড হয়েছে',
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
  const shopId = req.shopId || req.user?.shop;
  const templates = await smsService.getTemplates(shopId);
  return ApiResponse.success(res, {
    data: templates,
    message: 'SMS templates retrieved successfully',
    messageBn: 'এসএমএস টেমপ্লেট সফলভাবে লোড হয়েছে',
  });
});

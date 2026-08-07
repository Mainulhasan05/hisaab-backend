const GeminiKey = require('../models/GeminiKey.model');
const geminiService = require('../services/gemini.service');
const ApiResponse = require('../utils/response.util');
const { asyncHandler } = require('../middleware/error.middleware');
const { refuseDeletion } = require('../utils/deletionDisabled.util');

/**
 * Admin: Get all Gemini API keys with usage stats
 */
exports.getAllKeys = asyncHandler(async (req, res) => {
  await geminiService.checkAndResetDailyCounters();

  const keys = await GeminiKey.find().sort({ createdAt: -1 });

  const formattedKeys = keys.map((key) => ({
    _id: key._id,
    name: key.name,
    maskedKey: key.getMaskedKey(),
    dailyLimit: key.dailyLimit,
    requestsToday: key.requestsToday,
    remainingToday: Math.max(0, key.dailyLimit - key.requestsToday),
    totalRequests: key.totalRequests,
    lastUsedAt: key.lastUsedAt,
    lastResetDate: key.lastResetDate,
    isActive: key.isActive,
    status: key.status,
    lastErrorMessage: key.lastErrorMessage,
    createdAt: key.createdAt
  }));

  // Pool summary metrics
  const totalKeys = keys.length;
  const activeKeys = keys.filter((k) => k.isActive && k.status === 'active').length;
  const totalDailyLimit = keys.reduce((sum, k) => (k.isActive ? sum + k.dailyLimit : sum), 0);
  const totalRequestsToday = keys.reduce((sum, k) => sum + k.requestsToday, 0);

  return ApiResponse.success(res, {
    data: {
      keys: formattedKeys,
      summary: {
        totalKeys,
        activeKeys,
        totalDailyLimit,
        totalRequestsToday,
        remainingLimitToday: Math.max(0, totalDailyLimit - totalRequestsToday)
      }
    },
    message: 'Gemini AI keys retrieved successfully'
  });
});

/**
 * Admin: Add new Gemini API key
 */
exports.createKey = asyncHandler(async (req, res) => {
  const { name, apiKey, dailyLimit } = req.body;

  if (!name || !apiKey) {
    return ApiResponse.badRequest(res, 'অ্যাকাউন্টের নাম এবং API Key বাধ্যতামূলক');
  }

  // Live validation test against Google API
  const testResult = await geminiService.testApiKey(apiKey.trim());
  if (!testResult.valid) {
    return ApiResponse.badRequest(
      res,
      `API Key যাচাই ব্যর্থ হয়েছে: ${testResult.error}`
    );
  }

  const existing = await GeminiKey.findOne({ apiKey: apiKey.trim() });
  if (existing) {
    return ApiResponse.conflict(res, 'এই API Key টি ইতোমধ্যে যুক্ত করা আছে');
  }

  const newKey = await GeminiKey.create({
    name: name.trim(),
    apiKey: apiKey.trim(),
    dailyLimit: parseInt(dailyLimit) || 1500,
    status: 'active',
    isActive: true
  });

  return ApiResponse.created(res, {
    data: {
      _id: newKey._id,
      name: newKey.name,
      maskedKey: newKey.getMaskedKey(),
      dailyLimit: newKey.dailyLimit,
      status: newKey.status
    },
    message: 'Gemini API Key সফলভাবে যুক্ত ও যাচাই করা হয়েছে'
  });
});

/**
 * Admin: Update Gemini API key settings
 */
exports.updateKey = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, dailyLimit, isActive, status, apiKey } = req.body;

  const keyDoc = await GeminiKey.findById(id);
  if (!keyDoc) {
    return ApiResponse.notFound(res, 'Gemini Key পাওয়া যায়নি');
  }

  if (apiKey && apiKey.trim() !== keyDoc.apiKey) {
    const testResult = await geminiService.testApiKey(apiKey.trim());
    if (!testResult.valid) {
      return ApiResponse.badRequest(res, `নতুন API Key অবৈধ: ${testResult.error}`);
    }
    keyDoc.apiKey = apiKey.trim();
  }

  if (name !== undefined) keyDoc.name = name;
  if (dailyLimit !== undefined) keyDoc.dailyLimit = parseInt(dailyLimit) || 1500;
  if (isActive !== undefined) keyDoc.isActive = isActive;
  if (status !== undefined) keyDoc.status = status;

  await keyDoc.save();

  return ApiResponse.success(res, {
    data: {
      _id: keyDoc._id,
      name: keyDoc.name,
      maskedKey: keyDoc.getMaskedKey(),
      dailyLimit: keyDoc.dailyLimit,
      status: keyDoc.status,
      isActive: keyDoc.isActive
    },
    message: 'Gemini Key আপডেট করা হয়েছে'
  });
});

/**
 * Admin: Delete Gemini Key — DISABLED.
 * Route is not mounted; this fails closed if it ever is.
 */
exports.deleteKey = asyncHandler(async () => {
  refuseDeletion(
    'a Gemini key',
    'Retire it instead: PUT /api/admin/gemini-keys/:id with { isActive: false }.'
  );
});

/**
 * Admin: Test existing saved key or raw key
 */
exports.testKey = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let targetKey = req.body.apiKey;

  if (id && id !== 'live') {
    const keyDoc = await GeminiKey.findById(id);
    if (!keyDoc) {
      return ApiResponse.notFound(res, 'Gemini Key পাওয়া যায়নি');
    }
    targetKey = keyDoc.apiKey;
  }

  const result = await geminiService.testApiKey(targetKey);
  if (!result.valid) {
    if (id && id !== 'live') {
      await GeminiKey.findByIdAndUpdate(id, { status: 'invalid', lastErrorMessage: result.error });
    }
    return ApiResponse.badRequest(res, `যাচাই ব্যর্থ: ${result.error}`);
  }

  if (id && id !== 'live') {
    await GeminiKey.findByIdAndUpdate(id, { status: 'active', lastErrorMessage: null });
  }

  return ApiResponse.success(res, {
    data: result,
    message: 'Gemini Key সফলভাবে কাজ করছে!'
  });
});

/**
 * Admin: Reset daily usage count manually
 */
exports.resetUsage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const keyDoc = await GeminiKey.findById(id);
  if (!keyDoc) {
    return ApiResponse.notFound(res, 'Gemini Key পাওয়া যায়নি');
  }

  keyDoc.requestsToday = 0;
  keyDoc.status = 'active';
  keyDoc.lastErrorMessage = null;
  keyDoc.lastResetDate = new Date().toISOString().split('T')[0];
  await keyDoc.save();

  return ApiResponse.success(res, {
    message: 'আজকের ব্যবহারের হিসাব রিসেট করা হয়েছে'
  });
});

/**
 * Admin: Test Prompt with Gemini Pool
 */
exports.testPrompt = asyncHandler(async (req, res) => {
  const { prompt = 'Say hello in Bengali' } = req.body;
  const resultText = await geminiService.generateContent(prompt);
  return ApiResponse.success(res, {
    data: { response: resultText },
    message: 'AI প্রম্পট সফলভাবে রান হয়েছে'
  });
});

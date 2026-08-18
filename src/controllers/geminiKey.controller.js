const GeminiKey = require('../models/GeminiKey.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const geminiService = require('../services/gemini.service');
const { GEMINI_MODEL_PREFERENCES } = require('../config/constants');
const ApiResponse = require('../utils/response.util');
const { asyncHandler } = require('../middleware/error.middleware');
const { refuseDeletion } = require('../utils/deletionDisabled.util');

/**
 * Admin: Get all Gemini API keys with usage stats
 */
exports.getAllKeys = asyncHandler(async (req, res) => {
  await geminiService.checkAndResetDailyCounters();

  const keys = await GeminiKey.find().sort({ createdAt: -1 });

  const settings = await PlatformSetting.current().catch(() => null);
  const preferredModel = settings?.geminiModel || null;

  const formattedKeys = keys.map((key) => {
    const models = key.availableModels || [];

    // What THIS key would serve the next request with, computed the same way
    // `gemini.service.resolveModel` computes it. Shown per key because two
    // accounts on different tiers do not expose the same models, and "which
    // model is this account actually on" is the first question after a
    // model-retirement outage.
    const activeModel =
      (preferredModel && models.includes(preferredModel) && preferredModel) ||
      GEMINI_MODEL_PREFERENCES.find((m) => models.includes(m)) ||
      models.find((m) => m.includes('flash')) ||
      models[0] ||
      null;

    return {
      _id: key._id,
      name: key.name,
      maskedKey: key.getMaskedKey(),

      // ── MEASURED ────────────────────────────────────────────────────────
      // Counted by us, at reservation time. This is real.
      requestsToday: key.requestsToday,
      totalRequests: key.totalRequests,
      lastUsedAt: key.lastUsedAt,
      lastResetDate: key.lastResetDate,

      // ── POLICY ──────────────────────────────────────────────────────────
      // Typed by an operator, enforced by us. NOT a reading of Google's
      // remaining free-tier quota — there is no API that reports that, and the
      // panel must not let these two be read as the same kind of number.
      dailyLimit: key.dailyLimit,
      remainingToday: Math.max(0, key.dailyLimit - key.requestsToday),
      limitIsOurs: true,

      // ── DISCOVERED ──────────────────────────────────────────────────────
      // Straight from Google's ListModels for this key.
      activeModel,
      availableModels: models,
      modelsCheckedAt: key.modelsCheckedAt,
      modelCount: models.length,

      isActive: key.isActive,
      status: key.status,
      lastErrorMessage: key.lastErrorMessage,
      createdAt: key.createdAt
    };
  });

  // Pool summary metrics
  const totalKeys = keys.length;
  const activeKeys = keys.filter((k) => k.isActive && k.status === 'active').length;
  const totalDailyLimit = keys.reduce((sum, k) => (k.isActive ? sum + k.dailyLimit : sum), 0);
  const totalRequestsToday = keys.reduce((sum, k) => sum + k.requestsToday, 0);
  // A key that is active but has no discovered model cannot serve anything, and
  // will look healthy on the panel until someone tries to use it. Surfaced so
  // that state is visible before a shopkeeper finds it.
  const keysWithoutModels = keys.filter(
    (k) => k.isActive && k.status === 'active' && (k.availableModels || []).length === 0
  ).length;

  return ApiResponse.success(res, {
    data: {
      keys: formattedKeys,
      summary: {
        totalKeys,
        activeKeys,
        totalDailyLimit,
        totalRequestsToday,
        remainingLimitToday: Math.max(0, totalDailyLimit - totalRequestsToday),
        keysWithoutModels,
        preferredModel
      }
    },
    message: 'Gemini AI keys retrieved successfully'
  });
});

/**
 * Admin: refresh the model list for every key, from Google.
 *
 * The button to press after a model retirement, or after enabling a new API on
 * the Google project. `generateContent` already self-heals per key when it
 * meets a 404, but that repairs one key at the moment a shopkeeper hits it —
 * this lets an operator fix the whole pool before anyone does.
 */
exports.refreshModels = asyncHandler(async (req, res) => {
  const keys = await GeminiKey.find({ isActive: true });

  const results = [];
  for (const key of keys) {
    const result = await geminiService.listModels(key.apiKey);
    if (result.ok) {
      key.availableModels = result.models;
      key.modelsCheckedAt = new Date();
      // A key that answers ListModels is reachable. If it was parked as
      // `invalid` by a model retirement under the old code, this is what brings
      // it back rather than leaving the operator to guess which are really bad.
      if (key.status === 'invalid') {
        key.status = 'active';
        key.lastErrorMessage = null;
      }
      await key.save();
    }
    results.push({
      _id: key._id,
      name: key.name,
      ok: result.ok,
      modelCount: result.models.length,
      error: result.ok ? null : result.error
    });
  }

  return ApiResponse.success(res, {
    data: { results },
    message: `${results.filter((r) => r.ok).length}টি অ্যাকাউন্টের মডেল তালিকা হালনাগাদ হয়েছে`
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
    dailyLimit: parseInt(dailyLimit) || 200,
    status: 'active',
    isActive: true,
    // Stored at creation so the first real request does not have to spend a
    // round trip discovering them — and so the panel can show, immediately,
    // which models this account can actually serve.
    availableModels: testResult.models || [],
    modelsCheckedAt: new Date()
  });

  return ApiResponse.created(res, {
    data: {
      _id: newKey._id,
      name: newKey.name,
      maskedKey: newKey.getMaskedKey(),
      dailyLimit: newKey.dailyLimit,
      status: newKey.status,
      availableModels: newKey.availableModels,
      recommendedModel: testResult.recommendedModel || null
    },
    message: `Gemini API Key যুক্ত হয়েছে — ${testResult.modelsCount}টি মডেল পাওয়া গেছে`
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
  if (dailyLimit !== undefined) keyDoc.dailyLimit = parseInt(dailyLimit) || 200;
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
    // Persist what the test just discovered. Testing a key is the natural
    // moment to refresh its model list, and doing it here means an operator who
    // presses "Test" after a model retirement has already fixed that key.
    await GeminiKey.findByIdAndUpdate(id, {
      status: 'active',
      lastErrorMessage: null,
      availableModels: result.models || [],
      modelsCheckedAt: new Date()
    });
  }

  return ApiResponse.success(res, {
    data: result,
    message: `কাজ করছে — ${result.modelsCount}টি মডেল, প্রস্তাবিত: ${result.recommendedModel}`
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

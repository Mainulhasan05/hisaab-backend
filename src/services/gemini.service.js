const axios = require('axios');
const GeminiKey = require('../models/GeminiKey.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const { AppError } = require('../middleware/error.middleware');
const {
  GEMINI_DEFAULT_MODEL,
  GEMINI_MODEL_PREFERENCES,
  GEMINI_GENERATE_METHOD,
} = require('../config/constants');
const logger = require('../utils/logger.util');

class GeminiService {
  /**
   * Ask Google which models this key can actually use for text generation.
   *
   * ── WHY THIS IS THE BACKBONE AND NOT A DIAGNOSTIC ──────────────────────────
   *
   * The whole feature went down with "models/gemini-1.5-flash is not found for
   * API version v1beta" because a model name was hardcoded and Google retired
   * it. The fix is not a newer hardcoded name — that is the same outage with a
   * later date. It is to ask.
   *
   * Filtered on `supportedGenerationMethods` containing `generateContent`:
   * ListModels also returns embedding and image models, and picking one of
   * those produces exactly the same 404 the retirement did.
   *
   * @returns {Promise<{ok: boolean, models: string[], error?: string}>}
   */
  async listModels(apiKey) {
    if (!apiKey) return { ok: false, models: [], error: 'API key is required' };
    try {
      const response = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
        { timeout: 8000 }
      );

      const models = (response.data?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes(GEMINI_GENERATE_METHOD))
        // Google returns "models/gemini-2.0-flash"; the generateContent URL
        // wants the bare name. Normalising here means one representation exists
        // in the rest of the system.
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);

      return { ok: true, models };
    } catch (error) {
      const msg =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Could not list models';
      return { ok: false, models: [], error: msg };
    }
  }

  /**
   * Pick the best model this key can actually reach.
   *
   * Preference order from `GEMINI_MODEL_PREFERENCES`, intersected with what the
   * key reports. If none of the preferred names is available — a new key tier,
   * or Google renaming the whole line — it falls back to any flash model the key
   * has, and then to any generateContent model at all. That fallback is what
   * stops a rename from being an outage.
   *
   * The result is cached on the key document (`availableModels` / `activeModel`)
   * so the happy path is zero extra HTTP calls: ListModels runs when a key is
   * created, when it is tested, and when a model turns out to be gone.
   *
   * @param {Object} keyDoc a GeminiKey document
   * @param {string} [preferred] PlatformSetting.geminiModel, if the operator set one
   * @param {boolean} [refresh] force a live ListModels call
   */
  async resolveModel(keyDoc, preferred = null, refresh = false) {
    let available = Array.isArray(keyDoc.availableModels) ? keyDoc.availableModels : [];

    if (refresh || available.length === 0) {
      const result = await this.listModels(keyDoc.apiKey);
      if (result.ok && result.models.length) {
        available = result.models;
        await GeminiKey.updateOne(
          { _id: keyDoc._id },
          { $set: { availableModels: available, modelsCheckedAt: new Date() } }
        ).catch(() => { /* a cache write must not fail the request */ });
      }
    }

    // An operator's explicit choice wins — but only if the key can serve it.
    // Honouring an unreachable name would reproduce the original bug with the
    // operator's fingerprints on it instead of ours.
    if (preferred && available.includes(preferred)) return preferred;

    const byPreference = GEMINI_MODEL_PREFERENCES.find((m) => available.includes(m));
    if (byPreference) return byPreference;

    const anyFlash = available.find((m) => m.includes('flash'));
    if (anyFlash) return anyFlash;

    // Last resorts, in order: anything the key reported, then the compiled-in
    // default so an unreachable ListModels still produces a request to try.
    return available[0] || GEMINI_DEFAULT_MODEL;
  }

  /**
   * Test a Gemini API key with a live Google API call.
   *
   * Returns the usable model list too, not just a count — the admin panel shows
   * which models a key can actually reach, and `createKey` stores it so the
   * first real request does not have to discover it.
   */
  async testApiKey(apiKey) {
    if (!apiKey) return { valid: false, error: 'API key is required' };

    const result = await this.listModels(apiKey);
    if (!result.ok) {
      return { valid: false, error: result.error };
    }
    if (!result.models.length) {
      return {
        valid: false,
        error: 'The key works but exposes no text-generation model',
      };
    }

    return {
      valid: true,
      modelsCount: result.models.length,
      models: result.models,
      recommendedModel:
        GEMINI_MODEL_PREFERENCES.find((m) => result.models.includes(m)) ||
        result.models.find((m) => m.includes('flash')) ||
        result.models[0],
    };
  }

  /**
   * Reset daily request counters for all keys if midnight (00:00 UTC) date changed
   */
  async checkAndResetDailyCounters() {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      // Cheap in-process guard: the reset is only meaningful once per day, so
      // don't hit the DB for it on every AI request
      if (this._lastCounterResetDay === todayStr) return;

      const result = await GeminiKey.updateMany(
        { lastResetDate: { $ne: todayStr } },
        [
          {
            $set: {
              requestsToday: 0,
              lastResetDate: todayStr,
              status: { $cond: [{ $eq: ['$status', 'quota_exceeded'] }, 'active', '$status'] },
              lastErrorMessage: { $cond: [{ $eq: ['$status', 'quota_exceeded'] }, null, '$lastErrorMessage'] },
            },
          },
        ]
      );
      this._lastCounterResetDay = todayStr;
      if (result.modifiedCount > 0) {
        logger.info(`Reset daily Gemini usage counters for ${result.modifiedCount} keys.`);
      }
    } catch (error) {
      logger.warn('Failed to reset daily Gemini key counters:', error.message);
    }
  }

  /**
   * Take one slot on an available key, atomically.
   *
   * ── WHY RESERVE-THEN-USE, AND NOT SELECT-THEN-INCREMENT ────────────────────
   *
   * This used to be `find().sort()` in the service followed by
   * `incrementUsage()` after the HTTP call came back. Between those two steps
   * every concurrent request saw the same lowest count and picked the same key:
   * the sort order was stale on every request after the first, and a key could
   * be pushed past its own `dailyLimit` by however many calls were in flight.
   * Invisible while the only caller was the admin playground; not invisible
   * once shops are on it.
   *
   * The guard is now `$expr` inside the filter, so "is this key under its
   * limit" is evaluated BY THE DATABASE under the document lock, in the same
   * update that takes the slot. Same shape as `SMSQuota.reserve` — a `null`
   * return means "could not afford it", and there is no partial reservation.
   *
   * It also stops loading every key document (each carrying a live API secret)
   * into the process on every request.
   *
   * ── THE SORT IS THE ALGORITHM ──────────────────────────────────────────────
   *
   *   least_used  — fewest requests today wins. Identical to round-robin while
   *                 every account has the same limit, and still correct once
   *                 one of them is upgraded.
   *   round_robin — least recently used wins. Strict rotation, and it needs no
   *                 cursor document (unlike `storageRoundRobinCursor`), because
   *                 `lastUsedAt` already records the rotation position.
   *
   * @param {string} strategy 'least_used' | 'round_robin'
   * @returns {Promise<Object|null>} the reserved key document, or null if the
   *                                 whole pool is exhausted
   */
  async reserveKey(strategy = 'least_used') {
    await this.checkAndResetDailyCounters();

    const sort = strategy === 'round_robin'
      ? { lastUsedAt: 1, _id: 1 }
      : { requestsToday: 1, lastUsedAt: 1 };

    return GeminiKey.findOneAndUpdate(
      {
        isActive: true,
        status: 'active',
        $expr: { $lt: ['$requestsToday', '$dailyLimit'] }
      },
      {
        $inc: { requestsToday: 1, totalRequests: 1 },
        $set: { lastUsedAt: new Date() }
      },
      { sort, new: true }
    );
  }

  /**
   * Hand a reserved slot back.
   *
   * A DNS blip or a socket timeout must not spend pool quota — the request
   * never reached Google, so nothing was consumed at the other end either.
   *
   * NOT called for 429/quota (the request did arrive and did count against the
   * account) nor for 400/403 (the key is being marked `invalid`, and its
   * counter stops mattering).
   *
   * Clamped at zero so a double release cannot mint quota, exactly as
   * `SMSQuota.refund` is.
   */
  async releaseKey(keyId) {
    try {
      await GeminiKey.updateOne(
        { _id: keyId, requestsToday: { $gt: 0 } },
        { $inc: { requestsToday: -1 } }
      );
    } catch (error) {
      logger.warn(`Failed to release Gemini slot for key ${keyId}:`, error.message);
    }
  }

  /**
   * Reserve a key or throw the shop-facing 429.
   *
   * Kept as a named method because the error copy belongs in one place and both
   * `generateContent` and any future direct caller need the same sentence.
   */
  async getAvailableKey(strategy) {
    const keyDoc = await this.reserveKey(strategy);

    if (!keyDoc) {
      throw new AppError(
        'All AI accounts have reached their daily free limit. Please try again tomorrow or add a new key.',
        'সবগুলো AI অ্যাকাউন্টের আজকের ফ্রি লিমিট শেষ হয়েছে। দয়া করে অ্যাডমিন প্যানেল থেকে নতুন কি যোগ করুন অথবা আগামীকাল চেষ্টা করুন।',
        429
      );
    }

    return keyDoc;
  }

  /**
   * The pool's operating parameters, from PlatformSetting.
   *
   * Tolerates the read failing — a Mongo hiccup must not be what stops an AI
   * request, so both fall back to the code defaults. Same `?.` + constant
   * pattern every other `PlatformSetting.current()` caller uses.
   */
  async getPoolConfig() {
    const settings = await PlatformSetting.current().catch(() => null);
    return {
      strategy: settings?.geminiStrategy || 'least_used',
      // `null`, NOT the default model. This value is passed to `resolveModel`
      // as the operator's explicit CHOICE, and a default masquerading as a
      // choice would pin the pool to one name and defeat the discovery that
      // exists because a pinned name just caused an outage.
      model: settings?.geminiModel || null
    };
  }

  /**
   * Mark a key as quota_exceeded when 429 occurs
   */
  async markQuotaExceeded(keyId, errorMessage) {
    try {
      await GeminiKey.findByIdAndUpdate(keyId, {
        $set: {
          status: 'quota_exceeded',
          lastErrorMessage: errorMessage || 'Rate limit / Quota exceeded'
        }
      });
      logger.warn(`Gemini Key ${keyId} marked as quota_exceeded.`);
    } catch (error) {
      logger.warn(`Failed to update key status for ${keyId}:`, error.message);
    }
  }

  /**
   * Generate content, rotating keys and failing over between them.
   *
   * ── THE SECOND ARGUMENT USED TO BE A MODEL STRING ──────────────────────────
   *
   * It is an options object now, because structured extraction needs
   * `generationConfig` and there was no way to pass one. Callers that still
   * hand it a string keep working (see the shim below) — there was exactly one
   * such caller in the codebase (`testPrompt`), and a silent
   * `generationConfig: undefined` on the wire would have been worse than a
   * noisy break.
   *
   * @param {string} prompt
   * @param {Object|string} options
   * @param {string}  [options.model]             defaults to the pool config
   * @param {number}  [options.temperature]       omit for the model default
   * @param {string}  [options.responseMimeType]  'application/json' for JSON mode
   * @param {Object}  [options.responseSchema]    OpenAPI-subset schema
   * @param {number}  [options.timeoutMs=15000]
   * @param {string}  [options.strategy]          overrides PlatformSetting
   */
  async generateContent(prompt, options = {}, retryCount = 0, startedAt = Date.now()) {
    // Back-compat shim: `generateContent(prompt, 'gemini-1.5-flash')`.
    const opts = typeof options === 'string' ? { model: options } : (options || {});

    // Bounded by attempts AND wall-clock: this is awaited inline in the HTTP
    // request, so failover must not hold the request beyond ~20s total
    if (retryCount >= 3 || Date.now() - startedAt > 20000) {
      throw new AppError(
        'AI request failed after multiple key retries.',
        'একাধিক এপিআই কি ট্রাই করার পরও রিকোয়েস্ট ব্যর্থ হয়েছে।',
        500
      );
    }

    // Resolved once and carried through the failover recursion — re-reading
    // PlatformSetting on every retry is three round trips for one answer that
    // cannot have changed inside a 20-second window.
    const config = opts._config || await this.getPoolConfig();
    const timeoutMs = opts.timeoutMs || 15000;

    const keyDoc = await this.getAvailableKey(opts.strategy || config.strategy);

    // Resolved PER KEY, not once for the pool: two accounts on different tiers
    // do not expose the same models, and a name valid on one is a 404 on the
    // other. `_forceModelRefresh` is set by the retirement branch below, which
    // is how a model disappearing repairs itself inside one request instead of
    // failing every request until someone edits a constant.
    const model = opts.model
      || await this.resolveModel(keyDoc, config.model, opts._forceModelRefresh === true);

    // Only send `generationConfig` when something was actually asked for. An
    // object full of undefined keys is not the same request, and the offer-copy
    // playground must keep behaving exactly as it did.
    const generationConfig = {};
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = opts.maxOutputTokens;
    if (opts.responseMimeType) generationConfig.responseMimeType = opts.responseMimeType;
    if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyDoc.apiKey}`;
      const payload = {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {})
      };

      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs
      });

      const text =
        response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // The slot was taken by `reserveKey` BEFORE the call. Nothing to
      // increment here — that increment-after-success is the race this
      // replaced.
      return text;
    } catch (error) {
      const status = error.response?.status;
      const errMsg =
        error.response?.data?.error?.message || error.message || 'Gemini API Error';

      const retry = (extra = {}) =>
        this.generateContent(
          prompt,
          { ...opts, _config: config, ...extra },
          retryCount + 1,
          startedAt
        );

      if (status === 429 || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit')) {
        // NOT released: the request reached Google and counted against the
        // account there, whatever our own counter says.
        await this.markQuotaExceeded(keyDoc._id, errMsg);
        return retry();
      }

      // ── The model is gone, not the key ────────────────────────────────────
      //
      // "models/gemini-1.5-flash is not found for API version v1beta, or is not
      // supported for generateContent" — Google retiring a model. This arrives
      // as a 404 (and sometimes a 400), and the previous code had no branch for
      // it: the 400 path marked the KEY invalid, which is exactly backwards.
      // Every key in the pool would be walked, marked invalid one after another
      // for a fault none of them had, and the operator would be left with a
      // panel full of dead accounts and a working API bill.
      //
      // So: release the slot, re-list the models for this key, and retry with
      // whatever it actually has. The pool repairs itself inside the request.
      const looksLikeMissingModel =
        status === 404 ||
        /is not found for API version|not supported for generateContent|not found for model/i.test(errMsg);

      if (looksLikeMissingModel) {
        await this.releaseKey(keyDoc._id);
        // Drop the stale list so `resolveModel` is forced to ask Google again
        // rather than re-picking the name that just 404'd.
        await GeminiKey.updateOne(
          { _id: keyDoc._id },
          { $set: { availableModels: [], lastErrorMessage: `Model unavailable: ${errMsg}` } }
        ).catch(() => {});
        logger.warn(`Gemini model "${model}" unavailable on key ${keyDoc._id}; re-resolving.`);
        return retry({ model: undefined, _forceModelRefresh: true });
      }

      if (status === 400 || status === 403) {
        // A genuine key problem — bad credential, API disabled on the project,
        // referrer restriction. Not released: the key is being retired, so its
        // counter stops being consulted the moment this lands.
        await GeminiKey.findByIdAndUpdate(keyDoc._id, {
          $set: { status: 'invalid', lastErrorMessage: errMsg }
        });
        return retry();
      }

      // Everything else — timeout, socket error, 5xx from Google. The slot was
      // never spent, so give it back before deciding what to do.
      await this.releaseKey(keyDoc._id);

      // A 5xx or a timeout is worth one more key: it is a fault at the far end,
      // not a problem with the prompt. Anything else is our own bug and
      // retrying it three times just delays the error.
      if (!status || status >= 500) return retry();

      throw new AppError(
        `Gemini AI Error: ${errMsg}`,
        `এআই প্রসেসিং ত্রুটি: ${errMsg}`,
        500
      );
    }
  }
}

module.exports = new GeminiService();

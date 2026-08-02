const axios = require('axios');
const GeminiKey = require('../models/GeminiKey.model');
const { AppError } = require('../middleware/error.middleware');
const logger = require('../utils/logger.util');

class GeminiService {
  /**
   * Test a Gemini API key with live Google API call
   */
  async testApiKey(apiKey) {
    if (!apiKey) return { valid: false, error: 'API key is required' };
    try {
      const response = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { timeout: 8000 }
      );
      if (response.status === 200) {
        return { valid: true, modelsCount: response.data?.models?.length || 0 };
      }
      return { valid: false, error: 'Unexpected response status' };
    } catch (error) {
      const msg =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'API Key verification failed';
      return { valid: false, error: msg };
    }
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
   * Find an available active key with remaining daily quota
   */
  async getAvailableKey() {
    await this.checkAndResetDailyCounters();

    // Find active key with lowest request count today that has not exceeded its limit
    const keys = await GeminiKey.find({
      isActive: true,
      status: 'active'
    }).sort({ requestsToday: 1, createdAt: 1 });

    const validKey = keys.find((k) => k.requestsToday < k.dailyLimit);

    if (!validKey) {
      throw new AppError(
        'All AI accounts have reached their daily free limit. Please try again tomorrow or add a new key.',
        'সবগুলো AI অ্যাকাউন্টের আজকের ফ্রি লিমিট শেষ হয়েছে। দয়া করে অ্যাডমিন প্যানেল থেকে নতুন কি যোগ করুন অথবা আগামীকাল চেষ্টা করুন।',
        429
      );
    }

    return validKey;
  }

  /**
   * Increment usage count for a key
   */
  async incrementUsage(keyId) {
    try {
      await GeminiKey.findByIdAndUpdate(keyId, {
        $inc: { requestsToday: 1, totalRequests: 1 },
        $set: { lastUsedAt: new Date() }
      });
    } catch (error) {
      logger.warn(`Failed to increment Gemini usage for key ${keyId}:`, error.message);
    }
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
   * Generate content using Gemini AI with automatic key rotation & failover
   */
  async generateContent(prompt, model = 'gemini-1.5-flash', retryCount = 0, startedAt = Date.now()) {
    // Bounded by attempts AND wall-clock: this is awaited inline in the HTTP
    // request, so failover must not hold the request beyond ~20s total
    if (retryCount >= 3 || Date.now() - startedAt > 20000) {
      throw new AppError(
        'AI request failed after multiple key retries.',
        'একাধিক এপিআই কি ট্রাই করার পরও রিকোয়েস্ট ব্যর্থ হয়েছে।',
        500
      );
    }

    const keyDoc = await this.getAvailableKey();

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyDoc.apiKey}`;
      const payload = {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      };

      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      const text =
        response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      await this.incrementUsage(keyDoc._id);
      return text;
    } catch (error) {
      const status = error.response?.status;
      const errMsg =
        error.response?.data?.error?.message || error.message || 'Gemini API Error';

      if (status === 429 || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit')) {
        await this.markQuotaExceeded(keyDoc._id, errMsg);
        // Failover recursively to next key
        return this.generateContent(prompt, model, retryCount + 1, startedAt);
      } else if (status === 400 || status === 403) {
        await GeminiKey.findByIdAndUpdate(keyDoc._id, {
          $set: { status: 'invalid', lastErrorMessage: errMsg }
        });
        return this.generateContent(prompt, model, retryCount + 1, startedAt);
      }

      throw new AppError(
        `Gemini AI Error: ${errMsg}`,
        `এআই প্রসেসিং ত্রুটি: ${errMsg}`,
        500
      );
    }
  }
}

module.exports = new GeminiService();

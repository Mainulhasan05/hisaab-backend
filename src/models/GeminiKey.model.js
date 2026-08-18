const mongoose = require('mongoose');

const geminiKeySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'অ্যাকাউন্টের নাম দিন'],
    trim: true
  },
  apiKey: {
    type: String,
    required: [true, 'API Key দিন'],
    trim: true
  },
  /**
   * OUR ceiling on this account, per day. Operator-set, not Google's.
   *
   * ── READ THIS BEFORE SHOWING IT TO ANYONE AS "THE LIMIT" ──────────────────
   *
   * Google's Generative Language API does not expose the remaining free-tier
   * quota for a key. There is no endpoint to ask; the only signal that a real
   * quota is gone is a 429 on the request that exceeds it. So this number is
   * NOT a reading of Google's allowance — it is the budget an operator typed,
   * which the pool enforces on our side to spread load and to stop one account
   * absorbing everything before the others are touched.
   *
   * `requestsToday` beside it IS real: it is what this system actually sent
   * today, counted at reservation time. The admin panel must present the two
   * differently — one is measured, the other is a policy — or an operator will
   * read "1200 / 1500" as headroom Google has agreed to, and be surprised by a
   * 429 at 400.
   *
   * The default is 200 rather than 1500: 1500/day was the old free-tier figure
   * for a model that no longer exists, and a ceiling set above the real quota
   * enforces nothing at all. A conservative default rotates keys sooner, which
   * is the behaviour that actually protects the pool.
   */
  dailyLimit: {
    type: Number,
    default: 200,
    min: [1, 'দৈনিক লিমিট কমপক্ষে ১ হতে হবে']
  },
  requestsToday: {
    type: Number,
    default: 0
  },
  totalRequests: {
    type: Number,
    default: 0
  },
  lastUsedAt: {
    type: Date,
    default: null
  },
  lastResetDate: {
    type: String,
    default: () => new Date().toISOString().split('T')[0]
  },
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['active', 'quota_exceeded', 'invalid'],
    default: 'active'
  },
  lastErrorMessage: {
    type: String,
    default: null
  },

  /**
   * Which models this key can actually reach, from Google's ListModels.
   *
   * Cached here so the ordinary request path costs zero extra HTTP calls.
   * Refilled when the key is created, when it is tested, and when a model turns
   * out to be retired mid-request (see `gemini.service.generateContent`).
   *
   * An EMPTY array is meaningful: it is how the retirement branch signals
   * "re-ask Google", so `resolveModel` must treat empty as unknown rather than
   * as "this key has no models".
   */
  availableModels: {
    type: [String],
    default: []
  },
  modelsCheckedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

/**
 * The pool-selection index.
 *
 * `gemini.service.reserveKey` filters on `{ isActive, status }` plus an `$expr`
 * comparing two fields (which no index can serve), then sorts by EITHER
 * `requestsToday` (least_used) or `lastUsedAt` (round_robin). Both sort keys sit
 * behind the same equality prefix here, so one index covers both strategies.
 *
 * `lastUsedAt` was not in the previous version of this index; without it the
 * round-robin sort was an in-memory sort of the whole active pool.
 */
geminiKeySchema.index({ isActive: 1, status: 1, requestsToday: 1, lastUsedAt: 1 });

// Helper to mask key for API responses (e.g. AIzaSy...X9Y7)
geminiKeySchema.methods.getMaskedKey = function() {
  if (!this.apiKey) return '';
  if (this.apiKey.length <= 10) return '••••••••';
  return `${this.apiKey.substring(0, 6)}••••••••${this.apiKey.substring(this.apiKey.length - 4)}`;
};

const GeminiKey = mongoose.model('GeminiKey', geminiKeySchema);

module.exports = GeminiKey;

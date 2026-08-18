const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * A step-up authentication challenge for an admin-panel password operation.
 *
 * The code is texted to the FOUNDER's number regardless of which admin asked —
 * see `adminSecurity.service.js` for why that is the policy rather than a bug.
 *
 * ── WHY THIS IS NOT `PasswordReset` ─────────────────────────────────────────
 *
 * `PasswordReset` is the shop-user recovery flow and is keyed `phone` UNIQUE.
 * Reusing it here would collide in exactly the case this feature exists for:
 * 01757995016 is both the founder's admin login AND a phone that can hold shop
 * accounts. One unique row per phone means an admin password change and a
 * shopkeeper's forgotten-password reset would overwrite each other's code,
 * their throttle counters and their reset tokens. Worse, a code minted to
 * change the PLATFORM password would be spendable against the shop account and
 * vice versa — one flow's secret unlocking the other's decision, which is the
 * first thing `PasswordReset`'s own header warns against.
 *
 * So: keyed on the admin and the purpose, not on the phone.
 *
 * ── WHAT IS STORED ──────────────────────────────────────────────────────────
 *
 * Both secrets are stored HASHED, for the reason `PasswordReset` gives: this
 * collection is readable by anything holding a database connection, backups
 * included, and a live code sitting in a backup is a live code. sha256 unsalted
 * is deliberate and sufficient — the inputs are either high entropy (a 32-byte
 * token) or short-lived and attempt-capped (six digits), and lookup has to be
 * by exact value.
 */
const PURPOSES = ['password_change', 'password_reset'];

const adminSecurityChallengeSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },

    /**
     * `password_change` — the admin is signed in and knows the current password.
     * `password_reset`  — the admin is locked out. Same code path, but the
     *                     current-password proof is missing, so the founder's
     *                     phone is the ONLY factor. Rate limits are tighter.
     */
    purpose: {
      type: String,
      enum: PURPOSES,
      required: true,
    },

    // ── Step 1: the code we texted ──
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    /** Wrong guesses against the CURRENT code. Reset when a new one is issued. */
    attempts: { type: Number, default: 0 },

    // ── Send throttling ──
    //
    // The founder's number is a single fixed target, which makes it the ideal
    // thing to SMS-bomb: without these an attacker who can reach the endpoint
    // could bury the one number that matters under a hundred codes, at the
    // platform's expense, and hide a real alert in the noise.
    sentAt: { type: Date, default: null },
    sendCount: { type: Number, default: 0 },
    windowStartedAt: { type: Date, default: null },

    /**
     * The number the code actually went to, denormalised at send time.
     *
     * Recorded rather than re-derived because the founder number is a config
     * value and config changes. An audit six months from now must say where the
     * code went THEN, not where it would go today.
     */
    targetPhone: { type: String, default: null },

    // ── Step 2: proof the code was entered correctly ──
    challengeTokenHash: { type: String, default: null },
    challengeTokenExpiresAt: { type: Date, default: null },

    /** Origin of the most recent request. For investigation only, never read by the flow. */
    lastIp: { type: String, default: null },

    // TTL. Set past whichever secret outlives the other so an abandoned
    // half-finished challenge cleans itself up.
    purgeAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

// One live challenge per (admin, purpose). Unique so a double-tapped "send
// code" cannot mint two codes and leave the operator guessing which one works;
// the second request adopts the first's row and hits the cooldown instead.
adminSecurityChallengeSchema.index({ admin: 1, purpose: 1 }, { unique: true });

/** Hash a bearer secret for storage/comparison. */
adminSecurityChallengeSchema.statics.hashSecret = function (value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
};

/** A fresh 6-digit code, same shape as every other OTP in the system. */
adminSecurityChallengeSchema.statics.generateCode = function () {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/** A fresh challenge token — 32 random bytes, hex. */
adminSecurityChallengeSchema.statics.generateChallengeToken = function () {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Constant-time comparison of a candidate against a stored hash.
 *
 * `===` on hex digests leaks position-of-first-difference through timing. Thin
 * against a value that expires in minutes, but this is a platform-admin
 * credential and the fix is one function call.
 */
adminSecurityChallengeSchema.statics.matchesHash = function (candidate, storedHash) {
  if (!candidate || !storedHash) return false;
  const a = Buffer.from(this.hashSecret(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** Is there a live, unspent code on this challenge? */
adminSecurityChallengeSchema.methods.hasLiveCode = function () {
  return Boolean(this.otpHash && this.otpExpiresAt && this.otpExpiresAt > new Date());
};

const AdminSecurityChallenge = mongoose.model('AdminSecurityChallenge', adminSecurityChallengeSchema);

module.exports = AdminSecurityChallenge;
module.exports.PURPOSES = PURPOSES;

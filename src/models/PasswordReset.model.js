const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * A password-reset attempt, keyed on the PHONE rather than on a user.
 *
 * ── Why this is not `User.otp` ───────────────────────────────────────────────
 *
 * `User.otp` already exists and already carries a six-digit code, so reusing it
 * looks free. It is not, for three reasons:
 *
 *   1. IT MEANS SOMETHING ELSE. `User.otp` proves "this phone is reachable" and
 *      is consumed by `verifyOTP`, which sets `isPhoneVerified`. A code minted
 *      for a password reset would be spendable as a phone verification and vice
 *      versa — one flow's secret unlocking the other's decision.
 *   2. `{phone, shop}` IS THE UNIQUE KEY, NOT `phone`. One number can hold an
 *      owner account in one shop and a staff account in another (see
 *      `AuthService.login`). A reset is about the NUMBER, so hanging it off one
 *      arbitrarily-chosen user document is already the wrong shape.
 *   3. NO USER, NO DOCUMENT. A reset requested for a number that has no account
 *      must look identical to one that does, or the endpoint becomes a public
 *      "is this number registered?" oracle. That requires a record to exist for
 *      numbers that have no user — which `User.otp` cannot provide.
 *
 * ── What is stored ───────────────────────────────────────────────────────────
 *
 * The OTP and the reset token are stored HASHED. They are bearer secrets for
 * the few minutes they live, and this collection is readable by anything with a
 * database connection — including the backup scripts. Hashing costs one sha256
 * per verify and removes the whole class of "leaked a backup, leaked live reset
 * codes" problems. sha256 with no salt is deliberate and sufficient here: the
 * inputs are high-enough entropy (a 32-byte token) or short-lived and
 * attempt-capped (a 6-digit code), and the lookup has to be by exact value.
 *
 * Note this is a different call from `SMSService.sendOTP`, which logs the OTP
 * body verbatim — see the comment there. The two are not in conflict: that log
 * is the operator's only answer to "did this code go out", and it is already
 * documented as sensitive. This is the verification side, and there is no
 * reason for it to hold a usable secret at rest.
 */
const passwordResetSchema = new mongoose.Schema({
  // Normalized (`normalizePhone`) — the same form `User.phone` is stored in, so
  // the two are directly comparable without re-normalising at every call site.
  phone: {
    type: String,
    required: true,
    unique: true
  },

  // ── Step 1: the code we texted ──
  otpHash: { type: String, default: null },
  otpExpiresAt: { type: Date, default: null },
  // Wrong guesses against the CURRENT code. Reset when a new code is issued;
  // capped so a 6-digit space cannot be walked.
  attempts: { type: Number, default: 0 },

  // ── Send throttling, per phone ──
  //
  // Rate limiting by IP alone does not protect the PERSON being texted: an
  // attacker on a rotating IP would otherwise be able to have us SMS-bomb any
  // number in Bangladesh, at the platform's expense. These two fields are what
  // make the number itself the budget.
  sentAt: { type: Date, default: null },
  sendCount: { type: Number, default: 0 },
  windowStartedAt: { type: Date, default: null },

  // ── Step 2: proof the code was entered correctly ──
  //
  // Issued on successful verification and spent by the actual password write,
  // so the code never has to be re-sent or held by the browser across the last
  // step, and cannot be replayed once used.
  resetTokenHash: { type: String, default: null },
  resetTokenExpiresAt: { type: Date, default: null },

  // TTL. Set past whichever of the two secrets outlives the other, so a
  // half-finished reset cleans itself up rather than accumulating one row per
  // forgetful shopkeeper forever.
  purgeAt: { type: Date, required: true, expires: 0 },

  // Origin of the most recent request, for abuse investigation only. Never read
  // by the flow itself — a reset must work from a different network than the
  // one that started it, which is the normal case on mobile data.
  lastIp: { type: String, default: null }
}, { timestamps: true });

/** Hash a bearer secret for storage/comparison. */
passwordResetSchema.statics.hashSecret = function (value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
};

/** A fresh 6-digit code, matching the shape `User.generateOTP` produces. */
passwordResetSchema.statics.generateCode = function () {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/** A fresh reset token — 32 random bytes, hex. */
passwordResetSchema.statics.generateResetToken = function () {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Constant-time comparison of a candidate against a stored hash.
 *
 * `===` on hex digests leaks position-of-first-difference through timing. That
 * is a thin channel against a value that expires in five minutes, but the fix
 * is one function call and this is the one place in the codebase where a
 * secret is compared by value rather than by bcrypt.
 */
passwordResetSchema.statics.matchesHash = function (candidate, storedHash) {
  if (!candidate || !storedHash) return false;
  const a = Buffer.from(this.hashSecret(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** Is there a live, unspent code on this request? */
passwordResetSchema.methods.hasLiveCode = function () {
  return Boolean(this.otpHash && this.otpExpiresAt && this.otpExpiresAt > new Date());
};

const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);

module.exports = PasswordReset;

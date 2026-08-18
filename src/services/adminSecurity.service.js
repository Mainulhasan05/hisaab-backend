const Admin = require('../models/Admin.model');
const AdminSecurityChallenge = require('../models/AdminSecurityChallenge.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('./sms.service');
const platformNotify = require('./platformNotify.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { normalizePhone } = require('../utils/phone.util');
const { toBengaliNumber } = require('../utils/bengali.util');
const logger = require('../utils/logger.util');

/**
 * Admin password changes, gated behind an SMS code to the FOUNDER's number.
 *
 * ── THE POLICY, AND WHY ─────────────────────────────────────────────────────
 *
 * Every admin password operation — whoever asks, whichever admin account it
 * targets — sends its code to one fixed number: the founder's. Not to the
 * admin's own phone.
 *
 * That is deliberate, and it is the whole point of the feature. The admin
 * console can suspend any shop, read every shop's revenue, and impersonate any
 * user. An admin account is therefore not a personal login, it is a key to the
 * business, and the person who owns the business should be the one who has to
 * be physically present for that key to be re-cut. Sending each admin their own
 * code would mean a support admin with a stolen SIM can lock the founder out of
 * their own platform.
 *
 * The costs of this choice, stated plainly because they are real:
 *
 *   · A second admin cannot change their own password without the founder. That
 *     is intended — it is a two-person control, not an oversight.
 *   · If the founder loses that number, admin password recovery stops working
 *     entirely. The escape hatch is `PLATFORM_FOUNDER_PHONE` in the server
 *     environment, which is a deploy-time change and therefore already requires
 *     server access — a strictly higher bar than the one being protected.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *
 * Three steps, mirroring the shop-user reset in `auth.service`:
 *
 *   1. request — proves the caller holds the current password (change) or
 *      nothing at all (locked-out reset), then texts a code to the founder.
 *   2. verify  — spends the code, hands back a single-use challenge token.
 *   3. change  — spends the token, writes the password.
 *
 * The middle step exists so the new password never has to travel alongside the
 * code, and so a correct code is not burned by a rejected password.
 */

const CHALLENGE = {
  /** How long a texted code stays usable. Matches every other OTP here. */
  CODE_TTL_MS: 5 * 60 * 1000,
  /** Minimum gap between two codes for the same admin + purpose. */
  RESEND_COOLDOWN_MS: 60 * 1000,
  /** The window MAX_SENDS_PER_WINDOW is counted over. */
  SEND_WINDOW_MS: 60 * 60 * 1000,
  /**
   * Codes per hour. Lower than the shop flow's five: this one always texts the
   * SAME number, so the throttle is the only thing standing between a hostile
   * caller and the founder's phone being buried under platform SMS.
   */
  MAX_SENDS_PER_WINDOW: 3,
  /** Wrong guesses against one code before it is dead. */
  MAX_VERIFY_ATTEMPTS: 5,
  /** How long the post-verification token is spendable for. */
  TOKEN_TTL_MS: 10 * 60 * 1000,
  /** TTL floor on the record — outlives both secrets by a margin. */
  PURGE_MS: 60 * 60 * 1000,
};

/** Last resort if nothing is configured. The founder's number, as seeded. */
const FALLBACK_FOUNDER_PHONE = '01757995016';

/**
 * Where admin codes are texted.
 *
 * Read from the environment on every call rather than captured at module load,
 * so changing it is a restart rather than a redeploy — and so a test can set it
 * without re-requiring the module.
 *
 * Falls back through SUPER_ADMIN_PHONE (which the seeder already uses to create
 * the founder account) before the hard-coded default, so a deployment that has
 * customised the super admin does not silently keep texting someone else's
 * number.
 */
function founderPhone() {
  const configured =
    process.env.PLATFORM_FOUNDER_PHONE ||
    process.env.SUPER_ADMIN_PHONE ||
    FALLBACK_FOUNDER_PHONE;
  return normalizePhone(String(configured).trim());
}

/**
 * `01757995016` → `017*****016`.
 *
 * The API says which number it texted so the operator knows where to look, but
 * the reset endpoint is public — printing the founder's full number there would
 * hand it to anyone who can send a POST.
 */
function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length < 7) return '***';
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 6)}${value.slice(-3)}`;
}

class AdminSecurityService {
  // ────────────────────────────────────────────────────────────────────────
  // Step 1 — issue a code
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Mint and send a code for `admin` + `purpose`, applying both throttles.
   *
   * Shared by the signed-in change flow and the locked-out reset flow, which
   * differ only in what they had to prove BEFORE getting here.
   */
  async _issueChallenge(admin, purpose, req) {
    const now = new Date();

    let record = await AdminSecurityChallenge.findOne({ admin: admin._id, purpose });
    if (!record) {
      record = new AdminSecurityChallenge({
        admin: admin._id,
        purpose,
        purgeAt: new Date(now.getTime() + CHALLENGE.PURGE_MS),
      });

      // `{admin, purpose}` is unique, so a double-tapped button can have both
      // requests find nothing and both try to insert. Losing that race is not
      // an error — the winner's row is the row this request wanted — and
      // adopting it means the loser hits the cooldown below rather than
      // sending a second SMS.
      try {
        await record.save();
      } catch (error) {
        if (error?.code !== 11000) throw error;
        record = await AdminSecurityChallenge.findOne({ admin: admin._id, purpose });
        if (!record) throw error;
      }
    }

    // Roll the hourly window before reading the count, so three requests
    // yesterday do not still block today.
    if (
      !record.windowStartedAt ||
      now.getTime() - new Date(record.windowStartedAt).getTime() >= CHALLENGE.SEND_WINDOW_MS
    ) {
      record.windowStartedAt = now;
      record.sendCount = 0;
    }

    if (record.sentAt) {
      const elapsed = now.getTime() - new Date(record.sentAt).getTime();
      if (elapsed < CHALLENGE.RESEND_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((CHALLENGE.RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new AppError(
          `Please wait ${secondsLeft} seconds before requesting another code`,
          `অনুগ্রহ করে ${toBengaliNumber(secondsLeft)} সেকেন্ড পর আবার কোড নিন`,
          429
        );
      }
    }

    if (record.sendCount >= CHALLENGE.MAX_SENDS_PER_WINDOW) {
      throw new AppError(
        'Too many codes requested. Please try again in an hour.',
        'অনেকবার কোড চাওয়া হয়েছে। এক ঘণ্টা পর আবার চেষ্টা করুন।',
        429
      );
    }

    const target = founderPhone();
    const code = AdminSecurityChallenge.generateCode();

    record.otpHash = AdminSecurityChallenge.hashSecret(code);
    record.otpExpiresAt = new Date(now.getTime() + CHALLENGE.CODE_TTL_MS);
    record.attempts = 0;
    record.sentAt = now;
    record.sendCount += 1;
    record.targetPhone = target;
    record.lastIp = req?.ip || null;
    // A new code invalidates any token an earlier verification handed out —
    // otherwise a token from a superseded code survives a fresh start.
    record.challengeTokenHash = null;
    record.challengeTokenExpiresAt = null;
    record.purgeAt = new Date(now.getTime() + CHALLENGE.PURGE_MS);
    await record.save();

    const body =
      `Hisaab ADMIN security code: ${code}\n` +
      `Account: ${admin.name} (${admin.phone})\n` +
      `Valid 5 minutes. If this was not you, do NOT share it.`;

    try {
      await SMSService.sendSystemSingle({
        phone: target,
        message: body,
        // Its own audience so the SMS panel can answer "was the admin code
        // delivered" without digging through every registration OTP.
        audience: 'system_admin_security',
      });
    } catch (error) {
      // Logged, not surfaced. The gateway being down is not something the
      // caller can act on differently from a code that has not arrived yet,
      // and the recourse — the resend button — is the same either way.
      logger.error(`Admin security code send failed for ${admin._id}: ${error.message}`);
    }

    // Second channel, on purpose. If someone is trying to take the console,
    // the SMS alone can be intercepted or simply not noticed; a Telegram alert
    // arriving at the same moment is how the founder finds out that a code was
    // requested at all.
    platformNotify.adminActivity({
      title: 'অ্যাডমিন পাসওয়ার্ড কোড পাঠানো হয়েছে',
      lines: [
        `👤 ${admin.name}`,
        `📞 <code>${admin.phone}</code>`,
        `📩 কোড গেছে: <code>${maskPhone(target)}</code>`,
        `🎯 ${purpose === 'password_reset' ? 'লকআউট রিকভারি' : 'পাসওয়ার্ড পরিবর্তন'}`,
      ],
      req,
      urgent: true,
    });

    AuditLog.log({
      admin: admin._id,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_OTP_SENT.en,
      description: `Admin security code sent to ${maskPhone(target)} (${purpose})`,
      req,
    }).catch(() => {});

    return {
      sentTo: maskPhone(target),
      cooldownSeconds: CHALLENGE.RESEND_COOLDOWN_MS / 1000,
      expiresInSeconds: CHALLENGE.CODE_TTL_MS / 1000,
      attemptsAllowed: CHALLENGE.MAX_VERIFY_ATTEMPTS,
    };
  }

  /**
   * A signed-in admin asks to change their own password.
   *
   * The current password is required even though the OTP is the real gate: it
   * stops a walk-up attacker at an unlocked console from firing codes at the
   * founder's phone, and it keeps a stolen session from being enough on its own.
   */
  async requestPasswordChange({ adminId, currentPassword, req }) {
    const admin = await Admin.findById(adminId).select('+password');
    if (!admin || !admin.isActive) {
      throw new AppError('Admin not found', 'অ্যাডমিন পাওয়া যায়নি', 404);
    }

    if (!currentPassword || !(await admin.comparePassword(currentPassword))) {
      // Counted like any other failed credential check, so hammering this
      // endpoint from a hijacked session produces a burst alert.
      platformNotify.failedLogin({ phone: admin.phone, name: admin.name, req });
      throw new AppError('Current password is incorrect', 'বর্তমান পাসওয়ার্ড সঠিক নয়', 401);
    }

    return this._issueChallenge(admin, 'password_change', req);
  }

  /**
   * A locked-out admin asks for recovery.
   *
   * Public — the caller cannot sign in, which is the entire premise. Safe
   * because the code goes to the founder's phone no matter what the caller
   * types, so knowing an admin's phone number buys nothing.
   *
   * Responds identically for a number with no admin account. Without that this
   * becomes a public "is this an admin phone?" oracle, which is a list worth
   * having if you intend to attack the console.
   */
  async requestPasswordReset({ phone, req }) {
    const normalized = normalizePhone(phone);
    const admin = await Admin.findOne({ phone: normalized, isActive: true });

    if (!admin) {
      logger.warn(`Admin password reset requested for non-admin phone ${normalized}`);
      return {
        sentTo: maskPhone(founderPhone()),
        cooldownSeconds: CHALLENGE.RESEND_COOLDOWN_MS / 1000,
        expiresInSeconds: CHALLENGE.CODE_TTL_MS / 1000,
        attemptsAllowed: CHALLENGE.MAX_VERIFY_ATTEMPTS,
      };
    }

    return this._issueChallenge(admin, 'password_reset', req);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 2 — spend the code, take a token
  // ────────────────────────────────────────────────────────────────────────

  /**
   * @param {object} args
   * @param {string} [args.adminId] Signed-in change flow.
   * @param {string} [args.phone]   Locked-out reset flow.
   */
  async verifyCode({ adminId, phone, purpose, otp, req }) {
    const admin = adminId
      ? await Admin.findById(adminId)
      : await Admin.findOne({ phone: normalizePhone(phone), isActive: true });

    // One message for "no such admin", "no such request", "expired" and "never
    // had a code". Distinguishing them gives back the oracle step 1 withholds.
    const rejected = () =>
      new AppError('Invalid or expired code', 'কোডটি ভুল বা মেয়াদ শেষ। নতুন কোড নিন।', 400);

    if (!admin) throw rejected();

    const record = await AdminSecurityChallenge.findOne({ admin: admin._id, purpose });
    if (!record || !record.hasLiveCode()) throw rejected();

    if (record.attempts >= CHALLENGE.MAX_VERIFY_ATTEMPTS) {
      throw new AppError(
        'Too many incorrect attempts. Request a new code.',
        'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড নিন।',
        429
      );
    }

    if (!AdminSecurityChallenge.matchesHash(otp, record.otpHash)) {
      record.attempts += 1;
      await record.save();

      const left = CHALLENGE.MAX_VERIFY_ATTEMPTS - record.attempts;

      // A code being guessed at is a stronger signal than a password being
      // guessed at — it means someone already got past step 1. Report the last
      // attempt immediately rather than waiting for a burst to form.
      if (left <= 0) {
        platformNotify.adminActivity({
          title: 'অ্যাডমিন কোড বারবার ভুল দেওয়া হয়েছে',
          lines: [`👤 ${admin.name}`, `📞 <code>${admin.phone}</code>`, '🔒 কোডটি বাতিল করা হয়েছে।'],
          req,
          urgent: true,
        });
      }

      throw new AppError(
        left > 0 ? `Incorrect code. ${left} attempts remaining.` : 'Incorrect code. Request a new one.',
        left > 0
          ? `কোডটি ভুল। আর ${toBengaliNumber(left)} বার চেষ্টা করতে পারবেন।`
          : 'কোডটি ভুল। নতুন কোড নিন।',
        400
      );
    }

    const now = new Date();
    const challengeToken = AdminSecurityChallenge.generateChallengeToken();

    record.challengeTokenHash = AdminSecurityChallenge.hashSecret(challengeToken);
    record.challengeTokenExpiresAt = new Date(now.getTime() + CHALLENGE.TOKEN_TTL_MS);
    // Single use. The code has done its job and must not survive to be replayed
    // against a second token if this one is abandoned.
    record.otpHash = null;
    record.otpExpiresAt = null;
    record.attempts = 0;
    record.purgeAt = new Date(now.getTime() + CHALLENGE.TOKEN_TTL_MS + 5 * 60 * 1000);
    await record.save();

    return {
      challengeToken,
      expiresInSeconds: CHALLENGE.TOKEN_TTL_MS / 1000,
      admin: { name: admin.name, phone: admin.phone, role: admin.role },
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Step 3 — spend the token, write the password
  // ────────────────────────────────────────────────────────────────────────

  async changePassword({ adminId, phone, purpose, challengeToken, newPassword, req }) {
    const admin = adminId
      ? await Admin.findById(adminId)
      : await Admin.findOne({ phone: normalizePhone(phone), isActive: true });

    const expired = () =>
      new AppError(
        'This session has expired. Please start again.',
        'সময় শেষ হয়ে গেছে। আবার নতুন করে শুরু করুন।',
        400
      );

    if (!admin) throw expired();

    const record = await AdminSecurityChallenge.findOne({ admin: admin._id, purpose });
    const now = new Date();

    if (
      !record ||
      !record.challengeTokenHash ||
      !record.challengeTokenExpiresAt ||
      record.challengeTokenExpiresAt <= now
    ) {
      throw expired();
    }

    if (!AdminSecurityChallenge.matchesHash(challengeToken, record.challengeTokenHash)) {
      throw expired();
    }

    // Assigned rather than hashed here: the model's pre-save hook owns hashing
    // and stamps `passwordChangedAt`, which is what `changedPasswordAfter`
    // reads to invalidate every token issued before now — including one an
    // attacker already holds, which is half of what a password change is FOR.
    admin.password = newPassword;
    // A recovering admin was locked out; leaving the lock in place would mean
    // the new password does not work either.
    admin.loginAttempts = 0;
    admin.lockUntil = undefined;
    await admin.save();

    // Single use, and nothing left worth keeping.
    await AdminSecurityChallenge.deleteOne({ _id: record._id });

    AuditLog.log({
      admin: admin._id,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_CHANGED.en,
      description: `Admin password changed via SMS code (${purpose})`,
      req,
    }).catch(() => {});

    platformNotify.adminActivity({
      title: 'অ্যাডমিন পাসওয়ার্ড পরিবর্তন হয়েছে',
      lines: [
        `👤 ${admin.name}`,
        `📞 <code>${admin.phone}</code>`,
        `🎯 ${purpose === 'password_reset' ? 'লকআউট রিকভারি' : 'পাসওয়ার্ড পরিবর্তন'}`,
        '',
        '✅ আগের সব সেশন বাতিল হয়েছে।',
      ],
      req,
      urgent: true,
    });

    // A confirmation SMS, not just a Telegram message. Telegram may be
    // unlinked, blocked or simply not installed on the phone the founder has
    // to hand; the one event that must never happen silently is the platform
    // password changing.
    SMSService.sendSystemSingle({
      phone: founderPhone(),
      message:
        `Hisaab ADMIN password for ${admin.name} (${admin.phone}) was just changed. ` +
        `If this was not you, contact support immediately.`,
      audience: 'system_admin_security',
    }).catch((err) => logger.error(`Admin password-change SMS failed: ${err.message}`));

    logger.warn(`Admin password changed for ${admin.phone} (${purpose})`);

    return { changed: true };
  }

  /** Exposed so the console can show the operator where codes will land. */
  getCodeDestination() {
    return { masked: maskPhone(founderPhone()) };
  }
}

module.exports = new AdminSecurityService();
module.exports.CHALLENGE = CHALLENGE;
module.exports.founderPhone = founderPhone;
module.exports.maskPhone = maskPhone;

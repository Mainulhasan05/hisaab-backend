/**
 * Forgot password — the three steps, and the things that must not be true.
 *
 * Four properties are load-bearing, and every one of them fails SILENTLY if it
 * breaks: nothing throws, nothing logs, the flow keeps working, and the only
 * symptom is a security hole or a support call.
 *
 *   · STEP 1 DOES NOT SAY WHETHER A NUMBER IS REGISTERED. If it ever starts to,
 *     the endpoint becomes a public "which numbers belong to shop owners?"
 *     lookup — the input to a targeted phishing call, at the scale of the whole
 *     customer base.
 *   · THE CODE IS SINGLE USE. Verified once, it must not verify again. A code
 *     left live after a successful verification is a code an attacker who
 *     shoulder-surfed the SMS can spend later.
 *   · THE TOKEN IS SINGLE USE, AND SUPERSEDED BY A NEW CODE. Asking for a fresh
 *     code has to kill any token already issued, or a token minted from a code
 *     sent to the PREVIOUS holder of a recycled number survives the real owner
 *     starting over.
 *   · A RESET COVERS EVERY ACCOUNT ON THE NUMBER. `{phone, shop}` is the unique
 *     key on User, so one number can hold accounts in several shops. Resetting
 *     one of them produces "I changed my password and it still says wrong" from
 *     someone standing at a till in the other.
 *
 * Plus the regression that started all this: `changePassword` required a
 * `confirmPassword` the only client never sent, so every password change from
 * the settings page died in Joi and surfaced as "তথ্য যাচাই ব্যর্থ".
 */

// Hoisted above the require of auth.service, which holds a module-level
// reference to the model — a later jest.spyOn would never be seen by it.
jest.mock('../models/PasswordReset.model', () => {
  const crypto = require('crypto');
  const store = new Map();

  class FakePasswordReset {
    constructor(doc) {
      Object.assign(this, { attempts: 0, sendCount: 0 }, doc);
    }

    async save() {
      store.set(this.phone, this);
      return this;
    }

    hasLiveCode() {
      return Boolean(this.otpHash && this.otpExpiresAt && this.otpExpiresAt > new Date());
    }
  }

  // The crypto statics are the real ones — they are pure and are half of what
  // is under test. Only the code and token are pinned, so assertions can name
  // exact values instead of reaching into the mock.
  FakePasswordReset.hashSecret = (v) =>
    crypto.createHash('sha256').update(String(v)).digest('hex');
  FakePasswordReset.matchesHash = (candidate, storedHash) =>
    Boolean(candidate && storedHash) && FakePasswordReset.hashSecret(candidate) === storedHash;
  FakePasswordReset.generateCode = jest.fn(() => '123456');
  FakePasswordReset.generateResetToken = jest.fn(() => 'a'.repeat(64));

  FakePasswordReset.findOne = jest.fn(async ({ phone }) => store.get(phone) || null);
  FakePasswordReset.deleteOne = jest.fn(async () => {
    store.clear();
    return { deletedCount: 1 };
  });

  FakePasswordReset.__store = store;
  return FakePasswordReset;
});

jest.mock('../utils/authCache.util', () => ({
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));

const mongoose = require('mongoose');
const authService = require('../services/auth.service');
const authValidation = require('../validations/auth.validation');
const PasswordReset = require('../models/PasswordReset.model');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('../services/sms.service');
const { invalidateUserAuthCache } = require('../utils/authCache.util');

const PHONE = '01712345678';

/**
 * `User.find(...)` is called three different ways by this flow — bare, with
 * `.select().lean()`, and with `.select().populate().lean()`. One chainable
 * thenable answers all three without the test having to know which step is
 * asking.
 */
const findResult = (docs) => {
  const chain = {
    select: () => chain,
    populate: () => chain,
    lean: async () => docs,
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
  return chain;
};

/** A saveable User stand-in for step 3, which mutates and saves real docs. */
const makeUser = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'মালিক',
  shop: new mongoose.Types.ObjectId(),
  isOwner: true,
  isPhoneVerified: false,
  clearOTP: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

/** Put the phone's throttle history far enough in the past to be irrelevant. */
const clearCooldown = () => {
  const record = PasswordReset.__store.get(PHONE);
  if (record) {
    record.sentAt = new Date(Date.now() - 10 * 60 * 1000);
    record.windowStartedAt = new Date(Date.now() - 10 * 60 * 1000);
  }
  return record;
};

beforeEach(() => {
  PasswordReset.__store.clear();
  jest.clearAllMocks();
  jest.spyOn(SMSService, 'sendPasswordResetOtp').mockResolvedValue(undefined);
  jest.spyOn(AuditLog, 'log').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

/* ══════════════════════════════════════════════════════════════════════════ */

describe('step 1 — asking for a code tells you nothing about the number', () => {
  it('answers identically for a number with no account, and sends no SMS', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([]));

    const result = await authService.requestPasswordReset(PHONE, { ip: '1.1.1.1' });

    expect(result).toEqual({ cooldownSeconds: 60, expiresInSeconds: 300 });
    expect(SMSService.sendPasswordResetOtp).not.toHaveBeenCalled();

    // A row IS written even with no user — that is what makes the throttles
    // below apply to an attacker walking a list of numbers.
    const record = PasswordReset.__store.get(PHONE);
    expect(record).toBeDefined();
    expect(record.otpHash).toBeNull();
  });

  it('sends the code when the number does have an account, with the same answer', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));

    const result = await authService.requestPasswordReset(PHONE, { ip: '1.1.1.1' });

    expect(result).toEqual({ cooldownSeconds: 60, expiresInSeconds: 300 });
    expect(SMSService.sendPasswordResetOtp).toHaveBeenCalledWith(PHONE, '123456');
  });

  it('never stores the code in the clear', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));

    await authService.requestPasswordReset(PHONE, {});

    const record = PasswordReset.__store.get(PHONE);
    expect(record.otpHash).toBe(PasswordReset.hashSecret('123456'));

    // No field holds the code itself. Checked field by field rather than by
    // scanning `JSON.stringify(record)` for the digits — the test phone
    // 01712345678 contains "123456", so a whole-blob scan fails on the phone
    // number and proves nothing about the secret.
    const { phone, ...rest } = record;
    expect(JSON.stringify(rest)).not.toContain('123456');
    expect(record.otp).toBeUndefined();
    expect(record.code).toBeUndefined();
  });

  it('still reports success when the SMS gateway refuses', async () => {
    // Surfacing this would answer "does this number have an account?" for
    // anyone able to make the gateway fail — the no-account path never calls it.
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));
    SMSService.sendPasswordResetOtp.mockRejectedValueOnce(new Error('gateway down'));

    await expect(authService.requestPasswordReset(PHONE, {})).resolves.toEqual({
      cooldownSeconds: 60,
      expiresInSeconds: 300,
    });
  });
});

describe('step 1 — the number itself is the budget', () => {
  it('refuses a second code inside the cooldown', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));

    await authService.requestPasswordReset(PHONE, {});
    await expect(authService.requestPasswordReset(PHONE, {})).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(SMSService.sendPasswordResetOtp).toHaveBeenCalledTimes(1);
  });

  it('refuses past the hourly cap even after the cooldown has passed', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));

    await authService.requestPasswordReset(PHONE, {});
    const record = clearCooldown();
    record.sendCount = 5;

    await expect(authService.requestPasswordReset(PHONE, {})).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it('throttles a number with NO account exactly the same way', async () => {
    // If the unregistered path skipped the throttles, the difference in
    // behaviour would itself be the oracle step 1 exists to withhold.
    jest.spyOn(User, 'find').mockReturnValue(findResult([]));

    await authService.requestPasswordReset(PHONE, {});
    await expect(authService.requestPasswordReset(PHONE, {})).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it('lets the number through again once the hour rolls over', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));

    await authService.requestPasswordReset(PHONE, {});
    const record = PasswordReset.__store.get(PHONE);
    record.sendCount = 5;
    record.sentAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    record.windowStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await expect(authService.requestPasswordReset(PHONE, {})).resolves.toBeDefined();
    expect(PasswordReset.__store.get(PHONE).sendCount).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('step 2 — spending the code', () => {
  const seedLiveCode = async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));
    await authService.requestPasswordReset(PHONE, {});
  };

  it('rejects a wrong code and counts the attempt', async () => {
    await seedLiveCode();

    await expect(
      authService.verifyPasswordResetCode(PHONE, '999999', {})
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(PasswordReset.__store.get(PHONE).attempts).toBe(1);
  });

  it('locks out after five wrong codes', async () => {
    await seedLiveCode();

    for (let i = 0; i < 5; i++) {
      await expect(
        authService.verifyPasswordResetCode(PHONE, '999999', {})
      ).rejects.toMatchObject({ statusCode: 400 });
    }

    // The sixth is refused before the comparison — even the CORRECT code.
    await expect(
      authService.verifyPasswordResetCode(PHONE, '123456', {})
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('rejects an expired code', async () => {
    await seedLiveCode();
    PasswordReset.__store.get(PHONE).otpExpiresAt = new Date(Date.now() - 1000);

    await expect(
      authService.verifyPasswordResetCode(PHONE, '123456', {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a code for a number that never had one', async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([]));
    await authService.requestPasswordReset(PHONE, {});

    await expect(
      authService.verifyPasswordResetCode(PHONE, '123456', {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns a token and the accounts the reset will cover', async () => {
    await seedLiveCode();
    jest.spyOn(User, 'find').mockReturnValue(
      findResult([
        { isOwner: true, shop: { name: 'হিসাব ফ্যাশন' } },
        { isOwner: false, shop: { name: 'নাঈম ফিস' } },
      ])
    );

    const result = await authService.verifyPasswordResetCode(PHONE, '123456', {});

    expect(result.resetToken).toHaveLength(64);
    expect(result.expiresInSeconds).toBe(600);
    expect(result.accounts).toEqual([
      { shopName: 'হিসাব ফ্যাশন', isOwner: true },
      { shopName: 'নাঈম ফিস', isOwner: false },
    ]);
  });

  it('destroys the code, so it cannot be verified twice', async () => {
    await seedLiveCode();
    jest.spyOn(User, 'find').mockReturnValue(findResult([]));

    await authService.verifyPasswordResetCode(PHONE, '123456', {});

    await expect(
      authService.verifyPasswordResetCode(PHONE, '123456', {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('step 3 — writing the password', () => {
  const TOKEN = 'a'.repeat(64);

  const seedVerified = async () => {
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));
    await authService.requestPasswordReset(PHONE, {});
    await authService.verifyPasswordResetCode(PHONE, '123456', {});
  };

  it('updates EVERY active account on the number', async () => {
    await seedVerified();

    const owner = makeUser();
    const staff = makeUser({ isOwner: false, name: 'কর্মচারী' });
    jest.spyOn(User, 'find').mockReturnValue(findResult([owner, staff]));

    const result = await authService.resetPassword(
      { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
      {}
    );

    expect(result).toMatchObject({ accountsUpdated: 2 });
    for (const user of [owner, staff]) {
      expect(user.password).toBe('notun1234');
      // Proving control of the number IS phone verification — without this an
      // owner who never finished signup resets and is still stuck at the OTP
      // screen, which is the dead end this feature exists to open up.
      expect(user.isPhoneVerified).toBe(true);
      expect(user.save).toHaveBeenCalled();
    }
    expect(invalidateUserAuthCache).toHaveBeenCalledTimes(2);
  });

  it('never stores the new password in the reset record', async () => {
    await seedVerified();
    jest.spyOn(User, 'find').mockReturnValue(findResult([makeUser()]));

    await authService.resetPassword(
      { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
      {}
    );

    expect(PasswordReset.deleteOne).toHaveBeenCalled();
  });

  it('rejects a token that does not match', async () => {
    await seedVerified();
    jest.spyOn(User, 'find').mockReturnValue(findResult([makeUser()]));

    await expect(
      authService.resetPassword(
        { phone: PHONE, resetToken: 'b'.repeat(64), newPassword: 'notun1234' },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an expired token', async () => {
    await seedVerified();
    PasswordReset.__store.get(PHONE).resetTokenExpiresAt = new Date(Date.now() - 1000);
    jest.spyOn(User, 'find').mockReturnValue(findResult([makeUser()]));

    await expect(
      authService.resetPassword(
        { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a token that has already been spent', async () => {
    await seedVerified();
    jest.spyOn(User, 'find').mockReturnValue(findResult([makeUser()]));

    await authService.resetPassword(
      { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
      {}
    );

    await expect(
      authService.resetPassword(
        { phone: PHONE, resetToken: TOKEN, newPassword: 'onno1234' },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('kills an outstanding token when a NEW code is requested', async () => {
    await seedVerified();

    // The real owner of a recycled number starting over must invalidate the
    // token the previous holder's code produced.
    clearCooldown();
    jest.spyOn(User, 'find').mockReturnValue(findResult([{ _id: 'u1' }]));
    await authService.requestPasswordReset(PHONE, {});

    jest.spyOn(User, 'find').mockReturnValue(findResult([makeUser()]));
    await expect(
      authService.resetPassword(
        { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses, and burns the token, when every account was deactivated meanwhile', async () => {
    await seedVerified();
    jest.spyOn(User, 'find').mockReturnValue(findResult([]));

    await expect(
      authService.resetPassword(
        { phone: PHONE, resetToken: TOKEN, newPassword: 'notun1234' },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(PasswordReset.deleteOne).toHaveBeenCalled();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('changePassword no longer requires a field its client never sent', () => {
  it('accepts a payload without confirmPassword', () => {
    // This is the regression. The settings page posts exactly this shape, and
    // the schema used to 400 it into the untraceable "তথ্য যাচাই ব্যর্থ".
    const { error } = authValidation.changePassword.validate({
      currentPassword: 'purano123',
      newPassword: 'notun1234',
    });
    expect(error).toBeUndefined();
  });

  it('still catches a mismatched confirmPassword when one is sent', () => {
    const { error } = authValidation.changePassword.validate({
      currentPassword: 'purano123',
      newPassword: 'notun1234',
      confirmPassword: 'onnokichu',
    });
    expect(error).toBeDefined();
  });

  it('still enforces the minimum length', () => {
    const { error } = authValidation.changePassword.validate({
      currentPassword: 'purano123',
      newPassword: 'abc',
    });
    expect(error).toBeDefined();
  });
});

describe('reset-password validation', () => {
  it('refuses a malformed reset token before it reaches a hash comparison', () => {
    const { error } = authValidation.resetPassword.validate({
      phone: PHONE,
      resetToken: 'not-a-token',
      newPassword: 'notun1234',
    });
    expect(error).toBeDefined();
  });

  it('accepts a well-formed one', () => {
    const { error } = authValidation.resetPassword.validate({
      phone: PHONE,
      resetToken: 'a'.repeat(64),
      newPassword: 'notun1234',
    });
    expect(error).toBeUndefined();
  });
});

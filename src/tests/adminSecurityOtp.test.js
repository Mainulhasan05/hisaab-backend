/**
 * Admin password changes, gated behind an SMS code to the FOUNDER's number.
 *
 * The rule this file exists to pin down is the destination: whichever admin
 * asks, whichever account is targeted, the code goes to one fixed number. It is
 * a two-person control, and the failure mode if it ever regresses is silent and
 * total — a support admin quietly gains the ability to re-cut the key to the
 * whole platform, and nothing in the logs looks wrong.
 *
 * The throttles are pinned for a related reason: the destination being fixed is
 * exactly what makes it the ideal thing to SMS-bomb.
 */

const mockSent = [];
jest.mock('../services/sms.service', () => ({
  sendSystemSingle: jest.fn(async (args) => { mockSent.push(args); return { success: true }; }),
}));

jest.mock('../services/platformNotify.service', () => ({
  adminActivity: jest.fn(),
  failedLogin: jest.fn(),
}));

jest.mock('../models/AuditLog.model', () => ({ log: jest.fn().mockResolvedValue(null) }));

const SMSService = require('../services/sms.service');
const platformNotify = require('../services/platformNotify.service');
const Admin = require('../models/Admin.model');
const AdminSecurityChallenge = require('../models/AdminSecurityChallenge.model');
const adminSecurityService = require('../services/adminSecurity.service');
const { founderPhone, maskPhone, CHALLENGE } = require('../services/adminSecurity.service');

/**
 * A stand-in challenge document.
 *
 * Real statics (hashSecret, matchesHash, generateCode) are used throughout —
 * hashing and constant-time comparison are the parts most worth exercising, and
 * stubbing them would leave the test asserting against its own fake.
 */
function makeChallenge(overrides = {}) {
  const doc = {
    _id: 'chal1',
    admin: 'admin1',
    purpose: 'password_change',
    otpHash: null,
    otpExpiresAt: null,
    attempts: 0,
    sentAt: null,
    sendCount: 0,
    windowStartedAt: null,
    targetPhone: null,
    challengeTokenHash: null,
    challengeTokenExpiresAt: null,
    lastIp: null,
    purgeAt: new Date(Date.now() + 3600_000),
    hasLiveCode() {
      return Boolean(this.otpHash && this.otpExpiresAt && this.otpExpiresAt > new Date());
    },
    save: jest.fn(async function () { return this; }),
    ...overrides,
  };
  return doc;
}

/** An admin whose password check is scripted rather than bcrypt-backed. */
function makeAdmin(overrides = {}) {
  return {
    _id: 'admin1',
    name: 'Support Admin',
    phone: '01999999999',
    role: 'admin',
    isActive: true,
    comparePassword: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

let challenge;

beforeEach(() => {
  jest.clearAllMocks();
  mockSent.length = 0;
  challenge = makeChallenge();

  jest.spyOn(AdminSecurityChallenge, 'findOne').mockResolvedValue(challenge);
  jest.spyOn(AdminSecurityChallenge, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
});

afterEach(() => jest.restoreAllMocks());

describe('the destination rule', () => {
  it('texts the FOUNDER, not the admin who asked', async () => {
    // The admin here is 01999999999. The code must not go there.
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    const result = await adminSecurityService.requestPasswordChange({
      adminId: 'admin1',
      currentPassword: 'correct-horse',
    });

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].phone).toBe(founderPhone());
    expect(mockSent[0].phone).not.toBe(admin.phone);
    expect(result.sentTo).toBe(maskPhone(founderPhone()));
  });

  it('names the target account in the SMS body, so the founder knows what is being changed', async () => {
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    await adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' });

    expect(mockSent[0].message).toContain('Support Admin');
    expect(mockSent[0].message).toContain('01999999999');
  });

  it('masks the number in the API response — the reset endpoint is public', async () => {
    expect(maskPhone('01757995016')).toBe('017*****016');
    expect(maskPhone('01757995016')).not.toContain('7995');
  });

  it('also alerts the founder over Telegram, because SMS alone can be missed', async () => {
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    await adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' });

    expect(platformNotify.adminActivity).toHaveBeenCalledTimes(1);
    expect(platformNotify.adminActivity.mock.calls[0][0].urgent).toBe(true);
  });
});

describe('step 1 — proving the current password', () => {
  it('refuses without the current password, and counts the attempt', async () => {
    const admin = makeAdmin({ comparePassword: jest.fn().mockResolvedValue(false) });
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    await expect(
      adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'wrong' })
    ).rejects.toThrow('Current password is incorrect');

    // Nothing texted — a walk-up attacker at an unlocked console must not be
    // able to fire codes at the founder's phone.
    expect(mockSent).toHaveLength(0);
    expect(platformNotify.failedLogin).toHaveBeenCalledTimes(1);
  });
});

describe('throttles', () => {
  it('enforces the resend cooldown', async () => {
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    await adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' });
    await expect(
      adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' })
    ).rejects.toThrow(/wait \d+ seconds/);

    expect(mockSent).toHaveLength(1);
  });

  it('caps codes per hour, lower than the shop flow because the target is fixed', async () => {
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    challenge.windowStartedAt = new Date();
    challenge.sendCount = CHALLENGE.MAX_SENDS_PER_WINDOW;

    await expect(
      adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' })
    ).rejects.toThrow(/Too many codes/);

    expect(mockSent).toHaveLength(0);
  });

  it('rolls the window, so yesterday\'s three codes do not block today', async () => {
    const admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockReturnValue({ select: () => Promise.resolve(admin) });

    challenge.windowStartedAt = new Date(Date.now() - CHALLENGE.SEND_WINDOW_MS - 1000);
    challenge.sendCount = CHALLENGE.MAX_SENDS_PER_WINDOW;

    await adminSecurityService.requestPasswordChange({ adminId: 'admin1', currentPassword: 'x' });
    expect(mockSent).toHaveLength(1);
  });
});

describe('step 2 — spending the code', () => {
  /** Put a known live code on the challenge. */
  function armCode(code = '123456') {
    challenge.otpHash = AdminSecurityChallenge.hashSecret(code);
    challenge.otpExpiresAt = new Date(Date.now() + 60_000);
    challenge.attempts = 0;
    return code;
  }

  beforeEach(() => {
    jest.spyOn(Admin, 'findById').mockResolvedValue(makeAdmin());
  });

  it('trades a correct code for a single-use token and destroys the code', async () => {
    const code = armCode();

    const result = await adminSecurityService.verifyCode({
      adminId: 'admin1',
      purpose: 'password_change',
      otp: code,
    });

    expect(result.challengeToken).toHaveLength(64);
    // The code must not survive to be replayed against a second token.
    expect(challenge.otpHash).toBeNull();
    expect(challenge.challengeTokenHash).toBe(
      AdminSecurityChallenge.hashSecret(result.challengeToken)
    );
  });

  it('counts a wrong code and says how many tries are left', async () => {
    armCode('123456');

    await expect(
      adminSecurityService.verifyCode({ adminId: 'admin1', purpose: 'password_change', otp: '000000' })
    ).rejects.toThrow(/4 attempts remaining/);

    expect(challenge.attempts).toBe(1);
  });

  it('stops accepting guesses at the cap', async () => {
    armCode('123456');
    challenge.attempts = CHALLENGE.MAX_VERIFY_ATTEMPTS;

    await expect(
      adminSecurityService.verifyCode({ adminId: 'admin1', purpose: 'password_change', otp: '123456' })
    ).rejects.toThrow(/Too many incorrect attempts/);
  });

  it('rejects an expired code with the same message as a wrong one', async () => {
    challenge.otpHash = AdminSecurityChallenge.hashSecret('123456');
    challenge.otpExpiresAt = new Date(Date.now() - 1000);

    await expect(
      adminSecurityService.verifyCode({ adminId: 'admin1', purpose: 'password_change', otp: '123456' })
    ).rejects.toThrow('Invalid or expired code');
  });
});

describe('step 3 — spending the token', () => {
  let admin;

  beforeEach(() => {
    admin = makeAdmin();
    jest.spyOn(Admin, 'findById').mockResolvedValue(admin);
  });

  function armToken(token = 'a'.repeat(64)) {
    challenge.challengeTokenHash = AdminSecurityChallenge.hashSecret(token);
    challenge.challengeTokenExpiresAt = new Date(Date.now() + 60_000);
    return token;
  }

  it('writes the password, clears the lock, and burns the challenge', async () => {
    const token = armToken();
    admin.loginAttempts = 4;
    admin.lockUntil = new Date(Date.now() + 60_000);

    await adminSecurityService.changePassword({
      adminId: 'admin1',
      purpose: 'password_change',
      challengeToken: token,
      newPassword: 'a-brand-new-one',
    });

    // Assigned raw — the model's pre-save hook owns hashing and stamps
    // passwordChangedAt, which is what invalidates existing sessions.
    expect(admin.password).toBe('a-brand-new-one');
    expect(admin.loginAttempts).toBe(0);
    expect(admin.lockUntil).toBeUndefined();
    expect(AdminSecurityChallenge.deleteOne).toHaveBeenCalled();
  });

  it('sends a confirmation SMS as well as a Telegram alert', async () => {
    const token = armToken();

    await adminSecurityService.changePassword({
      adminId: 'admin1',
      purpose: 'password_change',
      challengeToken: token,
      newPassword: 'a-brand-new-one',
    });

    // Telegram may be unlinked, blocked, or on a phone the founder does not
    // have to hand. The platform password changing must never be silent.
    expect(SMSService.sendSystemSingle).toHaveBeenCalled();
    expect(mockSent[mockSent.length - 1].phone).toBe(founderPhone());
    expect(platformNotify.adminActivity).toHaveBeenCalled();
  });

  it('rejects a wrong token', async () => {
    armToken();

    await expect(
      adminSecurityService.changePassword({
        adminId: 'admin1',
        purpose: 'password_change',
        challengeToken: 'b'.repeat(64),
        newPassword: 'a-brand-new-one',
      })
    ).rejects.toThrow(/expired/);

    expect(admin.save).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const token = 'a'.repeat(64);
    challenge.challengeTokenHash = AdminSecurityChallenge.hashSecret(token);
    challenge.challengeTokenExpiresAt = new Date(Date.now() - 1000);

    await expect(
      adminSecurityService.changePassword({
        adminId: 'admin1',
        purpose: 'password_change',
        challengeToken: token,
        newPassword: 'a-brand-new-one',
      })
    ).rejects.toThrow(/expired/);
  });
});

describe('public lockout recovery', () => {
  it('answers identically for a phone with no admin account', async () => {
    jest.spyOn(Admin, 'findOne').mockResolvedValue(null);

    const result = await adminSecurityService.requestPasswordReset({ phone: '01555555555' });

    // Same shape, same masked destination — otherwise this is a public
    // "is this an admin phone?" oracle.
    expect(result.sentTo).toBe(maskPhone(founderPhone()));
    expect(result.expiresInSeconds).toBe(CHALLENGE.CODE_TTL_MS / 1000);
    // ...and nothing was actually sent.
    expect(mockSent).toHaveLength(0);
  });

  it('does send for a real admin phone', async () => {
    jest.spyOn(Admin, 'findOne').mockResolvedValue(makeAdmin());

    await adminSecurityService.requestPasswordReset({ phone: '01999999999' });

    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].phone).toBe(founderPhone());
  });
});

describe('constant-time comparison', () => {
  it('rejects a hash of the wrong length without throwing', async () => {
    // timingSafeEqual throws on a length mismatch; matchesHash must guard it.
    expect(AdminSecurityChallenge.matchesHash('123456', 'deadbeef')).toBe(false);
    expect(AdminSecurityChallenge.matchesHash(null, null)).toBe(false);
    expect(AdminSecurityChallenge.matchesHash('123456', null)).toBe(false);
  });

  it('accepts the right value', () => {
    const hash = AdminSecurityChallenge.hashSecret('123456');
    expect(AdminSecurityChallenge.matchesHash('123456', hash)).toBe(true);
    expect(AdminSecurityChallenge.matchesHash('123457', hash)).toBe(false);
  });
});

/**
 * Registration no longer pre-creates the shop-type category taxonomy.
 *
 * This was unconditional, and the scale is the argument: a grocery signup was
 * handed 85 categories, cosmetics 78, cloth 63 — before either shop had a
 * single product, and roughly eight in ten of those rows never held one. The
 * first screen after a four-step signup was a required dropdown full of names
 * the shopkeeper had not chosen and largely did not stock.
 *
 * Three things have to stay true, and each fails silently if it breaks:
 *
 *   · a new shop gets NO categories by default;
 *   · the platform setting still turns the old behaviour back on, so the
 *     rollback lever is real rather than decorative;
 *   · a FAILED settings read falls to the new behaviour, not the old one. This
 *     is the subtle one — `settings` is null when Mongo hiccups, and a
 *     `!== false` style check would read that as "seed it", quietly restoring
 *     the thing we just removed for every shop registering during an outage.
 */

// Hoisted above the require of auth.service, which destructures `seedCategories`
// at module load — a `jest.spyOn` on the seeder module would never be seen by
// the reference auth.service is already holding.
jest.mock('../seeds/categorySeeder', () => ({ seedCategories: jest.fn() }));

const mongoose = require('mongoose');
const { seedCategories } = require('../seeds/categorySeeder');
const authService = require('../services/auth.service');
const billingService = require('../services/billing.service');
const PlatformSetting = require('../models/PlatformSetting.model');
const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('../services/sms.service');
const metaCapi = require('../services/metaCapi.service');

const SHOP_ID = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();

/**
 * Everything `register` touches after the shop document, stubbed. None of it is
 * the subject here; the single question is whether `seedCategories` runs.
 */
const stubRegistration = () => {
  jest.spyOn(User, 'findOne').mockResolvedValue(null);
  jest.spyOn(authService, 'resolveDefaultVariantTypes').mockResolvedValue(['size']);
  jest.spyOn(authService, 'seedDefaultRoles').mockResolvedValue(undefined);

  jest.spyOn(Shop, 'create').mockResolvedValue({
    _id: SHOP_ID,
    save: jest.fn().mockResolvedValue(undefined),
    toJSON: () => ({ _id: SHOP_ID }),
  });

  jest.spyOn(User, 'create').mockResolvedValue({
    _id: USER_ID,
    generateOTP: () => '123456',
    generateToken: () => 'token',
    save: jest.fn().mockResolvedValue(undefined),
    toJSON: () => ({ _id: USER_ID }),
  });

  jest.spyOn(SMSService, 'sendOTP').mockResolvedValue(undefined);
  jest.spyOn(AuditLog, 'log').mockResolvedValue(undefined);
  jest.spyOn(metaCapi, 'trackSignupLead').mockReturnValue(null);
};

const register = () =>
  authService.register(
    {
      phone: '01700000000',
      password: 'secret123',
      name: 'মালিক',
      shopName: 'হিসাব ফ্যাশন',
      shopType: 'cloth',
    },
    {}
  );

beforeEach(() => {
  seedCategories.mockClear();
  stubRegistration();
});

afterEach(() => jest.restoreAllMocks());

describe('a new shop starts with an empty category list', () => {
  it('does not seed when the setting is off', async () => {
    jest.spyOn(billingService, 'getSettings').mockResolvedValue({
      autoSeedCategoriesOnSignup: false,
    });

    await register();
    expect(seedCategories).not.toHaveBeenCalled();
  });

  it('does not seed when the setting has never been written', async () => {
    // The realistic state of an existing platform document: the field simply is
    // not there yet.
    jest.spyOn(billingService, 'getSettings').mockResolvedValue({ defaultTrialDays: 14 });

    await register();
    expect(seedCategories).not.toHaveBeenCalled();
  });

  it('does not seed when the settings read FAILED', async () => {
    // `billingService.getSettings` returns null on a Mongo error. Failing toward
    // the old behaviour here would silently re-seed every shop that registers
    // during an outage — the exact thing this change removed.
    jest.spyOn(billingService, 'getSettings').mockResolvedValue(null);

    await register();
    expect(seedCategories).not.toHaveBeenCalled();
  });

  it('still registers the shop successfully with no categories', async () => {
    jest.spyOn(billingService, 'getSettings').mockResolvedValue(null);

    // Seeding was never load-bearing; nothing downstream may start depending
    // on a category existing.
    await expect(register()).resolves.toMatchObject({ otpSent: true, token: 'token' });
  });
});

describe('the rollback lever is real', () => {
  it('seeds again when an operator turns the setting on', async () => {
    jest.spyOn(billingService, 'getSettings').mockResolvedValue({
      autoSeedCategoriesOnSignup: true,
    });

    await register();
    expect(seedCategories).toHaveBeenCalledWith(SHOP_ID, 'cloth');
  });

  it('survives the seeder throwing, exactly as before', async () => {
    jest.spyOn(billingService, 'getSettings').mockResolvedValue({
      autoSeedCategoriesOnSignup: true,
    });
    seedCategories.mockRejectedValueOnce(new Error('seed blew up'));

    await expect(register()).resolves.toMatchObject({ otpSent: true });
  });
});

describe('the setting itself', () => {
  it('is declared on PlatformSetting and defaults to OFF', () => {
    const path = PlatformSetting.schema.path('autoSeedCategoriesOnSignup');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
    // The default IS the behaviour change. A `true` default would make every
    // other test in this file describe a world that does not ship.
    expect(new PlatformSetting().autoSeedCategoriesOnSignup).toBe(false);
  });
});

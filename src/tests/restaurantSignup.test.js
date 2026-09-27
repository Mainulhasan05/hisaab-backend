/**
 * Signing up as রেস্টুরেন্ট switches `features.restaurant` on; signing up as
 * anything else creates exactly the shop document it always did.
 *
 *   [R] regression — fails before this change (no such category / field).
 *   [I] invariant  — every other category is untouched; passes both ways.
 */
jest.mock('../seeds/categorySeeder', () => ({ seedCategories: jest.fn() }));

const mongoose = require('mongoose');
const authService = require('../services/auth.service');
const billingService = require('../services/billing.service');
const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const ShopCategory = require('../models/ShopCategory.model');
const AuditLog = require('../models/AuditLog.model');
const SMSService = require('../services/sms.service');
const metaCapi = require('../services/metaCapi.service');
const { signupFeatures } = require('../utils/features.util');
const { INITIAL_SHOP_CATEGORIES } = require('../seeds/shopCategorySeeder');

const SHOP_ID = new mongoose.Types.ObjectId();

const leanQuery = (value) => ({
  select: () => ({ lean: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)) }),
});

const stub = (categoryDoc) => {
  jest.spyOn(User, 'findOne').mockResolvedValue(null);
  jest.spyOn(authService, 'resolveDefaultVariantTypes').mockResolvedValue([]);
  jest.spyOn(authService, 'seedDefaultRoles').mockResolvedValue(undefined);
  jest.spyOn(authService, 'seedDefaultAccounts').mockResolvedValue(undefined);
  jest.spyOn(billingService, 'getSettings').mockResolvedValue(null);
  jest.spyOn(ShopCategory, 'findOne').mockReturnValue(leanQuery(categoryDoc));
  jest.spyOn(Shop, 'create').mockResolvedValue({
    _id: SHOP_ID, save: jest.fn().mockResolvedValue(undefined), toJSON: () => ({ _id: SHOP_ID }),
  });
  jest.spyOn(User, 'create').mockResolvedValue({
    _id: new mongoose.Types.ObjectId(), generateOTP: () => '123456', generateToken: () => 't',
    save: jest.fn().mockResolvedValue(undefined), toJSON: () => ({}),
  });
  jest.spyOn(SMSService, 'sendOTP').mockResolvedValue(undefined);
  jest.spyOn(AuditLog, 'log').mockResolvedValue(undefined);
  jest.spyOn(metaCapi, 'trackSignupLead').mockReturnValue(null);
};

const register = (shopType) => authService.register(
  { phone: '01700000000', password: 'secret123', name: 'মালিক', shopName: 'হোটেল', shopType },
  {}
);
const createdWith = () => Shop.create.mock.calls[0][0];

afterEach(() => jest.restoreAllMocks());

describe('signup', () => {
  it('[R] রেস্টুরেন্ট starts with features.restaurant on', async () => {
    stub({ defaultFeatures: ['restaurant'] });
    await register('restaurant');
    expect(createdWith().features).toEqual({ restaurant: true });
  });

  it('[R] falls back to the seed list when the DB row predates the field', async () => {
    stub({}); // lean() returns no defaultFeatures on an old document
    await register('restaurant');
    expect(createdWith().features).toEqual({ restaurant: true });
  });

  it('[I] every other category: no features key at all on the create', async () => {
    for (const cat of INITIAL_SHOP_CATEGORIES.filter((c) => c.key !== 'restaurant')) {
      jest.restoreAllMocks();
      stub({ defaultFeatures: [] });
      await register(cat.key);
      expect(createdWith()).not.toHaveProperty('features');
    }
  });

  it('[I] a failed category read registers the shop with no features, never fails', async () => {
    stub(new Error('mongo down'));
    await expect(register('restaurant')).resolves.toMatchObject({ otpSent: true });
    expect(createdWith()).not.toHaveProperty('features');
  });
});

describe('signupFeatures', () => {
  it('[R] keeps a known feature, drops unknown and storage-backed ones', () => {
    expect(signupFeatures(['restaurant', 'nope', 'productImages'])).toEqual({ restaurant: true });
  });
  it('[R] drops a feature whose prerequisite is not also listed', () => {
    expect(signupFeatures(['onlineOrders'])).toEqual({});
  });
  it('[I] empty or missing → {}', () => {
    expect(signupFeatures([])).toEqual({});
    expect(signupFeatures(undefined)).toEqual({});
  });
  it('[R] the seed list offers রেস্টুরেন্ট with the capability', () => {
    const r = INITIAL_SHOP_CATEGORIES.find((c) => c.key === 'restaurant');
    expect(r.defaultFeatures).toEqual(['restaurant']);
    for (const c of INITIAL_SHOP_CATEGORIES.filter((x) => x.key !== 'restaurant')) {
      expect(c.defaultFeatures).toBeUndefined();
    }
  });
});

/**
 * Who the public storefront serves, and who it goes dark for.
 *
 * This is the first endpoint in the system a stranger can call, so the gate is
 * asserted rather than trusted. Two different kinds of test live here and
 * AGENT_WORKFLOW.md §7.1 asks which is which:
 *
 *   INVARIANT GUARDS — the I-11 cases (a revoked grant and a retired template
 *     must keep rendering). Nothing has ever broken them; they exist because
 *     the failure is silent and catastrophic in a specific way: an admin tidies
 *     the template catalogue on a Tuesday and takes live shops offline without
 *     any signal that they did.
 *
 *   REGRESSIONS — everything in "goes dark". Each one fails if the matching
 *     guard is removed from `resolveStorefront`; verified by deleting them one
 *     at a time. A shop that stopped paying must not keep taking orders under
 *     our brand, and a shop paused for abuse must not be able to serve.
 *
 * The service is loaded with its models stubbed. This asserts the DECISION,
 * which needs no database.
 */

const mongoose = require('mongoose');

const makeLean = (result) => ({
  select: function () { return this; },
  sort: function () { return this; },
  limit: function () { return this; },
  populate: function () { return this; },
  lean: () => Promise.resolve(result),
});

jest.mock('../models/Shop.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/StorefrontTemplate.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/Product.model', () => ({
  find: jest.fn(),
  aggregate: jest.fn(() => Promise.resolve([])),
  countDocuments: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../models/Category.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Shop = require('../models/Shop.model');
const Storefront = require('../models/Storefront.model');
const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const publicService = require('../services/publicStorefront.service');

const SHOP_ID = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

/** A shop that is in every way fine, overridden per test. */
const okShop = (over = {}) => ({
  _id: SHOP_ID,
  name: 'রহিম স্টোর',
  slug: 'rahim-store',
  isActive: true,
  features: { storefront: true },
  storefront: { allowedTemplates: ['bazar'] },
  subscription: { plan: 'paid', expiresAt: new Date(Date.now() + 90 * DAY) },
  access: {},
  ...over,
});

const okStorefront = (over = {}) => ({
  shop: SHOP_ID,
  branch: null,
  status: 'live',
  pausedByAdmin: null,
  outOfStockBehaviour: 'hide',
  published: { template: 'bazar', theme: {}, blocks: {}, nav: [], seo: {} },
  delivery: { zones: [] },
  ...over,
});

const okTemplate = (over = {}) => ({
  key: 'bazar',
  status: 'published',
  slots: ['identity', 'featured'],
  themeDefaults: { primary: '#F47C20' },
  ...over,
});

/** Wire the three lookups `resolveStorefront` performs, in order. */
const wire = ({ shop = okShop(), storefront = okStorefront(), template = okTemplate() } = {}) => {
  Shop.findOne.mockReturnValue(makeLean(shop));
  Storefront.findOne.mockReturnValue(makeLean(storefront));
  StorefrontTemplate.findOne.mockReturnValue(makeLean(template));
};

const expectDark = async () => {
  await expect(publicService.resolveStorefront('rahim-store')).rejects.toMatchObject({
    statusCode: 404,
  });
};

beforeEach(() => jest.clearAllMocks());

describe('serves a healthy shop', () => {
  it('resolves shop, storefront and template', async () => {
    wire();
    const out = await publicService.resolveStorefront('rahim-store');
    expect(out.shop.slug).toBe('rahim-store');
    expect(out.storefront.status).toBe('live');
    expect(out.template.key).toBe('bazar');
  });

  it('accepts a slug in any case and trims it', async () => {
    wire();
    await expect(publicService.resolveStorefront('  RAHIM-STORE  ')).resolves.toBeTruthy();
    expect(Shop.findOne).toHaveBeenCalledWith({ slug: 'rahim-store' });
  });

  // Grace is a period the operator deliberately granted. Going dark inside it
  // would make the grant meaningless and would punish exactly the shops an
  // operator chose to be lenient with.
  it.each([
    ['active', { subscription: { plan: 'paid', expiresAt: new Date(Date.now() + 90 * DAY) } }],
    ['trial', { subscription: { plan: 'trial', expiresAt: new Date(Date.now() + 10 * DAY) } }],
    ['expiring', { subscription: { plan: 'paid', expiresAt: new Date(Date.now() + 1 * DAY) } }],
    ['grace', { subscription: { plan: 'paid', expiresAt: new Date(Date.now() - 1 * DAY), graceDays: 5 } }],
    ['no expiry at all', { subscription: { plan: 'paid' } }],
  ])('serves a shop in state: %s', async (_label, over) => {
    wire({ shop: okShop(over) });
    await expect(publicService.resolveStorefront('rahim-store')).resolves.toBeTruthy();
  });
});

describe('goes dark — REGRESSIONS', () => {
  it('unknown slug', async () => {
    wire({ shop: null });
    await expectDark();
  });

  it('shop without the storefront capability', async () => {
    wire({ shop: okShop({ features: {} }) });
    await expectDark();
  });

  // `access.blockedAt` is the manual admin lockout. It outranks billing
  // entirely — a blocked shop is blocked whatever its expiry says.
  it('shop blocked by an admin', async () => {
    wire({ shop: okShop({ access: { blockedAt: new Date() } }) });
    await expectDark();
  });

  it('shop deactivated the legacy way (isActive false)', async () => {
    wire({ shop: okShop({ isActive: false }) });
    await expectDark();
  });

  /**
   * The one that is easy to get wrong, and the reason SERVABLE_STATES exists
   * rather than a `canRead` check.
   *
   * `resolveSubscription` returns `canRead: true` for an expired shop ON
   * PURPOSE — an unpaid shop can still open its own dashboard and get its due
   * list out. Reusing that flag here would keep its PUBLIC storefront taking
   * orders, on our infrastructure and under our brand, after it stopped paying.
   */
  it('shop past expiry with no grace — even though canRead is true', async () => {
    const shop = okShop({
      subscription: { plan: 'paid', expiresAt: new Date(Date.now() - 30 * DAY), graceDays: 0 },
    });
    const { resolveSubscription } = require('../utils/subscriptionState.util');
    expect(resolveSubscription(shop).canRead).toBe(true);
    expect(publicService.SERVABLE_STATES).not.toContain('expired');

    wire({ shop });
    await expectDark();
  });

  it('shop past its granted grace window', async () => {
    wire({
      shop: okShop({
        subscription: { plan: 'paid', expiresAt: new Date(Date.now() - 30 * DAY), graceDays: 5 },
      }),
    });
    await expectDark();
  });

  it('no storefront document at all', async () => {
    wire({ storefront: null });
    await expectDark();
  });

  // The platform kill switch. Distinct from the shop's own pause, and the shop
  // cannot clear it — otherwise it is a suggestion.
  it('paused by the platform', async () => {
    wire({ storefront: okStorefront({ pausedByAdmin: new mongoose.Types.ObjectId() }) });
    await expectDark();
  });

  it('paused by the shop itself', async () => {
    wire({ storefront: okStorefront({ status: 'paused' }) });
    await expectDark();
  });

  it('never published', async () => {
    wire({ storefront: okStorefront({ status: 'unpublished' }) });
    await expectDark();
  });

  it('published payload carries no template', async () => {
    wire({ storefront: okStorefront({ published: { template: null } }) });
    await expectDark();
  });

  it('template row is missing entirely', async () => {
    wire({ template: null });
    await expectDark();
  });
});

/**
 * I-11 — INVARIANT GUARDS.
 *
 * A grant is validated when a template is APPLIED and never when one is
 * RENDERED (ECOMMERCE_PLAN.md §4.4). Both of these pass today and are here so
 * they keep passing: the whole point is that a platform-side tidy-up cannot
 * take a shop's website down.
 */
describe('I-11 · a live site keeps rendering — INVARIANT GUARDS', () => {
  it('renders after the template grant is revoked', async () => {
    wire({ shop: okShop({ storefront: { allowedTemplates: [] } }) });
    const out = await publicService.resolveStorefront('rahim-store');
    expect(out.template.key).toBe('bazar');
  });

  it('renders a template that has since been retired', async () => {
    wire({ template: okTemplate({ status: 'retired' }) });
    const out = await publicService.resolveStorefront('rahim-store');
    expect(out.template.key).toBe('bazar');
  });

  it('never asks the template query to filter on status', async () => {
    // Stated as a query assertion as well as a behavioural one: a future
    // `status: 'published'` added to this lookup would reintroduce validate-on-
    // read, and the behavioural tests above would still pass if the retired row
    // happened to be returned by a stub.
    wire();
    await publicService.resolveStorefront('rahim-store');
    expect(StorefrontTemplate.findOne).toHaveBeenCalledWith({ key: 'bazar' });
  });
});

/**
 * Every refusal is the same refusal.
 *
 * A distinguishable error turns this endpoint into an oracle: slugs become
 * enumerable, and "this shop's subscription lapsed" becomes something a
 * competitor can read off a URL. The reason belongs in the log, where support
 * can find it, and nowhere else.
 */
describe('failures are indistinguishable from outside', () => {
  const cases = [
    ['unknown slug', { shop: null }],
    ['no capability', { shop: okShop({ features: {} }) }],
    ['blocked', { shop: okShop({ access: { blockedAt: new Date() } }) }],
    ['expired', { shop: okShop({ subscription: { plan: 'paid', expiresAt: new Date(Date.now() - 30 * DAY) } }) }],
    ['admin-paused', { storefront: okStorefront({ pausedByAdmin: new mongoose.Types.ObjectId() }) }],
    ['unpublished', { storefront: okStorefront({ status: 'unpublished' }) }],
  ];

  it('returns one identical 404 for every reason', async () => {
    const seen = new Set();
    for (const [, setup] of cases) {
      wire(setup);
      try {
        await publicService.resolveStorefront('rahim-store');
        throw new Error('should not have resolved');
      } catch (err) {
        seen.add(`${err.statusCode}|${err.message}|${err.messageBn}`);
      }
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain('404');
  });

  it('says nothing about billing or moderation in the Bengali copy', async () => {
    wire({ shop: okShop({ access: { blockedAt: new Date() } }) });
    const err = await publicService.resolveStorefront('rahim-store').catch((e) => e);
    for (const leak of ['সাবস্ক্রিপশন', 'মেয়াদ', 'বন্ধ করা হয়েছে', 'কর্তৃপক্ষ', 'পেমেন্ট']) {
      expect(err.messageBn).not.toContain(leak);
    }
  });
});

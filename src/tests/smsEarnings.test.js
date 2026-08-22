/**
 * The SMS money trail, pinned.
 *
 * These rules decide what the operator is told they earned. Each one below is a
 * way of being wrong that looks perfectly plausible on a dashboard — a 100%
 * margin on money that was actually spent, revenue booked in the wrong month, or
 * a failover's extra cost quietly absorbed.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const PlatformSetting = require('../models/PlatformSetting.model');
const SMSQuota = require('../models/SMSQuota.model');
const Shop = require('../models/Shop.model');
const SmsEarning = require('../models/SmsEarning.model');
const earnings = require('../services/sms/earnings');

const SHOP = '507f1f77bcf86cd799439011';

/** Stand in for the settings document without touching Mongo. */
function withSettings(doc) {
  jest.spyOn(PlatformSetting, 'current').mockResolvedValue(doc);
}

/** Stand in for a shop's top-up history. */
function withAllocations(allocations) {
  jest.spyOn(SMSQuota, 'findOne').mockReturnValue({
    select: () => ({ lean: async () => ({ allocations }) }),
  });
}

function withShopRate(rate) {
  jest.spyOn(Shop, 'findById').mockReturnValue({
    select: () => ({ lean: async () => ({ billing: { smsUnitPrice: rate } }) }),
  });
}

let recorded;

beforeEach(() => {
  earnings.invalidate();
  recorded = [];
  jest.spyOn(SmsEarning, 'record').mockImplementation(async (entry) => {
    recorded.push(entry);
    return entry;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  earnings.invalidate();
});

describe('cost is resolved per gateway', () => {
  test('a per-provider rate beats the platform default', async () => {
    withSettings({ platformSmsCost: 0.5, smsProviderCost: { mimsms: 0.35, automas: 0.28 } });

    expect(await earnings.costRateFor('mimsms')).toBe(0.35);
    expect(await earnings.costRateFor('automas')).toBe(0.28);
  });

  test('a gateway with no rate of its own falls back to the platform default', async () => {
    withSettings({ platformSmsCost: 0.5, smsProviderCost: { mimsms: null, automas: null } });
    expect(await earnings.costRateFor('automas')).toBe(0.5);
  });

  /**
   * The number this whole design exists to avoid printing. A gateway nobody has
   * priced must report UNKNOWN, because zero would show a 100% margin on real
   * spending.
   */
  test('a gateway priced nowhere reports null, never zero', async () => {
    withSettings({ platformSmsCost: null, smsProviderCost: { mimsms: null, automas: null } });
    expect(await earnings.costRateFor('automas')).toBeNull();
  });
});

describe('revenue is the rate the shop actually paid', () => {
  /**
   * A shop that bought a discounted pack did not pay the list price, and booking
   * the list price against their traffic overstates the margin by the discount.
   */
  test('the blended rate across top-ups wins over the list price', async () => {
    withSettings({ platformSmsCost: 0.3, defaultSmsUnitPrice: 0.4, smsProviderCost: {} });
    // 1000 at ৳400 and 1000 at ৳300 → ৳700 for 2000 → ৳0.35 each.
    withAllocations([{ quantity: 1000, price: 400 }, { quantity: 1000, price: 300 }]);

    expect(await earnings.sellRateFor(SHOP)).toBeCloseTo(0.35, 5);
  });

  test('a shop with no top-ups falls back to its negotiated rate', async () => {
    withSettings({ platformSmsCost: 0.3, defaultSmsUnitPrice: 0.4, smsProviderCost: {} });
    withAllocations([]);
    withShopRate(0.32);

    expect(await earnings.sellRateFor(SHOP)).toBe(0.32);
  });

  /**
   * Platform broadcasts are sent on the platform's own account. They cost money
   * and earn none, and counting them as revenue would invent income.
   */
  test('a platform broadcast earns nothing', async () => {
    expect(await earnings.sellRateFor(null)).toBe(0);
  });
});

describe('booking a send', () => {
  test('a delivered send books both cost and revenue', async () => {
    withSettings({ platformSmsCost: null, defaultSmsUnitPrice: 0.4, smsProviderCost: { mimsms: 0.3 } });
    withAllocations([{ quantity: 1000, price: 400 }]);

    const priced = await earnings.priceAndRecord({
      shopId: SHOP, provider: 'mimsms', segments: 10,
    });

    expect(priced.unitCost).toBe(0.3);
    expect(priced.totalCost).toBeCloseTo(3, 5);   // 10 × 0.30
    expect(priced.revenue).toBeCloseTo(4, 5);     // 10 × 0.40
    expect(recorded[0]).toMatchObject({ provider: 'mimsms', segments: 10, failed: false });
  });

  /**
   * The shop is refunded for a failed send, so it earns nothing — but the
   * gateway may still have charged us. Dropping that cost would flatter the
   * margin by exactly what a bad night cost.
   */
  test('a failed send books cost but no revenue', async () => {
    withSettings({ platformSmsCost: null, defaultSmsUnitPrice: 0.4, smsProviderCost: { mimsms: 0.3 } });
    withAllocations([{ quantity: 1000, price: 400 }]);

    const priced = await earnings.priceAndRecord({
      shopId: SHOP, provider: 'mimsms', segments: 10, failed: true,
    });

    expect(priced.totalCost).toBeCloseTo(3, 5);
    expect(priced.revenue).toBe(0);
    expect(recorded[0]).toMatchObject({ failed: true, revenue: 0 });
  });

  test('an unpriced gateway books the traffic but flags it as unpriced', async () => {
    withSettings({ platformSmsCost: null, defaultSmsUnitPrice: 0.4, smsProviderCost: {} });
    withAllocations([{ quantity: 1000, price: 400 }]);

    const priced = await earnings.priceAndRecord({
      shopId: SHOP, provider: 'automas', segments: 10,
    });

    expect(priced.unpriced).toBe(true);
    expect(priced.totalCost).toBeNull();
    // The segments still count — they were really sent.
    expect(recorded[0]).toMatchObject({ segments: 10, unpriced: true, gatewayCost: 0 });
  });

  test('a failed-over send is booked against the gateway that actually carried it', async () => {
    withSettings({ platformSmsCost: null, defaultSmsUnitPrice: 0.4, smsProviderCost: { automas: 0.5 } });
    withAllocations([{ quantity: 1000, price: 400 }]);

    const priced = await earnings.priceAndRecord({
      shopId: SHOP, provider: 'automas', segments: 4, failedOver: true,
    });

    // The pricier backup's rate, not the primary's.
    expect(priced.totalCost).toBeCloseTo(2, 5);
    expect(recorded[0]).toMatchObject({ provider: 'automas', failedOver: true });
  });

  /**
   * Accounting sits downstream of delivery. A booking failure must never turn a
   * delivered message into a failed one.
   */
  test('a ledger failure does not throw', async () => {
    withSettings({ platformSmsCost: 0.3, defaultSmsUnitPrice: 0.4, smsProviderCost: {} });
    withAllocations([]);
    withShopRate(0.4);
    SmsEarning.record.mockRejectedValue(new Error('mongo down'));

    await expect(
      earnings.priceAndRecord({ shopId: SHOP, provider: 'mimsms', segments: 5 })
    ).resolves.toMatchObject({ unpriced: true, totalCost: null });
  });

  test('a zero-segment send books nothing', async () => {
    withSettings({ platformSmsCost: 0.3, smsProviderCost: {} });
    await earnings.priceAndRecord({ shopId: SHOP, provider: 'mimsms', segments: 0 });
    expect(recorded).toHaveLength(0);
  });
});

describe('period bucketing', () => {
  /**
   * Buckets are Dhaka months. A UTC-derived label moves a late-evening send in
   * Bangladesh into the previous month, which is how two reports come to
   * disagree by a few hundred taka.
   */
  test('an instant late in a Dhaka day stays in the Dhaka month', () => {
    // 2026-08-31 21:00 UTC is 2026-09-01 03:00 in Dhaka (UTC+6).
    const period = SmsEarning.periodFor(new Date('2026-08-31T21:00:00Z'));
    expect(period).toBe('2026-09');
  });

  test('an ordinary mid-month instant buckets to that month', () => {
    expect(SmsEarning.periodFor(new Date('2026-08-15T06:00:00Z'))).toBe('2026-08');
  });
});

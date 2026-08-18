/**
 * The AI message allowance: the default is 5, and it is counted PER BRANCH.
 *
 * Two requirements are pinned here, and both are the kind that decay silently:
 *
 *   1. **The default is exactly 5.** A shop with no negotiated figure and a
 *      platform with no setting must resolve to 5. There is one constant behind
 *      it, and this test is what notices if a second literal appears somewhere
 *      and starts disagreeing with it.
 *
 *   2. **The counter is per branch, not per shop.** Branch A spending its five
 *      must leave Branch B with five. Nothing else in the system would fail
 *      visibly if this regressed — the busy branch would just quietly eat the
 *      quiet one's allowance, and the quiet branch's screen would say "শেষ"
 *      with no explanation available to anyone.
 *
 * Also covered: the three-state distinction (`null` inherits, `0` means an
 * allowance of nothing, a number overrides), which is exactly the trap
 * `a || b` falls into for a deliberate zero.
 */

const { AI_DAILY_MESSAGE_LIMIT } = require('../config/constants');

// A tiny in-memory stand-in for the counter collection, keyed the way the real
// unique index is. Enough to prove the branch-scoping contract without a live
// Mongo — the atomicity of the real `reserve` is a database property and is not
// what this suite is about.
const mockStore = new Map();
const mockKeyOf = (shop, branch) => `${shop}|${branch || 'null'}`;

jest.mock('../models/ShopAiUsage.model', () => ({
  reserve: jest.fn(async (shopId, branchId, limit, dayKey) => {
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const k = mockKeyOf(shopId, branchId);
    const row = mockStore.get(k);

    if (row && row.dayKey === dayKey) {
      if (row.usedToday >= limit) return null;
      row.usedToday += 1;
      row.totalRequests += 1;
      return { ...row };
    }

    const fresh = { dayKey, usedToday: 1, totalRequests: (row?.totalRequests || 0) + 1 };
    mockStore.set(k, fresh);
    return { ...fresh };
  }),
  refund: jest.fn(async (shopId, branchId, dayKey) => {
    const row = mockStore.get(mockKeyOf(shopId, branchId));
    if (row && row.dayKey === dayKey && row.usedToday > 0) row.usedToday -= 1;
    return { modifiedCount: 1 };
  }),
  peek: jest.fn(async (shopId, branchId, dayKey) => {
    const row = mockStore.get(mockKeyOf(shopId, branchId));
    if (!row || row.dayKey !== dayKey) {
      return { usedToday: 0, dayKey, totalRequests: row?.totalRequests || 0, lastUsedAt: null };
    }
    return { ...row, lastUsedAt: null };
  }),
}));

// `current()` is the platform settings singleton. Each test decides what it
// returns — including "the read failed", which must not break a request.
const mockCurrent = jest.fn();
jest.mock('../models/PlatformSetting.model', () => ({
  current: (...args) => mockCurrent(...args),
}));

const aiQuota = require('../utils/aiQuota.util');

const SHOP = 'shop-1';
const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

const shopWith = (dailyMessageLimit) => ({
  _id: SHOP,
  ai: dailyMessageLimit === undefined ? {} : { dailyMessageLimit },
});

beforeEach(() => {
  mockStore.clear();
  mockCurrent.mockReset();
  // The common case: a settings document exists and carries the schema default.
  mockCurrent.mockResolvedValue({ defaultAiDailyMessageLimit: AI_DAILY_MESSAGE_LIMIT });
});

describe('the default allowance is 5', () => {
  test('the constant itself is 5 — this is the single source', () => {
    expect(AI_DAILY_MESSAGE_LIMIT).toBe(5);
  });

  test('a shop with no override follows the platform default', async () => {
    await expect(aiQuota.resolveDailyLimit(shopWith(null))).resolves.toBe(5);
  });

  test('a shop with no `ai` object at all still resolves to 5', async () => {
    await expect(aiQuota.resolveDailyLimit({ _id: SHOP })).resolves.toBe(5);
  });

  test('an unreadable PlatformSetting still resolves to 5, not to an error', async () => {
    // A Mongo hiccup must never be the thing that breaks a shop's request.
    mockCurrent.mockRejectedValue(new Error('mongo is down'));
    await expect(aiQuota.resolveDailyLimit(shopWith(null))).resolves.toBe(5);
  });

  test('a settings document missing the field resolves to 5', async () => {
    mockCurrent.mockResolvedValue({});
    await expect(aiQuota.resolveDailyLimit(shopWith(null))).resolves.toBe(5);
  });

  test('the sixth message in one day is refused', async () => {
    const shop = shopWith(null);
    for (let i = 1; i <= 5; i += 1) {
      const r = await aiQuota.spend(shop, BRANCH_A);
      expect(r.ok).toBe(true);
      expect(r.usedToday).toBe(i);
      expect(r.remaining).toBe(5 - i);
    }

    const sixth = await aiQuota.spend(shop, BRANCH_A);
    expect(sixth.ok).toBe(false);
    expect(sixth.remaining).toBe(0);
    expect(sixth.limit).toBe(5);
  });
});

describe('per-shop override', () => {
  test('a negotiated number wins over the platform default', async () => {
    await expect(aiQuota.resolveDailyLimit(shopWith(20))).resolves.toBe(20);
  });

  test('a raised platform default lifts every non-overridden shop', async () => {
    mockCurrent.mockResolvedValue({ defaultAiDailyMessageLimit: 12 });
    await expect(aiQuota.resolveDailyLimit(shopWith(null))).resolves.toBe(12);
    // ...and leaves the negotiated one exactly where it was.
    await expect(aiQuota.resolveDailyLimit(shopWith(3))).resolves.toBe(3);
  });

  test('a deliberate 0 means "no allowance", NOT "use the default"', async () => {
    // The trap `shop.ai?.dailyMessageLimit || platformDefault` falls into: it
    // reads a deliberate zero as unset and hands five messages a day to the one
    // shop an operator specifically switched off.
    await expect(aiQuota.resolveDailyLimit(shopWith(0))).resolves.toBe(0);

    const result = await aiQuota.spend(shopWith(0), BRANCH_A);
    expect(result.ok).toBe(false);
    expect(result.limit).toBe(0);
  });

  test('isOverridden distinguishes a typed 5 from an inherited 5', async () => {
    const inherited = await aiQuota.getUsage(shopWith(null), BRANCH_A);
    const typed = await aiQuota.getUsage(shopWith(5), BRANCH_A);

    expect(inherited.limit).toBe(5);
    expect(typed.limit).toBe(5);
    // Same number, different meaning — the panel has to be able to tell them
    // apart or "Use default" can never be offered correctly.
    expect(inherited.isOverridden).toBe(false);
    expect(typed.isOverridden).toBe(true);
  });
});

describe('the counter is per BRANCH', () => {
  test('one branch spending its allowance leaves the other untouched', async () => {
    const shop = shopWith(null);

    for (let i = 0; i < 5; i += 1) {
      expect((await aiQuota.spend(shop, BRANCH_A)).ok).toBe(true);
    }
    expect((await aiQuota.spend(shop, BRANCH_A)).ok).toBe(false);

    // Branch B has not sent anything and must still have its full five.
    const b = await aiQuota.getUsage(shop, BRANCH_B);
    expect(b.usedToday).toBe(0);
    expect(b.remaining).toBe(5);
    expect((await aiQuota.spend(shop, BRANCH_B)).ok).toBe(true);
  });

  test('a single-branch shop counts against the null branch', async () => {
    const shop = shopWith(null);
    await aiQuota.spend(shop, null);

    const usage = await aiQuota.getUsage(shop, null);
    expect(usage.usedToday).toBe(1);
    expect(usage.remaining).toBe(4);
  });

  test('the shop-wide limit applies to each branch independently', async () => {
    const shop = shopWith(2);

    expect((await aiQuota.spend(shop, BRANCH_A)).ok).toBe(true);
    expect((await aiQuota.spend(shop, BRANCH_A)).ok).toBe(true);
    expect((await aiQuota.spend(shop, BRANCH_A)).ok).toBe(false);

    // Two here as well — not a share of two across the shop.
    expect((await aiQuota.spend(shop, BRANCH_B)).ok).toBe(true);
    expect((await aiQuota.spend(shop, BRANCH_B)).ok).toBe(true);
    expect((await aiQuota.spend(shop, BRANCH_B)).ok).toBe(false);
  });
});

describe('refunds', () => {
  test('a refunded message is spendable again', async () => {
    const shop = shopWith(null);
    const first = await aiQuota.spend(shop, BRANCH_A);
    expect(first.remaining).toBe(4);

    await aiQuota.refund(shop, BRANCH_A, first.dayKey);

    const after = await aiQuota.getUsage(shop, BRANCH_A);
    expect(after.usedToday).toBe(0);
    expect(after.remaining).toBe(5);
  });

  test('a refund only ever touches the branch that was charged', async () => {
    const shop = shopWith(null);
    const a = await aiQuota.spend(shop, BRANCH_A);
    await aiQuota.spend(shop, BRANCH_B);

    await aiQuota.refund(shop, BRANCH_A, a.dayKey);

    expect((await aiQuota.getUsage(shop, BRANCH_A)).usedToday).toBe(0);
    expect((await aiQuota.getUsage(shop, BRANCH_B)).usedToday).toBe(1);
  });
});

describe('the day is Bangladesh\'s', () => {
  test('the reported dayKey is the Dhaka calendar date', async () => {
    const { getBangladeshTodayStr } = require('../utils/bdTime.util');
    const usage = await aiQuota.getUsage(shopWith(null), BRANCH_A);
    expect(usage.dayKey).toBe(getBangladeshTodayStr());
    expect(usage.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a stale dayKey reads as zero used, not as yesterday\'s spend', async () => {
    const shop = shopWith(null);
    await aiQuota.spend(shop, BRANCH_A);

    // Simulate the stored counter being from a previous day.
    mockStore.get(mockKeyOf(SHOP, BRANCH_A)).dayKey = '2020-01-01';

    const usage = await aiQuota.getUsage(shop, BRANCH_A);
    expect(usage.usedToday).toBe(0);
    expect(usage.remaining).toBe(5);
  });
});

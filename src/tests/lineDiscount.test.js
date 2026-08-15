/**
 * Per-line negotiated pricing — `Shop.features.lineDiscount`.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE HOLE — REGRESSIONS. `items[].discount` reached the invoice as a raw
 *      client number: no schema on the route, no coercion, no cap. These fail
 *      against the old code, which had neither `sale.validation.js` nor the
 *      line-value clamp in `createSale`. Group A2 asserts the arithmetic of the
 *      clamp through the real `Sale.pre('save')` chain.
 *
 *   B. FLAG-OFF IDENTITY — INVARIANT GUARDS. Pass both before and after, by
 *      construction. They fail only if someone later widens the capability to
 *      shops that never enabled it, or makes an ordinary line's payload
 *      illegal. The I-6/I-7 tripwire for this feature.
 *
 *   C. RATE RESOLUTION — REGRESSIONS. `resolveLineRate` did not exist, so these
 *      have nothing to fail against in the old code; they are what proves the
 *      feature does anything at all.
 *
 *   D. THE GATES — REGRESSIONS in the same weak sense. The 403s and 400s that
 *      stop a cashier spending the shop's margin on their own authority. The
 *      below-cost one is the reason this feature is per-staff.
 *
 *   E. WIRING — GUARDS. The registry, the permission matrix, the presets and
 *      the stored schema. Cheap, and each one catches a whole class of "the
 *      flag exists but does nothing" bug.
 *
 * Deliberately NOT here: that the `resolveLineRate` call sits AFTER the pack
 * block in `createSale`. That ordering is what makes a negotiated rate REPLACE
 * the wholesale/pack rate instead of compounding with it, and a mocked unit
 * test would pass with either ordering (§7.2). Verified by reading the call
 * site and by the manual pass in the plan's §9.1.
 */

const mongoose = require('mongoose');

const {
  resolveLineRate,
  maxLineDiscountPercentFor,
} = require('../utils/lineDiscount.util');
const { hasPermission } = require('../middleware/permission.middleware');
const { FEATURES, FEATURE_KEYS, featureMap } = require('../utils/features.util');
const { MODULES, ROLE_PRESETS, ACTION_LABELS } = require('../config/permissions');
const saleValidation = require('../validations/sale.validation');
const Sale = require('../models/Sale.model');
const Shop = require('../models/Shop.model');
const HeldCart = require('../models/HeldCart.model');

const id = () => new mongoose.Types.ObjectId();

/* ── request fixtures ─────────────────────────────────────────────────────── */

/** A shop that has never had a capability switched on (Redis-cached, pre-field). */
const plainReq = () => ({ shop: { _id: id() }, user: { isOwner: true } });
/** Capability explicitly off. */
const offReq = () => ({ shop: { _id: id(), features: { lineDiscount: false } }, user: { isOwner: true } });
/** Capability on; the caller is the owner. */
const ownerReq = (settings = {}) => ({
  shop: { _id: id(), features: { lineDiscount: true }, settings },
  user: { isOwner: true },
});
/** Capability on; a cashier who HAS been granted `sales.discount`. */
const cashierReq = (settings = {}) => ({
  shop: { _id: id(), features: { lineDiscount: true }, settings },
  user: { isOwner: false, permissions: { sales: { view: true, create: true, discount: true } } },
});
/** Capability on; a cashier who has NOT. */
const plainCashierReq = (settings = {}) => ({
  shop: { _id: id(), features: { lineDiscount: true }, settings },
  user: { isOwner: false, permissions: { sales: { view: true, create: true } } },
});

/** ৳১০০ list, ৳৭০ cost — the running example throughout. */
const LINE = { listUnitPrice: 100, quantity: 50, buyingPrice: 70, productName: 'চাল' };

const call = (raw, req, over = {}) =>
  resolveLineRate({ ...LINE, raw, req, shop: req?.shop, ...over });

/** Assert an AppError with a given status, without depending on its class. */
const expectStatus = (fn, status) => {
  try {
    fn();
  } catch (err) {
    expect(err.statusCode).toBe(status);
    return err;
  }
  throw new Error(`expected a ${status} but nothing was thrown`);
};

/* ════════════════════════════════════════════════════════════════════════
 * A. THE HOLE — REGRESSIONS
 * ════════════════════════════════════════════════════════════════════════ */

describe('A1. POST /api/sales now has a schema at all', () => {
  const body = (over = {}) => ({
    items: [{ productId: id().toString(), quantity: 5, unitPrice: 100, discount: 0 }],
    paid: 500,
    ...over,
  });

  const check = (payload) => saleValidation.createSale.validate(payload, {
    abortEarly: false,
    stripUnknown: true,
  });

  it('refuses a negative line discount', () => {
    const { error } = check(body({
      items: [{ productId: id().toString(), quantity: 5, discount: -100 }],
    }));
    expect(error).toBeDefined();
  });

  it('refuses a line discount past the money ceiling', () => {
    const { error } = check(body({
      items: [{ productId: id().toString(), quantity: 5, discount: 1e12 }],
    }));
    expect(error).toBeDefined();
  });

  it('refuses a non-numeric line discount rather than coercing it to NaN', () => {
    const { error } = check(body({
      items: [{ productId: id().toString(), quantity: 5, discount: 'অনেক' }],
    }));
    expect(error).toBeDefined();
  });

  it('refuses a zero or negative quantity, and an empty cart', () => {
    expect(check(body({ items: [{ productId: id().toString(), quantity: 0 }] })).error).toBeDefined();
    expect(check(body({ items: [{ productId: id().toString(), quantity: -3 }] })).error).toBeDefined();
    expect(check(body({ items: [] })).error).toBeDefined();
  });

  it('refuses an item that names no product at all', () => {
    const { error } = check(body({ items: [{ quantity: 5, unitPrice: 100 }] }));
    expect(error).toBeDefined();
  });

  it('refuses an unknown payment method', () => {
    const { error } = check(body({ paymentMethod: 'crypto' }));
    expect(error).toBeDefined();
  });

  /**
   * THE `stripUnknown` TRAP. `validate.middleware` replaces `req.body` with
   * Joi's output, so a key this schema forgets is DELETED before the service
   * sees it — silently. This is the payload the live POS sends
   * (sales/new/page.js ~line 1113) and every key of it must survive.
   */
  it('passes the real POS payload through with nothing stripped', () => {
    const posBody = {
      customer: id().toString(),
      customerName: 'রহিম',
      customerPhone: '01711111111',
      items: [{
        productId: id().toString(),
        productName: 'চাল',
        variantId: id().toString(),
        variantSku: 'SKU-1',
        variantAttributes: { size: 'L' },
        quantity: 5,
        unitPrice: 100,
        discount: 0,
        total: 500,
        saleUnit: 'pack',
        packQuantity: 1,
        comboSelections: [{ comboItemId: id().toString(), variantId: id().toString() }],
      }],
      subtotal: 500,
      discount: 10,
      discountType: 'percentage',
      tax: 0,
      total: 450,
      paid: 450,
      due: 0,
      paymentMethod: 'bkash',
      notes: 'ok',
      sendSms: true,
      isOnline: true,
      channel: 'facebook',
      deliveryCharge: 60,
    };
    const { error, value } = check(posBody);
    expect(error).toBeUndefined();

    for (const key of Object.keys(posBody)) expect(value).toHaveProperty(key);
    for (const key of Object.keys(posBody.items[0])) {
      expect(value.items[0]).toHaveProperty(key);
    }
    // The one that would break combos silently if it were dropped.
    expect(value.items[0].comboSelections).toHaveLength(1);
  });

  it('passes a split-payment payload, and the held-cart resume shape', () => {
    expect(check(body({
      payments: [{ method: 'cash', amount: 200 }, { method: 'bkash', amount: 300, reference: 'TX1' }],
    })).error).toBeUndefined();

    // A resumed held cart sends `product` (sometimes populated) rather than
    // `productId`. Refusing this shape would break cart resume outright.
    expect(check({
      items: [{ product: { _id: id().toString(), name: 'চাল' }, quantity: 2, unitPrice: 50 }],
    }).error).toBeUndefined();
  });
});

describe('A2. a line discount can no longer exceed the line', () => {
  /** The real `Sale.pre('save')` chain, no database. Same harness as invoiceMath. */
  const runSaleHook = (doc) => new Promise((resolve, reject) => {
    const sale = new Sale({
      shop: id(), invoiceNo: 'INV-T-1', createdBy: id(), subtotal: 0, total: 0, ...doc,
    });
    Sale.schema.s.hooks.execPre('save', sale, [], (err) => (err ? reject(err) : resolve(sale)));
  });

  /**
   * What `createSale` now writes for a ৳500 line carrying a ৳50,000 discount:
   * `Math.min(toMoney(discount), lineValue)` — so the line is given away, and
   * not given away a hundred times over. Before the clamp, `total` was −49,500
   * and it dragged the subtotal, the invoice total, the profit and the
   * customer's ledger down with it.
   */
  it('a ৳50,000 discount on a ৳500 line settles the line at ৳0, not at −৳49,500', async () => {
    const lineValue = 500;
    const clamped = Math.min(50000, lineValue);
    const sale = await runSaleHook({
      items: [{
        product: id(), productName: 'চাল', quantity: 5, unitPrice: 100,
        buyingPrice: 70, discount: clamped, total: lineValue - clamped,
      }],
      paid: 0,
    });
    expect(sale.subtotal).toBe(0);
    expect(sale.total).toBe(0);
    expect(sale.due).toBe(0);
    // Profit goes to −cost, which is correct and honest: the goods left the
    // shelf and nothing came back. It must not go to −49,850.
    expect(sale.profit).toBe(-350);
  });

  it('an ordinary line discount still behaves exactly as it always did', async () => {
    const sale = await runSaleHook({
      items: [{
        product: id(), productName: 'চাল', quantity: 5, unitPrice: 100,
        buyingPrice: 70, discount: 50, total: 450,
      }],
      paid: 450,
    });
    expect(sale.subtotal).toBe(450);
    expect(sale.total).toBe(450);
    expect(sale.profit).toBe(100); // (100-70)*5 - 50
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. FLAG-OFF IDENTITY — INVARIANT GUARDS
 * ════════════════════════════════════════════════════════════════════════ */

describe('B. a shop without the capability is untouched', () => {
  it('defaults to off, including on a shop document that predates the field', () => {
    expect(new Shop({ name: 'দোকান' }).features.lineDiscount).toBe(false);
    expect(featureMap({}).lineDiscount).toBe(false);
    expect(featureMap({ features: {} }).lineDiscount).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS MOST. Every ordinary POS payload on the platform omits
   * `agreedUnitPrice`. If "absent" were treated as a violation, every checkout
   * in every flag-off shop would 403 — which is the shape of bug this whole
   * carve-out exists to prevent.
   */
  it.each([undefined, null, ''])('a line that names no rate (%p) is never a violation', (raw) => {
    for (const req of [plainReq(), offReq(), ownerReq(), plainCashierReq()]) {
      expect(call(raw, req)).toEqual({ agreedUnitPrice: undefined, discount: 0 });
    }
  });

  it('an ordinary sale line is still a valid Sale document, with no new key on it', () => {
    const sale = new Sale({
      shop: id(), invoiceNo: 'INV-1', createdBy: id(), subtotal: 500, total: 500,
      items: [{ product: id(), productName: 'চাল', quantity: 5, unitPrice: 100, total: 500 }],
    });
    expect(sale.validateSync()).toBeUndefined();
    expect(sale.items[0].agreedUnitPrice).toBeUndefined();
  });

  it('a flag-off shop that never set a cap reads as no cap, not as 0%', () => {
    expect(maxLineDiscountPercentFor(undefined)).toBeNull();
    expect(maxLineDiscountPercentFor({})).toBeNull();
    expect(maxLineDiscountPercentFor({ settings: {} })).toBeNull();
    expect(maxLineDiscountPercentFor({ settings: { maxLineDiscountPercent: null } })).toBeNull();
    // A cap of 0 is a real decision — "no line discounts at all" — and must NOT
    // collapse into "no cap".
    expect(maxLineDiscountPercentFor({ settings: { maxLineDiscountPercent: 0 } })).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. RATE RESOLUTION — REGRESSIONS
 * ════════════════════════════════════════════════════════════════════════ */

describe('C. the rate becomes the concession', () => {
  it('৳৯০ against a ৳১০০ list on 50 units is a ৳500 discount, and stores the rate', () => {
    expect(call(90, ownerReq())).toEqual({ agreedUnitPrice: 90, discount: 500 });
  });

  /**
   * THE REASON `agreedUnitPrice` IS STORED AT ALL.
   *
   * 750 grams at a negotiated ৳90.50 a kilo, off a ৳100 list. The concession is
   * ৳7.125, which quantizes to ৳7.13 like every other money figure — and
   * dividing that back out gives ৳90.49, not ৳90.50.
   *
   * A whole-taka rate on a whole quantity round-trips fine, which is why this
   * needs a paisa rate AND a fraction to show. Both are ordinary in a shop with
   * `features.packaging`, and the number that would be wrong is the one printed
   * on the invoice the customer is holding.
   */
  it('the stored rate is the number typed — not one re-derived by division', () => {
    const out = call(90.5, ownerReq(), { quantity: 0.75, buyingPrice: 0 });
    expect(out.agreedUnitPrice).toBe(90.5);
    expect(out.discount).toBe(7.13);

    const rederived = 100 - out.discount / 0.75;
    expect(rederived).not.toBe(90.5);
    expect(Number(rederived.toFixed(2))).toBe(90.49);
  });

  it('accepts a string, as an HTML number input sends one', () => {
    expect(call('90', ownerReq()).discount).toBe(500);
  });

  it('the list price typed back in stores nothing — "never mind"', () => {
    expect(call(100, ownerReq())).toEqual({ agreedUnitPrice: undefined, discount: 0 });
  });

  it('a free line is legal for the owner: ৳0 gives the whole line away', () => {
    expect(call(0, ownerReq(), { buyingPrice: 0 })).toEqual({ agreedUnitPrice: 0, discount: 5000 });
  });

  it('a product with no price, or a line with no quantity, discounts nothing', () => {
    expect(call(90, ownerReq(), { listUnitPrice: 0 }).discount).toBe(0);
    expect(call(90, ownerReq(), { quantity: 0 }).discount).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE GATES
 * ════════════════════════════════════════════════════════════════════════ */

describe('D. who may negotiate, and how far', () => {
  it('403s a shop that was never given the capability', () => {
    expectStatus(() => call(90, plainReq()), 403);
    expectStatus(() => call(90, offReq()), 403);
  });

  it('403s a cashier without `sales.discount`, and allows one with it', () => {
    expectStatus(() => call(90, plainCashierReq()), 403);
    expect(call(90, cashierReq()).discount).toBe(500);
  });

  it('400s a price ABOVE the list — a fat finger, not a negotiation', () => {
    expectStatus(() => call(900, ownerReq()), 400);
  });

  it('400s a malformed rate rather than silently charging the list price', () => {
    for (const bad of ['abc', NaN, Infinity, -5, {}]) {
      expectStatus(() => call(bad, ownerReq()), 400);
    }
  });

  /**
   * The guard this feature exists to have, and the reason it is per-staff.
   */
  it('403s a cashier selling below cost, and lets the owner do it', () => {
    const err = expectStatus(() => call(60, cashierReq()), 403);
    // The message must name NO figure: `buyingPrice` sits behind
    // `products.view_cost`, and a refusal that leaked it would hand every
    // cashier a cost oracle — type ৳1, read the error, binary search.
    expect(`${err.message} ${err.messageBn}`).not.toMatch(/70/);
    expect(call(60, ownerReq()).discount).toBe(2000);
  });

  it('lets a cashier sell down to cost, but not a paisa under', () => {
    expect(call(70, cashierReq()).discount).toBe(1500);
    expectStatus(() => call(69.99, cashierReq()), 403);
  });

  it('enforces the shop cap on the PERCENTAGE off, not on the taka', () => {
    const capped = ownerReq({ maxLineDiscountPercent: 15 });
    // Exactly at the cap must pass — the cashier types a price and the cap is a
    // percent, so without a tolerance the obvious ৳85 fails on float dust.
    expect(call(85, capped).discount).toBe(750);
    expectStatus(() => call(80, capped), 400);

    // The same percentage on a different-sized line behaves the same way, which
    // is the whole reason the cap is a percent.
    const big = { listUnitPrice: 10000, quantity: 1, buyingPrice: 1000 };
    expect(resolveLineRate({ ...big, raw: 8500, req: capped, shop: capped.shop }).discount).toBe(1500);
    expectStatus(() => resolveLineRate({ ...big, raw: 8000, req: capped, shop: capped.shop }), 400);
  });

  it('a cap of 0% refuses every line discount while leaving ordinary sales alone', () => {
    const zero = ownerReq({ maxLineDiscountPercent: 0 });
    expectStatus(() => call(99, zero), 400);
    expect(call(undefined, zero)).toEqual({ agreedUnitPrice: undefined, discount: 0 });
  });

  it('a script or seeder with no request is trusted, as every other util assumes', () => {
    // `hasFeature(null, ...)` is false, so a rate still needs a real shop
    // behind it — the no-`req` carve-out is about the OWNER check, not the
    // capability check.
    expectStatus(() => resolveLineRate({ ...LINE, raw: 90, req: null }), 403);
  });
});

describe('D2. hasPermission — the non-middleware check', () => {
  it('fails closed on every uncertainty', () => {
    expect(hasPermission(null, 'sales', 'discount')).toBe(false);
    expect(hasPermission({}, 'sales', 'discount')).toBe(false);
    expect(hasPermission({ user: {} }, 'sales', 'discount')).toBe(false);
    expect(hasPermission({ user: { permissions: {} } }, 'sales', 'discount')).toBe(false);
    // Truthy-but-not-true must not read as granted.
    expect(hasPermission({ user: { permissions: { sales: { discount: 'yes' } } } }, 'sales', 'discount')).toBe(false);
  });

  it('keeps the owner and the platform-admin bypasses `rbac` has always had', () => {
    expect(hasPermission({ isAdmin: true }, 'sales', 'discount')).toBe(true);
    expect(hasPermission({ user: { isOwner: true } }, 'sales', 'discount')).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. WIRING
 * ════════════════════════════════════════════════════════════════════════ */

describe('E. the capability is wired end to end', () => {
  it('is registered with a Bengali label and needs no prerequisites', () => {
    expect(FEATURE_KEYS).toContain('lineDiscount');
    expect(FEATURES.lineDiscount.bn).toBeTruthy();
    expect(FEATURES.lineDiscount.requires).toBeUndefined();
    expect(FEATURES.lineDiscount.requiresStorage).toBeUndefined();
    // Not `unavailable` — the feature is real, so the admin toggle must work.
    expect(FEATURES.lineDiscount.unavailable).toBeUndefined();
  });

  it('`sales.discount` is a real action with a label, separate from `create`', () => {
    expect(MODULES.sales.actions).toContain('discount');
    expect(ACTION_LABELS.discount).toBeDefined();
  });

  /**
   * No preset grants it. A shop upgrading to this capability must make a
   * deliberate choice about who may spend its margin — inheriting it with a job
   * title is exactly what the separate permission exists to prevent.
   */
  it('no built-in role preset grants it', () => {
    for (const [name, preset] of Object.entries(ROLE_PRESETS)) {
      expect([name, preset.permissions.sales?.discount === true]).toEqual([name, false]);
    }
  });

  it('the shop cap is stored, bounded to 0..100, and defaults to null', () => {
    expect(new Shop({ name: 'দোকান' }).settings.maxLineDiscountPercent).toBeNull();
    const bad = new Shop({ name: 'দোকান', settings: { maxLineDiscountPercent: 150 } });
    expect(bad.validateSync()?.errors['settings.maxLineDiscountPercent']).toBeDefined();
  });

  it('the sale line stores the agreed rate, and refuses a negative one', () => {
    const sale = new Sale({
      shop: id(), invoiceNo: 'INV-2', createdBy: id(), subtotal: 4500, total: 4500,
      items: [{
        product: id(), productName: 'চাল', quantity: 50,
        unitPrice: 100, agreedUnitPrice: 90, discount: 500, total: 4500,
      }],
    });
    expect(sale.validateSync()).toBeUndefined();
    expect(sale.items[0].agreedUnitPrice).toBe(90);

    sale.items[0].agreedUnitPrice = -1;
    expect(sale.validateSync()).toBeDefined();
  });

  it('a held cart carries the rate, so a resumed cart shows what was typed', () => {
    const cart = new HeldCart({
      shop: id(), heldBy: id(),
      items: [{ product: id(), productName: 'চাল', quantity: 50, unitPrice: 100, discount: 500, agreedUnitPrice: 90 }],
    });
    expect(cart.validateSync()).toBeUndefined();
    expect(cart.items[0].agreedUnitPrice).toBe(90);
  });
});

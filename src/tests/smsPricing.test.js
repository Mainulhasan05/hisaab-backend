/**
 * The SMS price list, pinned.
 *
 * `PlatformSetting.smsTiers` existed for months with no reader: the admin
 * panel priced its packs from a hard-coded array instead, so the stored ladder
 * and the displayed one disagreed (100 SMS read ৳40 on screen against ৳50 in
 * the database) and two of the stored packs were unreachable. Now that the
 * panel reads the setting, the shape of that setting is load-bearing.
 *
 * The validator is what stands between an operator's typo and a pack the panel
 * renders as free or as an unsellable duplicate — Mongoose would store both
 * without complaint.
 */

const PlatformSetting = require('../models/PlatformSetting.model');

/**
 * Reach the validator the same way a request does.
 *
 * The controller exports handlers, not the helper, so the helper is exercised
 * through the exported PATCH handler with a fake res — which also pins that a
 * bad ladder is refused with a 400 rather than half-saved.
 */
const billingController = require('../controllers/billing.controller');

const runUpdate = async (body) => {
  const req = { body, admin: { _id: 'admin1' } };
  const res = {};
  let error = null;
  // `asyncHandler` forwards a thrown AppError to next().
  await billingController.updatePlatformSettings(req, res, (err) => {
    error = err;
  });
  return error;
};

describe('SMS tier defaults', () => {
  const defaults = PlatformSetting.schema.path('smsTiers').defaultValue();

  it('gets cheaper per SMS as the pack gets bigger', () => {
    // Otherwise the ladder is a quantity picker wearing a pricing costume, and
    // a shop has no reason to buy anything beyond the smallest pack that covers
    // the month. The previous default priced five of its six rungs at exactly
    // ৳0.40, which made its "Best value" badge untrue.
    const rates = defaults.map((t) => t.price / t.quantity);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThan(rates[i - 1]);
    }
  });

  it('is ordered by quantity', () => {
    const quantities = defaults.map((t) => t.quantity);
    expect([...quantities].sort((a, b) => a - b)).toEqual(quantities);
  });

  it('anchors the standard rate at a real rung', () => {
    // `defaultSmsUnitPrice` is what a new shop starts on and what the allocation
    // sheet falls back to. If no pack is priced at it, "the standard rate" means
    // nothing on the one screen that quotes it.
    const standard = PlatformSetting.schema.path('defaultSmsUnitPrice').defaultValue;
    const rates = defaults.map((t) => Number((t.price / t.quantity).toFixed(2)));
    expect(rates).toContain(standard);
  });

  it('leaves the gateway cost unset rather than zero', () => {
    // `0` would read as "messages are free" and show every top-up at a 100%
    // margin. Unset is the honest state until an operator says otherwise.
    expect(PlatformSetting.schema.path('platformSmsCost').defaultValue).toBeNull();
  });
});

describe('tier validation', () => {
  it('refuses two packs of the same size', async () => {
    // Renders as two tiles the operator cannot tell apart.
    const err = await runUpdate({ smsTiers: [
      { quantity: 100, price: 55 },
      { quantity: 100, price: 60 },
    ] });
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/100/);
  });

  it('refuses a pack with no quantity', async () => {
    const err = await runUpdate({ smsTiers: [{ quantity: 0, price: 55 }] });
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
  });

  it('refuses a negative price', async () => {
    const err = await runUpdate({ smsTiers: [{ quantity: 100, price: -5 }] });
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
  });

  it('refuses a ladder that is not a list', async () => {
    const err = await runUpdate({ smsTiers: 'cheap' });
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(400);
  });
});

describe('allocation arithmetic', () => {
  /**
   * The panel's own sums, reproduced.
   *
   * The bug this pins: the sheet used `Math.round(quantity × rate)` for the
   * price and then re-derived the unit rate as `price / quantity`. At a
   * negotiated ৳0.33, 250 SMS became ৳83 and the rate frozen onto the ledger
   * row came back as 0.332 — a figure nobody agreed to, in the one field whose
   * entire purpose is recording what was agreed.
   */
  const priceAt = (quantity, rate) => Number((quantity * rate).toFixed(2));
  const rateOf = (price, quantity) => Number((price / quantity).toFixed(3));

  it('round-trips a negotiated rate without drift', () => {
    expect(priceAt(250, 0.33)).toBe(82.5);
    expect(rateOf(priceAt(250, 0.33), 250)).toBe(0.33);
  });

  it('round-trips the standard rate', () => {
    expect(priceAt(1000, 0.4)).toBe(400);
    expect(rateOf(400, 1000)).toBe(0.4);
  });

  it('derives a list-priced pack rate that differs from the standard rate', () => {
    // A 100-pack at ৳55 is ৳0.55/SMS, deliberately above the ৳0.40 anchor. The
    // allocation must record 0.55, not the shop's standing rate.
    expect(rateOf(55, 100)).toBe(0.55);
  });
});

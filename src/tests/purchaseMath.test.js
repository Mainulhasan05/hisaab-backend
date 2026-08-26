/**
 * What a delivery cost — the allocation of discount and ভাড়া onto its lines.
 *
 * `costing.util` blends `Product.buyingPrice` from whatever a purchase line
 * says the goods cost, and `Sale.profit` reads that number. So the arithmetic
 * in `purchaseMath.util` is not a display concern: an error here becomes a
 * wrong margin on every product in the delivery, permanently, with nothing in
 * any log to say so. The moving average is never recomputed from source.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE NO-OP PATH — INVARIANT GUARD (I-1). Every purchase every shop has
 *      ever recorded carries no discount and no ভাড়া. All of them must come
 *      out with `landedUnitPrice === unitPrice` EXACTLY — not to within a
 *      paisa — so `Product.buyingPrice` is bit-identical to what it would have
 *      been before this file existed. These pass by construction; they are the
 *      tripwire that stops a later "simplification" from routing the untouched
 *      case through the division.
 *
 *   B. THE ALLOCATOR. `Σ shares === charge`, exactly, on every basis. The
 *      remainder is the whole point: a stray paisa here compounds into the cost
 *      basis on every delivery forever.
 *
 *   C. LANDED COST. Freight raises it, discount lowers it, and the spread is by
 *      VALUE — a sack of rice and a sachet of shampoo do not carry the same
 *      share of the truck.
 *
 *   D. THE INVOICE FIGURES. Including the one place this deliberately differs
 *      from `Sale`: a percentage discount resolves against merchandise, not
 *      against the list column.
 *
 *   E. HOSTILE AND DEGENERATE INPUT. Nothing throws; a malformed figure records
 *      the delivery at the billed rate rather than refusing to record it.
 */

const { _prorate, computePurchaseTotals } = require('../utils/purchaseMath.util');

/** Σ, quantized the way the util quantizes, so comparisons are like-for-like. */
const sum = (nums) => Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;

/* ════════════════════════════════════════════════════════════════════════
 * A. THE NO-OP PATH — INVARIANT GUARD (I-1)
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. no discount, no ভাড়া — nothing may move', () => {
  const plain = () => computePurchaseTotals({
    lines: [
      { quantity: 10, unitPrice: 150 },
      { quantity: 4, unitPrice: 1250.5 },
    ],
  });

  test('landedUnitPrice is the billed rate, identically', () => {
    const out = plain();
    expect(out.lines[0].landedUnitPrice).toBe(150);
    expect(out.lines[1].landedUnitPrice).toBe(1250.5);
  });

  test('a rate that does not survive a round trip still comes back exact', () => {
    // THE reason the untouched case is an assignment and not arithmetic.
    // 12.5 × 33.33 quantizes to ৳416.63, and 416.63 ÷ 12.5 is 33.3304 — so
    // recomputing the rate from the line total would move `buyingPrice` on a
    // delivery where the shopkeeper changed nothing at all.
    const out = computePurchaseTotals({ lines: [{ quantity: 12.5, unitPrice: 33.33 }] });
    expect(out.lines[0].landedUnitPrice).toBe(33.33);
    expect(out.lines[0].landedTotal / 12.5).not.toBe(33.33);
  });

  test('the invoice figures are the bill, untouched', () => {
    const out = plain();
    expect(out.subtotal).toBe(6502);
    expect(out.itemDiscount).toBe(0);
    expect(out.discountAmount).toBe(0);
    expect(out.freightCharge).toBe(0);
    expect(out.otherCharge).toBe(0);
    expect(out.totalAmount).toBe(6502);
  });

  test('every share is zero, so nothing is written that was not written before', () => {
    const out = plain();
    for (const line of out.lines) {
      expect(line.discountShare).toBe(0);
      expect(line.chargeShare).toBe(0);
      expect(line.lineDiscount).toBe(0);
    }
  });

  test('line.total stays the billed figure', () => {
    const out = plain();
    expect(out.lines[0].total).toBe(1500);
    expect(out.lines[1].total).toBe(5002);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. THE ALLOCATOR
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. _prorate splits a charge to the paisa', () => {
  test('clean division splits by weight', () => {
    expect(_prorate([100, 200, 300], 6000)).toEqual([1000, 2000, 3000]);
  });

  test('a rounding shortfall is settled, not dropped', () => {
    // 10 ÷ 3 rounds to 3.33 three times = 9.99. The missing paisa must land
    // somewhere or the cost basis absorbs the loss.
    const shares = _prorate([1, 1, 1], 10);
    expect(sum(shares)).toBe(10);
  });

  test('a rounding excess is settled too', () => {
    // 20 ÷ 3 rounds UP to 6.67 three times = 20.01. The remainder is negative.
    const shares = _prorate([1, 1, 1], 20);
    expect(sum(shares)).toBe(20);
  });

  test('the remainder lands on the largest line, not the first', () => {
    // 0.14 + 0.71 + 0.14 = 0.99. The odd paisa goes to index 1, which is the
    // only line big enough to absorb it without distorting.
    expect(_prorate([1, 5, 1], 1)).toEqual([0.14, 0.72, 0.14]);
  });

  test.each([
    [[3, 7], 100],
    [[1, 1, 1, 1, 1, 1, 1], 1000],
    [[0.5, 0.25, 0.25], 33.33],
    [[12345, 1, 1], 6000],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 999.99],
  ])('Σ shares === charge for %j / ৳%s', (weights, charge) => {
    expect(sum(_prorate(weights, charge))).toBe(charge);
  });

  test('no signal in the weights returns null, never zeros', () => {
    // Null is the caller's cue to try another basis. Zeros would silently drop
    // a ৳6,000 freight bill on the floor and leave the cost basis wrong.
    expect(_prorate([0, 0, 0], 500)).toBeNull();
    expect(_prorate([], 500)).toBeNull();
    expect(_prorate(null, 500)).toBeNull();
  });

  test('negative weights read as zero rather than inverting the split', () => {
    expect(_prorate([-100, 100], 50)).toEqual([0, 50]);
  });

  test('a zero charge allocates zeros without touching the weights', () => {
    expect(_prorate([1, 2, 3], 0)).toEqual([0, 0, 0]);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. LANDED COST
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. what the goods actually cost', () => {
  test('ভাড়া is spread by value, not by piece', () => {
    // Two lines of equal value, wildly unequal count: 100 units at ৳10 and
    // 10 units at ৳100. Each carries ৳100 of the ৳200 freight — so the cheap
    // line gains ৳1 a unit and the dear line gains ৳10 a unit.
    const out = computePurchaseTotals({
      lines: [
        { quantity: 100, unitPrice: 10 },
        { quantity: 10, unitPrice: 100 },
      ],
      freightCharge: 200,
    });

    expect(out.lines[0].chargeShare).toBe(100);
    expect(out.lines[1].chargeShare).toBe(100);
    expect(out.lines[0].landedUnitPrice).toBe(11);
    expect(out.lines[1].landedUnitPrice).toBe(110);
  });

  test('a supplier discount lowers the cost basis', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 100, unitPrice: 10 }],
      discount: 100,
      discountType: 'fixed',
    });

    expect(out.lines[0].discountShare).toBe(100);
    expect(out.lines[0].landedUnitPrice).toBe(9);
    // …while the bill still says ৳10 a unit and ৳1,000 for the line.
    expect(out.lines[0].unitPrice).toBe(10);
    expect(out.lines[0].total).toBe(1000);
  });

  test('a line concession only moves its own line', () => {
    const out = computePurchaseTotals({
      lines: [
        { quantity: 10, unitPrice: 100, lineDiscount: 200 },
        { quantity: 10, unitPrice: 100 },
      ],
    });

    expect(out.lines[0].landedUnitPrice).toBe(80);
    expect(out.lines[1].landedUnitPrice).toBe(100);
  });

  test('freight and unloading both reach the shelf', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 10, unitPrice: 100 }],
      freightCharge: 60,
      otherCharge: 40,
    });

    expect(out.lines[0].chargeShare).toBe(100);
    expect(out.lines[0].landedUnitPrice).toBe(110);
  });

  test('a free consignment that cost money to unload falls back to quantity', () => {
    // No value to weight by. Dividing by a zero total would write NaN onto
    // every product in the delivery; by-quantity is the answer that exists.
    const out = computePurchaseTotals({
      lines: [
        { quantity: 100, unitPrice: 0 },
        { quantity: 300, unitPrice: 0 },
      ],
      otherCharge: 400,
    });

    expect(out.lines[0].chargeShare).toBe(100);
    expect(out.lines[1].chargeShare).toBe(300);
    expect(out.lines[0].landedUnitPrice).toBe(1);
    expect(out.lines[1].landedUnitPrice).toBe(1);
  });

  test('the shares reconcile exactly against the invoice figures', () => {
    // The identity that keeps the cost basis from drifting. Deliberately messy
    // numbers: three lines, a line concession, a percentage discount and an
    // odd freight bill.
    const out = computePurchaseTotals({
      lines: [
        { quantity: 7, unitPrice: 333.33 },
        { quantity: 13, unitPrice: 77.7, lineDiscount: 101 },
        { quantity: 1, unitPrice: 4999.99 },
      ],
      discount: 7,
      discountType: 'percentage',
      freightCharge: 1333.33,
      otherCharge: 66.67,
    });

    expect(sum(out.lines.map((l) => l.discountShare))).toBe(out.discountAmount);
    expect(sum(out.lines.map((l) => l.chargeShare))).toBe(1400);
    expect(sum(out.lines.map((l) => l.total))).toBe(out.subtotal);
  });

  test('landed cost never goes negative', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 10, unitPrice: 100 }],
      discount: 100,
      discountType: 'percentage',
    });

    expect(out.lines[0].landedTotal).toBe(0);
    expect(out.lines[0].landedUnitPrice).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE INVOICE FIGURES
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. the foot of the bill', () => {
  const bill = (over = {}) => computePurchaseTotals({
    lines: [
      { quantity: 10, unitPrice: 100 },
      { quantity: 10, unitPrice: 100, lineDiscount: 200 },
    ],
    ...over,
  });

  test('subtotal is the list column, before any concession', () => {
    expect(bill().subtotal).toBe(2000);
    expect(bill().itemDiscount).toBe(200);
    expect(bill().merchandise).toBe(1800);
  });

  test('a percentage discount resolves against merchandise, not the list column', () => {
    // THE deliberate difference from `Sale`. On a supplier's bill the line
    // concessions are struck off before the trade discount is applied to the
    // foot, so 10% here is ৳180 — not the ৳200 a sale would compute.
    expect(bill({ discount: 10, discountType: 'percentage' }).discountAmount).toBe(180);
  });

  test('a fixed discount cannot exceed the goods', () => {
    expect(bill({ discount: 99999, discountType: 'fixed' }).discountAmount).toBe(1800);
    expect(bill({ discount: 99999, discountType: 'fixed' }).totalAmount).toBe(0);
  });

  test('totalAmount is merchandise less discount plus the charges', () => {
    const out = bill({ discount: 300, discountType: 'fixed', freightCharge: 500, otherCharge: 25 });
    expect(out.totalAmount).toBe(2025);
  });

  test('paid is clamped to the bill and due follows', () => {
    const out = bill({ paid: 99999 });
    expect(out.paid).toBe(1800);
    expect(out.due).toBe(0);
  });

  test('a part payment leaves the rest owing', () => {
    const out = bill({ paid: 500 });
    expect(out.paid).toBe(500);
    expect(out.due).toBe(1300);
  });

  test('nothing paid owes the whole bill', () => {
    expect(bill().due).toBe(1800);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * E. HOSTILE AND DEGENERATE INPUT
 * ════════════════════════════════════════════════════════════════════════ */
describe('E. nothing throws', () => {
  test.each([
    ['no argument', undefined],
    ['empty object', {}],
    ['lines not an array', { lines: 'rice' }],
    ['lines empty', { lines: [] }],
  ])('%s returns zeroed totals', (_label, input) => {
    const out = computePurchaseTotals(input);
    expect(out.subtotal).toBe(0);
    expect(out.totalAmount).toBe(0);
    expect(out.due).toBe(0);
    expect(out.lines).toEqual([]);
  });

  test('a charge with no lines is still owed, even though it lands nowhere', () => {
    // Unreachable through the API — `Purchase.items` requires at least one
    // entry — but reachable from a script, and the honest answer matters:
    // ৳500 left the shop. Zeroing the total would lose real money to make an
    // edge case tidy. It reaches no cost basis, which is correct and is the
    // only thing that could have gone wrong here.
    const out = computePurchaseTotals({ freightCharge: 500 });
    expect(out.subtotal).toBe(0);
    expect(out.totalAmount).toBe(500);
    expect(out.due).toBe(500);
    expect(out.lines).toEqual([]);
  });

  test.each([
    ['a string rate', 'abc'],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative', -50],
  ])('%s reads as a zero rate rather than throwing', (_label, unitPrice) => {
    const out = computePurchaseTotals({ lines: [{ quantity: 10, unitPrice }] });
    expect(out.lines[0].unitPrice).toBe(0);
    expect(out.lines[0].total).toBe(0);
  });

  test('a negative quantity records nothing rather than a credit', () => {
    const out = computePurchaseTotals({ lines: [{ quantity: -10, unitPrice: 100 }] });
    expect(out.lines[0].quantity).toBe(0);
    expect(out.lines[0].total).toBe(0);
  });

  test('a concession bigger than its line is clamped to the line', () => {
    // A ৳200 discount typed onto a ৳150 line. Left alone it drives the line
    // negative and inverts the allocation weight beside it.
    const out = computePurchaseTotals({
      lines: [{ quantity: 1, unitPrice: 150, lineDiscount: 200 }],
    });
    expect(out.lines[0].lineDiscount).toBe(150);
    expect(out.lines[0].landedTotal).toBe(0);
  });

  test('a malformed freight figure records the delivery at the billed rate', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 10, unitPrice: 100 }],
      freightCharge: 'lots',
    });
    expect(out.freightCharge).toBe(0);
    expect(out.lines[0].landedUnitPrice).toBe(100);
  });

  test('a fat-fingered amount is bounded, not propagated', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 1, unitPrice: 1e30 }],
    });
    expect(out.totalAmount).toBeLessThanOrEqual(1e11);
    expect(Number.isFinite(out.totalAmount)).toBe(true);
  });

  test('a single line takes the whole charge', () => {
    const out = computePurchaseTotals({
      lines: [{ quantity: 3, unitPrice: 100 }],
      freightCharge: 999.99,
    });
    expect(out.lines[0].chargeShare).toBe(999.99);
  });
});

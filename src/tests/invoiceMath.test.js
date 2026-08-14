/**
 * Invoice arithmetic — the money invariants.
 *
 * Every test here fails against the code as it was. They are grouped by the gap
 * each one closes, because the failures they catch are silent: an invoice and a
 * customer ledger that disagree do not throw, they just quietly stop adding up,
 * and the shop finds out at stock-take or never.
 *
 *   A. ONE DEFINITION — the service and the model hook must agree, always.
 *   B. PAISA — no invoice figure may carry float dust.
 *   C. BOUNDS — no input may push a figure past what it means.
 *   D. THE DRAWER — split-payment legs must not overstate what is in the till.
 */

const mongoose = require('mongoose');
const {
  toMoney,
  discountAmountFor,
  computeInvoiceTotals,
  clampPaymentLegs,
  statusFor,
  MAX_INVOICE_AMOUNT,
} = require('../utils/invoiceMath.util');
const Sale = require('../models/Sale.model');

/**
 * Run a payload through the real `Sale.pre('save')` chain, without a database.
 *
 * `execPre` runs every pre-save hook in registration order — which includes
 * Mongoose's own validation pass — so this exercises the document exactly as a
 * real `save()` would, and asserts against the same numbers a stored invoice
 * carries. That is what makes group A meaningful: it compares the model's answer
 * with `computeInvoiceTotals`, not with a re-implementation of it.
 *
 * `subtotal` and `total` are seeded because both are `required` and validation
 * runs first; the hook overwrites them, exactly as it does for `createSale`,
 * which also passes its own working figures in.
 */
function runSaleHook(doc) {
  const sale = new Sale({
    shop: new mongoose.Types.ObjectId(),
    invoiceNo: 'INV-TEST-0001',
    createdBy: new mongoose.Types.ObjectId(),
    subtotal: 0,
    total: 0,
    ...doc,
  });

  return new Promise((resolve, reject) => {
    Sale.schema.s.hooks.execPre('save', sale, [], (err) => (err ? reject(err) : resolve(sale)));
  });
}

const line = (over = {}) => ({
  product: new mongoose.Types.ObjectId(),
  productName: 'চাল',
  quantity: 1,
  unitPrice: 100,
  buyingPrice: 70,
  discount: 0,
  total: 100,
  ...over,
});

/* ════════════════════════════════════════════════════════════════════════
 * A. ONE DEFINITION — the service and the hook cannot disagree
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. the service and the model hook agree', () => {
  test('an overpayment is clamped to the total on BOTH sides', async () => {
    // The cashier keys the tendered ৳500 on a ৳420 bill. The hook always
    // clamped; the service did not, and credited the customer the ৳80 change.
    const totals = computeInvoiceTotals({ subtotal: 420, paid: 500 });
    expect(totals.paid).toBe(420);
    expect(totals.due).toBe(0);

    const sale = await runSaleHook({
      items: [line({ unitPrice: 420, total: 420 })],
      paid: 500,
    });
    expect(sale.paid).toBe(totals.paid);
    expect(sale.total).toBe(totals.total);
    expect(sale.due).toBe(totals.due);
  });

  test('a percentage discount above 100 cannot drive the total negative', async () => {
    const totals = computeInvoiceTotals({ subtotal: 1000, discount: 150, discountType: 'percentage' });
    expect(totals.discountAmount).toBe(1000);
    expect(totals.total).toBe(0);

    const sale = await runSaleHook({
      items: [line({ unitPrice: 1000, total: 1000 })],
      discount: 150,
      discountType: 'percentage',
    });
    expect(sale.total).toBe(0);
    // The service used to hand a NEGATIVE total to `customer.totalPurchases`
    // while the invoice read ৳0.
    expect(sale.total).toBeGreaterThanOrEqual(0);
  });

  test('a fixed discount larger than the bill is capped at the subtotal', () => {
    expect(discountAmountFor(500, 900, 'fixed')).toBe(500);
    expect(computeInvoiceTotals({ subtotal: 500, discount: 900 }).total).toBe(0);
  });

  test('a string tax adds rather than concatenating', async () => {
    // The sale routes carry no Joi schema, so `tax` arrives raw. `100 - 0 + "50"`
    // is the string "10050"; the next `+ 0` made it "100500".
    const totals = computeInvoiceTotals({ subtotal: 100, tax: '50' });
    expect(totals.total).toBe(150);

    const sale = await runSaleHook({ items: [line()], tax: '50' });
    expect(sale.total).toBe(150);
  });

  test('garbage money inputs read as zero rather than NaN', () => {
    for (const junk of [undefined, null, '', 'abc', NaN, Infinity, -5, {}]) {
      expect(toMoney(junk)).toBe(0);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. PAISA — float dust must never reach a due
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. every figure is quantized to paisa', () => {
  test('a fully-paid invoice has a due of exactly zero, not 1.4e-14', async () => {
    // 0.1 + 0.2 = 0.30000000000000004. Unquantized, `due` came out at 4e-17,
    // the status became 'partial', and the invoice joined the বাকি list
    // (`due: { $gt: 0 }`) with nothing a customer could pay to clear it.
    const sale = await runSaleHook({
      items: [
        line({ unitPrice: 0.1, total: 0.1 }),
        line({ unitPrice: 0.2, total: 0.2 }),
      ],
      paid: 0.3,
    });

    expect(sale.subtotal).toBe(0.3);
    expect(sale.due).toBe(0);
    expect(sale.status).toBe('completed');
  });

  test('a fractional-quantity line total does not leak into the invoice', async () => {
    // 70 x 0.333 = 23.310000000000002
    const sale = await runSaleHook({
      items: [line({ quantity: 0.333, unitPrice: 70, total: 23.31 })],
      paid: 23.31,
    });
    expect(sale.total).toBe(23.31);
    expect(sale.due).toBe(0);
  });

  test('a percentage discount is rounded to paisa', () => {
    // 33% of 99.99 is 32.9967
    expect(computeInvoiceTotals({ subtotal: 99.99, discount: 33, discountType: 'percentage' }).discountAmount)
      .toBe(33);
  });

  test('profit is quantized and nets the returned term', async () => {
    const sale = await runSaleHook({
      items: [line({ quantity: 3, unitPrice: 100, buyingPrice: 70, total: 300 })],
      paid: 300,
      returnedProfit: 30,
    });
    // (100 - 70) x 3 = 90, less ৳30 already returned
    expect(sale.profit).toBe(60);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. BOUNDS
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. bounds and derived status', () => {
  test('only returnedAdjustment reduces the due — a cash refund does not', async () => {
    // A ৳1000 invoice with ৳300 paid, fully refunded in CASH, still owes ৳700.
    const cash = await runSaleHook({
      items: [line({ unitPrice: 1000, total: 1000 })],
      paid: 300,
      returnedAmount: 1000,
      returnedAdjustment: 0,
    });
    expect(cash.due).toBe(700);

    // Settled against the due instead, and nothing is owed.
    const adjusted = await runSaleHook({
      items: [line({ unitPrice: 1000, total: 1000 })],
      paid: 300,
      returnedAmount: 1000,
      returnedAdjustment: 700,
    });
    expect(adjusted.due).toBe(0);
  });

  test('a single figure cannot exceed the ceiling', () => {
    expect(toMoney(1e20)).toBe(MAX_INVOICE_AMOUNT);
    expect(computeInvoiceTotals({ subtotal: 1e20 }).total).toBe(MAX_INVOICE_AMOUNT);
  });

  test('cancelled is a lifecycle state and is never recomputed away', () => {
    expect(statusFor({ due: 0, paid: 100, current: 'cancelled' })).toBe('cancelled');
    expect(statusFor({ due: 0, paid: 100 })).toBe('completed');
    expect(statusFor({ due: 50, paid: 50 })).toBe('partial');
    expect(statusFor({ due: 50, paid: 0 })).toBe('unpaid');
  });

  test('tax and delivery are added on top of the discounted merchandise', () => {
    const t = computeInvoiceTotals({
      subtotal: 1000, discount: 10, discountType: 'percentage',
      tax: 50, deliveryCharge: 60,
    });
    expect(t.merchandise).toBe(900);
    expect(t.total).toBe(1010);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE DRAWER — legs must not overstate the till
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. split-payment legs are trimmed to what was actually kept', () => {
  test('a tendered cash leg is trimmed to the invoice total', () => {
    // The cash register sums the LEGS to work out what is in the drawer. Left
    // at 500 on a 420 bill, the ৳80 handed back as change was counted as
    // takings and the till read over by that much.
    expect(clampPaymentLegs([{ method: 'cash', amount: 500 }], 420))
      .toEqual([{ method: 'cash', amount: 420 }]);
  });

  test('trimming takes from the last leg, leaving the first intact', () => {
    const legs = clampPaymentLegs(
      [{ method: 'cash', amount: 400 }, { method: 'bkash', amount: 300 }],
      600
    );
    expect(legs).toEqual([
      { method: 'cash', amount: 400 },
      { method: 'bkash', amount: 200 },
    ]);
  });

  test('legs beyond the cap are dropped, not kept at zero', () => {
    const legs = clampPaymentLegs(
      [{ method: 'cash', amount: 500 }, { method: 'card', amount: 200 }],
      500
    );
    expect(legs).toHaveLength(1);
    expect(legs[0].method).toBe('cash');
  });

  test('legs that already fit are untouched — the ordinary split sale', () => {
    const input = [{ method: 'cash', amount: 400 }, { method: 'bkash', amount: 600 }];
    expect(clampPaymentLegs(input, 1000)).toEqual(input);
  });

  test('zero and malformed legs are dropped', () => {
    expect(clampPaymentLegs([{ method: 'cash', amount: 0 }, { method: 'card', amount: 'x' }], 500))
      .toEqual([]);
  });
});

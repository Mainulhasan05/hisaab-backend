/**
 * VAT — the setting that existed for years and did nothing.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 *
 * `Shop.settings.taxEnabled` and `taxRate` were editable from the shop's own
 * Settings page AND from the admin shop editor, round-tripped through
 * `auth.controller`'s whitelist, and were **read by nothing**. The POS sent a
 * literal `tax: 0` on every checkout. A shopkeeper could switch VAT on, type
 * 15, save it, watch it persist — and no invoice, receipt or report ever
 * changed.
 *
 * ── What these pin ──────────────────────────────────────────────────────────
 *
 *   · the rate resolves from BOTH settings, and fails closed;
 *   · the base is merchandise — after discount, never on delivery;
 *   · a client cannot choose the tax on a document a customer keeps;
 *   · the rate is snapshotted, so changing it does not rewrite history;
 *   · a return gives the VAT back, because the customer paid it on goods they
 *     no longer have;
 *   · a shop with VAT off is byte-identical to before (I-1).
 *
 * REGRESSIONS throughout except the I-1 block, which is a guard and passes
 * both ways by design.
 */
const mongoose = require('mongoose');
const {
  computeInvoiceTotals,
  taxAmountFor,
  toTaxRate,
  resolveTaxRate,
  MAX_TAX_RATE,
} = require('../utils/invoiceMath.util');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');

const shopWith = (settings) => ({ _id: new mongoose.Types.ObjectId(), settings });

describe('resolveTaxRate reads both switches', () => {
  it('bills the rate when the shop is switched on', () => {
    expect(resolveTaxRate(shopWith({ taxEnabled: true, taxRate: 15 }))).toBe(15);
  });

  it('bills nothing when switched off, even with a rate typed in', () => {
    // A shop that has paused VAT keeps the rate it configured. Reading the
    // rate alone would start billing the moment they saved the number.
    expect(resolveTaxRate(shopWith({ taxEnabled: false, taxRate: 15 }))).toBe(0);
  });

  it('bills nothing when switched on but never configured', () => {
    // Not a guess at 15. A shop that has not said what it charges charges
    // nothing.
    expect(resolveTaxRate(shopWith({ taxEnabled: true, taxRate: 0 }))).toBe(0);
  });

  it.each([
    ['no settings at all', {}],
    ['settings absent', undefined],
    ['shop absent', null],
    ['a cached shop from before the field existed', { settings: undefined }],
  ])('fails closed for %s', (_label, shop) => {
    // `req.shop` is rehydrated from Redis. Reading through an absent
    // `settings` unguarded throws a TypeError on the checkout hot path — the
    // failure `features.util` documents at length. And the wrong DEFAULT here
    // overcharges a real customer, not a report.
    expect(resolveTaxRate(shop)).toBe(0);
  });

  it.each([
    ['a negative rate', -5],
    ['a non-numeric rate', 'fifteen'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('reads %s as no VAT', (_label, taxRate) => {
    expect(resolveTaxRate(shopWith({ taxEnabled: true, taxRate }))).toBe(0);
  });

  it('caps a fat-fingered rate', () => {
    // `taxRate: 750` in settings must not multiply an invoice sevenfold.
    expect(toTaxRate(750)).toBe(MAX_TAX_RATE);
  });
});

describe('the base is merchandise', () => {
  it('is charged after the invoice discount', () => {
    // A discount reduces the consideration, so it reduces the tax.
    // ৳1,000 less ৳100 = ৳900 × 15% = ৳135.
    const totals = computeInvoiceTotals({ subtotal: 1000, discount: 100, taxRate: 15 });

    expect(totals.merchandise).toBe(900);
    expect(totals.tax).toBe(135);
    expect(totals.total).toBe(1035);
  });

  it('is charged after a PERCENTAGE discount too', () => {
    // ৳1,000 less 10% = ৳900 × 15% = ৳135. The same answer by another route,
    // which is the point of deriving both from one `merchandise` term.
    const totals = computeInvoiceTotals({
      subtotal: 1000, discount: 10, discountType: 'percentage', taxRate: 15,
    });

    expect(totals.tax).toBe(135);
  });

  it('is NOT charged on the delivery charge', () => {
    // Delivery is a pass-through everywhere else in this system —
    // `report.service` strips it out of merchandise revenue for the same
    // reason. Taxing it here would contradict that.
    const totals = computeInvoiceTotals({ subtotal: 1000, deliveryCharge: 60, taxRate: 15 });

    expect(totals.tax).toBe(150);
    expect(totals.total).toBe(1210);
  });

  it('is never charged on itself', () => {
    const totals = computeInvoiceTotals({ subtotal: 100, taxRate: 15 });

    expect(totals.tax).toBe(15);
    expect(totals.total).toBe(115);
  });

  it('quantizes to paisa', () => {
    // ৳333.33 × 7.5% = ৳24.99975. Left unrounded it propagates into `due`,
    // and a due of 1.4e-14 is an invoice no payment can ever clear.
    const totals = computeInvoiceTotals({ subtotal: 333.33, taxRate: 7.5 });

    expect(totals.tax).toBe(25);
    expect(Number.isInteger(totals.tax * 100)).toBe(true);
  });
});

describe('the client does not get to choose the tax', () => {
  it('discards a client figure when a rate applies', () => {
    // The route has no Joi bound on `tax`. A caller could bill any VAT it
    // liked — or none, at a shop that charges it.
    const totals = computeInvoiceTotals({ subtotal: 1000, tax: 99999, taxRate: 15 });

    expect(totals.tax).toBe(150);
  });

  it('discards a client figure of zero, which is what the POS used to send', () => {
    // The specific old payload. `tax: 0` on every checkout is what made the
    // setting inert.
    const totals = computeInvoiceTotals({ subtotal: 1000, tax: 0, taxRate: 15 });

    expect(totals.tax).toBe(150);
  });

  it('still honours a passed figure when the shop has no rate', () => {
    // Back-compat: `Purchase` and every historical caller pass a raw amount
    // and no rate, and must behave exactly as before.
    const totals = computeInvoiceTotals({ subtotal: 1000, tax: 50 });

    expect(totals.tax).toBe(50);
  });
});

describe('the rate is snapshotted on the invoice', () => {
  it('is stored on the Sale', () => {
    expect(Sale.schema.path('taxRate')).toBeDefined();
    expect(Sale.schema.path('taxRate').defaultValue).toBe(0);
  });

  it('is returned by the arithmetic so the service can store it', () => {
    expect(computeInvoiceTotals({ subtotal: 100, taxRate: 15 }).taxRate).toBe(15);
  });

  it('the pre-save hook recomputes tax from the stored rate', async () => {
    // A shop that later moves 5% → 15% must not rewrite the tax line of an
    // invoice already handed to a customer. The document carries its own rate,
    // so saving it for an unrelated reason re-derives the SAME figure.
    const sale = new Sale({
      shop: new mongoose.Types.ObjectId(),
      invoiceNo: 'INV-1',
      items: [{ product: new mongoose.Types.ObjectId(), productName: 'চাল', quantity: 1, unitPrice: 1000, total: 1000 }],
      subtotal: 1000,
      taxRate: 5,
      total: 0,
      createdBy: new mongoose.Types.ObjectId(),
    });

    await new Promise((resolve) => {
      Sale.schema.s.hooks.execPre('save', sale, () => resolve());
    });

    expect(sale.tax).toBe(50);
    expect(sale.taxRate).toBe(5);
    expect(sale.total).toBe(1050);
  });
});

describe('a return gives the VAT back', () => {
  it('refunds the tax on the goods coming back', () => {
    // ৳900 of goods returned off a 15% invoice → ৳135 of VAT with them.
    expect(taxAmountFor(900, 0, 15)).toBe(135);
  });

  it('refunds proportionally on a partial return', () => {
    // Half the goods back, half the VAT.
    expect(taxAmountFor(450, 0, 15)).toBe(67.5);
  });

  it('refunds at the INVOICE rate, not today rate', () => {
    // The service passes `sale.taxRate`. A shop that moved 5% → 15% last month
    // must refund the 5% it actually charged.
    expect(taxAmountFor(1000, 0, 5)).toBe(50);
  });

  it('separates merchandise from tax on the return document', () => {
    // `totalAmount` keeps its one job — feeding the fully-returned comparison
    // against the invoice's merchandise base. Folding VAT in would make a
    // fully-returned invoice read as OVER-returned by the tax.
    expect(SalesReturn.schema.path('totalAmount')).toBeDefined();
    expect(SalesReturn.schema.path('taxRefund')).toBeDefined();
    expect(SalesReturn.schema.path('taxRefund').defaultValue).toBe(0);
  });

  it('exposes the sum as what the customer is actually owed', () => {
    const salesReturn = new SalesReturn({
      shop: new mongoose.Types.ObjectId(),
      returnNo: 'RET-1',
      sale: new mongoose.Types.ObjectId(),
      invoiceNo: 'INV-1',
      items: [{}],
      totalAmount: 900,
      taxRefund: 135,
      createdBy: new mongoose.Types.ObjectId(),
    });

    expect(salesReturn.refundTotal).toBe(1035);
  });

  it('is zero on a return from a shop that charges no VAT', () => {
    const salesReturn = new SalesReturn({
      shop: new mongoose.Types.ObjectId(),
      returnNo: 'RET-2',
      sale: new mongoose.Types.ObjectId(),
      invoiceNo: 'INV-2',
      items: [{}],
      totalAmount: 900,
      createdBy: new mongoose.Types.ObjectId(),
    });

    expect(salesReturn.taxRefund).toBe(0);
    expect(salesReturn.refundTotal).toBe(900);
  });
});

describe('invariant guard — a shop without VAT is unchanged (I-1)', () => {
  it.each([
    ['a plain sale', { subtotal: 1000 }],
    ['with a discount', { subtotal: 1000, discount: 100 }],
    ['with delivery', { subtotal: 1000, deliveryCharge: 60 }],
    ['with a payment', { subtotal: 1000, paid: 400 }],
  ])('charges no tax and moves no total: %s', (_label, input) => {
    const withRate = computeInvoiceTotals({ ...input, taxRate: 0 });
    const without = computeInvoiceTotals(input);

    expect(withRate.tax).toBe(0);
    expect(withRate).toEqual(without);
  });

  it('leaves the POS payload free of a tax figure', () => {
    // The literal `tax: 0` is gone from the checkout body. It is not merely
    // ignored — it is not sent, so nobody reading the payload concludes the
    // client decides VAT.
    const fs = require('fs');
    const path = require('path');
    const pos = path.resolve(
      __dirname, '../../../hisaab-frontend/app/(app)/dashboard/sales/new/page.js'
    );
    if (!fs.existsSync(pos)) return; // backend-only checkout of the repo

    const code = fs.readFileSync(pos, 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

    expect(code).not.toContain('tax: 0,');
  });
});

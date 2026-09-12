/**
 * Reversals — returning goods, and cancelling an invoice.
 *
 * Two gaps, both of which only appear once a shop uses the features together:
 *
 *   A. FULLY RETURNED was measured against `Sale.total`, which carries tax and
 *      delivery. Refunds never do. So any invoice with either could not be
 *      recognised as fully returned — online orders, which always carry
 *      delivery, could never be closed out at all.
 *
 *   B. CANCELLING a partly-returned sale restored every line in full and unwound
 *      the whole invoice from the customer's ledger, on top of what the return
 *      had already reversed. Stock was credited twice and so was the customer.
 *      A FULL return reaches 'cancelled' and was caught by the existing guard;
 *      only the partial case fell through, which is why it went unseen.
 */

// `cancelSale` became transactional (see its header — the four unatomic writes
// it used to make). Run the callback directly so these tests do not need a
// replica set, the same shim paymentGuards/duePayment use. Assertions below are
// unchanged: this only removes the session, which they never exercised.
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const saleService = require('../services/sale.service');
const { discountAmountFor } = require('../utils/invoiceMath.util');

const SHOP = new mongoose.Types.ObjectId();

/**
 * The completion test as `createReturn` now performs it: refunds are drawn from
 * the merchandise base (`subtotal - discountAmount`), never from `total`.
 */
function isFullyReturned(sale, returnedAmount) {
  const base = Math.max(0, (sale.subtotal || 0) - discountAmountFor(sale.subtotal, sale.discount, sale.discountType));
  return base > 0 && returnedAmount >= base - 0.01;
}

afterEach(() => jest.restoreAllMocks());

/* ════════════════════════════════════════════════════════════════════════
 * A. "FULLY RETURNED" IS MEASURED AGAINST THE GOODS
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. a fully-returned invoice is recognised', () => {
  it('closes out an online order that carried a delivery charge', () => {
    // ৳1000 of goods + ৳60 delivery. Every item comes back, so the refund is
    // ৳1000 — which is less than `total` (৳1060) forever. The old comparison
    // left the invoice open with no `cancelReason`, still on the dues list.
    const sale = { subtotal: 1000, discount: 0, discountType: 'fixed', tax: 0, deliveryCharge: 60, total: 1060 };
    expect(isFullyReturned(sale, 1000)).toBe(true);
    expect(1000 >= sale.total - 0.01).toBe(false); // what the old test asked
  });

  it('closes out an invoice that carried tax', () => {
    const sale = { subtotal: 500, discount: 0, discountType: 'fixed', tax: 75, deliveryCharge: 0, total: 575 };
    expect(isFullyReturned(sale, 500)).toBe(true);
  });

  it('accounts for the invoice discount in the base', () => {
    // ৳1000 of goods less 10% = ৳900 refundable, plus ৳60 delivery.
    const sale = { subtotal: 1000, discount: 10, discountType: 'percentage', tax: 0, deliveryCharge: 60, total: 960 };
    expect(isFullyReturned(sale, 900)).toBe(true);
    expect(isFullyReturned(sale, 899)).toBe(false);
  });

  it('a partial return is still partial', () => {
    const sale = { subtotal: 1000, discount: 0, discountType: 'fixed', tax: 0, deliveryCharge: 60, total: 1060 };
    expect(isFullyReturned(sale, 400)).toBe(false);
  });

  it('a zero-value invoice is never "fully returned"', () => {
    // Guards the `base > 0` term: without it, `0 >= -0.01` is true and every
    // ৳0 invoice would mark itself cancelled the moment anything touched it.
    const sale = { subtotal: 0, discount: 0, discountType: 'fixed', tax: 0, deliveryCharge: 0, total: 0 };
    expect(isFullyReturned(sale, 0)).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. CANCELLING CANNOT DOUBLE-REVERSE A RETURN
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. a sale with returns against it cannot be cancelled', () => {
  const saleDoc = (over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    invoiceNo: 'INV-1',
    status: 'completed',
    returnedAmount: 0,
    total: 1000,
    paid: 1000,
    due: 0,
    branch: null,
    // Every Sale carries one (`timestamps: true`), and the closed-register
    // guard reads it to work out which day's drawer to check.
    createdAt: new Date(),
    items: [],
    ...over,
  });

  /** The day's drawer, for the guard that runs after the returns check. */
  const mockRegister = (status = null) => {
    const CashRegister = require('../models/CashRegister.model');
    return jest.spyOn(CashRegister, 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(status ? { status } : null),
    });
  };

  /**
   * The live `viaSale` settlement rows this checkout wrote, for the guard that
   * runs last. Empty is the ordinary case — most checkouts settle no খাতা — and
   * every test that reaches past the register guard needs this, or `Payment.find`
   * returns a real query that never resolves without a database.
   */
  const mockSettlements = (rows = []) => {
    const Payment = require('../models/Payment.model');
    return jest.spyOn(Payment, 'find').mockResolvedValue(rows);
  };

  it('refuses a partly-returned invoice', async () => {
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc({ returnedAmount: 300 }));

    await expect(
      saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'mistake')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('names returns in the message, so the cashier knows what to do instead', async () => {
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc({ returnedAmount: 300 }));

    await expect(
      saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'mistake')
    ).rejects.toThrow(/returns against it/i);
  });

  it('still refuses an already-cancelled sale', async () => {
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc({ status: 'cancelled' }));

    await expect(
      saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'x')
    ).rejects.toThrow(/already cancelled/i);
  });

  it('refuses when the day’s cash register has been closed', async () => {
    // `reviseSale` has always refused this; cancelling did not, which made the
    // weaker operation the way round it — a sale that could not be corrected on
    // a reconciled day could still be voided on one, moving the same money.
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc());
    mockRegister('closed');

    await expect(
      saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'mistake')
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets an untouched sale through to the reversal', async () => {
    // No returns and an open drawer: the guards must not block the ordinary
    // cancellation they sit in front of. Reaching the product lookup is proof it
    // passed all three checks.
    const Product = require('../models/Product.model');
    const Shop = require('../models/Shop.model');
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc());
    const find = jest.spyOn(Product, 'find').mockResolvedValue([]);
    jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});
    mockRegister(null); // no register row for that day at all
    mockSettlements();  // nothing was collected against the খাতা here
    const shopUpdate = jest.spyOn(Shop, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    const sale = saleDoc();
    sale.save = jest.fn().mockResolvedValue(sale);
    Sale.findOne.mockResolvedValue(sale);

    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'duplicate entry');

    expect(find).toHaveBeenCalled();
    expect(sale.status).toBe('cancelled');

    // `createSale` does `$inc: +1` and nothing used to give it back, so the stat
    // counted invoices ever WRITTEN rather than invoices that stand. The `$gt: 0`
    // sits on the FILTER because `$inc` has no floor — a stat that has already
    // drifted low must not be driven negative by an otherwise-correct cancel.
    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ 'stats.totalSales': { $gt: 0 } }),
      { $inc: { 'stats.totalSales': -1 } },
      expect.anything()
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. A খাতা SETTLEMENT TAKEN AT THIS CHECKOUT IS ITS OWN DECISION
 * ════════════════════════════════════════════════════════════════════════
 *
 * A cashier can clear part of the customer's older খাতা while ringing up a
 * bill. That money is a separate `Payment{viaSale}` row, deliberately outside
 * `sale.paid`, and `cancelSale` used to leave it standing without saying so.
 *
 * Right when the cash was really taken. Wrong when the whole checkout was a
 * mis-punch, because then the collection has nothing behind it — and the
 * orphaned receipt was invisible from every screen in the app. One live case
 * was found in production (৳3,450, voided 48s after checkout).
 *
 * So the service now refuses to guess. These tests pin the refusal, both
 * answers, and the two row types — not the reversal arithmetic, which belongs
 * to `dueSettlement.cancelDueCollection` and is tested beside it.
 */
describe('C. cancelling will not silently decide a khata settlement', () => {
  const Payment = require('../models/Payment.model');
  const dueSettlement = require('../services/dueSettlement.service');

  const settlementRow = (over = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    type: 'due_collection',
    amount: 3450,
    receiptNo: 'RCP-260912-DDA535',
    ...over,
  });

  /** A cancellable sale whose checkout also took money off the খাতা. */
  const readyToCancel = (rows) => {
    const Product = require('../models/Product.model');
    const Shop = require('../models/Shop.model');
    const sale = {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP,
      invoiceNo: 'INV-1',
      status: 'completed',
      returnedAmount: 0,
      total: 15000,
      paid: 15000,
      due: 0,
      branch: null,
      createdAt: new Date(),
      items: [],
    };
    sale.save = jest.fn().mockResolvedValue(sale);
    jest.spyOn(Sale, 'findOne').mockResolvedValue(sale);
    jest.spyOn(Product, 'find').mockResolvedValue([]);
    jest.spyOn(Shop, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});
    jest.spyOn(require('../models/CashRegister.model'), 'findOne').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    jest.spyOn(Payment, 'find').mockResolvedValue(rows);
    return sale;
  };

  it('refuses when a settlement rode in and nobody was asked about it', async () => {
    readyToCancel([settlementRow()]);
    const voidSpy = jest.spyOn(dueSettlement, 'cancelDueCollection').mockResolvedValue({});

    await expect(
      saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'ভুল')
    ).rejects.toMatchObject({ statusCode: 409 });

    // Refused BEFORE any write — the guard is worthless if it throws halfway.
    expect(voidSpy).not.toHaveBeenCalled();
  });

  it('proceeds untouched when told the collection stands', async () => {
    const sale = readyToCancel([settlementRow()]);
    const voidSpy = jest.spyOn(dueSettlement, 'cancelDueCollection').mockResolvedValue({});

    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'ভুল', null, {}, false);

    expect(sale.status).toBe('cancelled');
    // `false` must mean exactly what the code did before the choice existed:
    // the invoice is voided and the customer keeps credit for money they paid.
    expect(voidSpy).not.toHaveBeenCalled();
  });

  it('reverses the collection when told the cash was never taken', async () => {
    const row = settlementRow();
    const sale = readyToCancel([row]);
    const voidSpy = jest.spyOn(dueSettlement, 'cancelDueCollection').mockResolvedValue({});

    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'ভুল', null, {}, true);

    expect(sale.status).toBe('cancelled');
    expect(voidSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: SHOP, paymentId: row._id }),
      // The session, which the `runInTransaction` shim at the top of this file
      // makes `null`. Passed through rather than opened afresh: the reversal has
      // to commit or roll back with the cancellation as one unit.
      null
    );
  });

  it('reverses the deposit half too, not just the debt half', async () => {
    // `settleCustomerDue` splits one tendered amount into up to two rows when
    // the customer overpays. Voiding only the `due_collection` would strand the
    // `advance` in exactly the way this whole guard exists to prevent.
    const debt = settlementRow();
    const deposit = settlementRow({ type: 'advance', amount: 550, receiptNo: 'RCP-X' });
    readyToCancel([debt, deposit]);
    const voidSpy = jest.spyOn(dueSettlement, 'cancelDueCollection').mockResolvedValue({});

    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'ভুল', null, {}, true);

    expect(voidSpy).toHaveBeenCalledTimes(2);
    expect(voidSpy.mock.calls.map((c) => c[0].paymentId)).toEqual([debt._id, deposit._id]);
  });

  it('looks for both row types, and only live ones', async () => {
    readyToCancel([]);
    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'ভুল');

    // `$ne: 'cancelled'` and never `'active'`: rows written before the status
    // field existed carry none at all, so an equality test would report every
    // shop's history as already voided and the guard would never fire.
    expect(Payment.find).toHaveBeenCalledWith(
      expect.objectContaining({
        type: { $in: ['due_collection', 'advance'] },
        status: { $ne: 'cancelled' },
      }),
      null,
      expect.anything()
    );
  });

  it('does not ask when the checkout settled nothing', async () => {
    // The overwhelming majority of cancellations. An unnecessary 409 here would
    // be a worse regression than the bug this guard fixes.
    const sale = readyToCancel([]);
    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'duplicate');
    expect(sale.status).toBe('cancelled');
  });
});

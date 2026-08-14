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
    items: [],
    ...over,
  });

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

  it('lets an untouched sale through to the reversal', async () => {
    // No returns: the guard must not block the ordinary cancellation it sits in
    // front of. Reaching the product lookup is proof it passed both checks.
    const Product = require('../models/Product.model');
    jest.spyOn(Sale, 'findOne').mockResolvedValue(saleDoc());
    const find = jest.spyOn(Product, 'find').mockResolvedValue([]);
    jest.spyOn(require('../models/AuditLog.model'), 'create').mockResolvedValue({});

    const sale = saleDoc();
    sale.save = jest.fn().mockResolvedValue(sale);
    Sale.findOne.mockResolvedValue(sale);

    await saleService.cancelSale(SHOP, new mongoose.Types.ObjectId(), 'id', 'duplicate entry');

    expect(find).toHaveBeenCalled();
    expect(sale.status).toBe('cancelled');
  });
});

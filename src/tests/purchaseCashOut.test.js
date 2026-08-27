/**
 * The till counts a purchase's CASH LEGS, not its dominant method.
 *
 * `paymentMethod` on a purchase is only "whichever leg was largest" (the same
 * derivation `Sale.paymentMethod` has), so the old
 * `$match {paymentMethod:'cash'} → $sum '$paid'` was wrong in both directions
 * on a split-tender purchase and by the full amount:
 *
 *     ৳50,000 cash + ৳1,50,000 bank → 'bank' → ৳0 counted out of the drawer
 *     ৳1,50,000 cash + ৳50,000 bank → 'cash' → ৳2,00,000 counted out
 *
 * These pin the QUERY SHAPE, the way `cashDrawerNoDoubleCount` does — the
 * arithmetic is a `$sum`; the population it runs over was the bug.
 *
 * REGRESSION TESTS: against the old pipeline the $match still carries
 * `paymentMethod: 'cash'` and there is no leg projection to find.
 */

const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const PaymentAccount = require('../models/PaymentAccount.model');
const AccountTransfer = require('../models/AccountTransfer.model');
const cashRegisterService = require('../services/cashRegister.service');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

function stubAggregates() {
  const purchase = jest.fn().mockResolvedValue([]);
  const payment = jest.fn().mockResolvedValue([]);
  jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Expense, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockImplementation(purchase);
  jest.spyOn(Payment, 'aggregate').mockImplementation(payment);
  jest.spyOn(PaymentAccount, 'find').mockReturnValue({ lean: () => Promise.resolve([]) });
  jest.spyOn(AccountTransfer, 'aggregate').mockResolvedValue([]);
  return { purchase, payment };
}

afterEach(() => jest.restoreAllMocks());

describe('purchase cash-out is summed from the cash legs', () => {
  it('no longer pre-filters on the dominant paymentMethod', async () => {
    const { purchase } = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const [pipeline] = purchase.mock.calls[0];
    const match = pipeline[0].$match;
    // Filtering the MATCH on the largest leg is the whole bug: a purchase whose
    // biggest leg was bank never reached the sum, cash leg and all.
    expect(match.paymentMethod).toBeUndefined();
    expect(match.status).toEqual({ $ne: 'cancelled' });
    expect(String(match.shop)).toBe(String(SHOP));
    expect(String(match.branch)).toBe(String(BRANCH));
  });

  it('sums only the legs whose method is cash', async () => {
    const { purchase } = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const [pipeline] = purchase.mock.calls[0];
    const cond = pipeline[1].$project.cashAmount.$cond;
    // Docs with legs: filter method === 'cash', sum those amounts.
    expect(cond[1].$sum.$map.input.$filter.cond).toEqual({ $eq: ['$$p.method', 'cash'] });
    // The grouped figure is the projected leg sum, not `$paid`.
    expect(pipeline[2].$group.total).toEqual({ $sum: '$cashAmount' });
  });

  it('keeps the legacy paymentMethod/paid fallback for docs with no legs', async () => {
    // INVARIANT GUARD — purchases written before `payments[]` existed carry one
    // figure and one method, and must keep counting exactly as they always did.
    const { purchase } = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const [pipeline] = purchase.mock.calls[0];
    const cond = pipeline[1].$project.cashAmount.$cond;
    expect(cond[0]).toEqual({ $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] });
    expect(cond[2]).toEqual({
      $cond: [{ $eq: ['$paymentMethod', 'cash'] }, { $ifNull: ['$paid', 0] }, 0],
    });
  });

  it('the later supplier-payment bucket stays method-accurate and live-only', async () => {
    // INVARIANT GUARD — `recordPayment` rows are counted from the Payment side,
    // per their own method, with voided rows (a cancelled purchase's unwound
    // money) excluded by the LIVE_PAYMENT shape.
    const { payment } = stubAggregates();

    await cashRegisterService._calculateCashFlows(SHOP, new Date(0), new Date(), BRANCH);

    const supplier = payment.mock.calls
      .map(([p]) => p[0].$match)
      .find((m) => m.type === 'purchase_payment');
    expect(supplier).toBeDefined();
    expect(supplier.method).toBe('cash');
    expect(supplier.status).toEqual({ $ne: 'cancelled' });
  });
});

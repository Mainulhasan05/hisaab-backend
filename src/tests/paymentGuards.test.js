/**
 * Payment guards — money may only ever move forwards, and only once.
 *
 * Two gaps, both on routes with no Joi schema, so the service is the only
 * boundary there is:
 *
 *   A. SIGN. `sale.recordPayment` and `customer.collectDuePayment` checked only
 *      `amount > due`, which a NEGATIVE amount passes. That ran the ledger
 *      backwards — `paid` down, `due` UP — and wrote a negative cash row the
 *      register subtracted from the drawer. `purchase.recordPayment` had the
 *      `<= 0` guard all along; the asymmetry was the bug.
 *
 *   B. CONCURRENCY. `recordPayment` was a read-modify-write outside any
 *      transaction. Two collections against one invoice both passed the check
 *      against the same stale `due`, and the second `save()` overwrote the
 *      first — while BOTH `Payment` rows and BOTH customer decrements survived.
 *      The customer's ledger fell by twice what the invoice recorded.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));
jest.mock('../services/sms.service', () => ({
  sendPaymentReceiptAsync: jest.fn(),
}));
// Both services run inside runInTransaction; execute the callback directly so
// the tests do not need a replica set.
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const saleService = require('../services/sale.service');
const customerService = require('../services/customer.service');
const Sale = require('../models/Sale.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();

/** An invoice with ৳500 outstanding. */
function stubSale(over = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    invoiceNo: 'INV-1',
    status: 'partial',
    total: 1000,
    paid: 500,
    due: 500,
    branch: null,
    customer: CUSTOMER,
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
  jest.spyOn(Sale, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  jest.spyOn(Sale, 'findById').mockReturnValue({ session: () => Promise.resolve(doc) });
  return doc;
}

beforeEach(() => {
  jest.spyOn(Payment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
  jest.spyOn(Customer, 'findByIdAndUpdate').mockResolvedValue({});
  jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});
  jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

/* ════════════════════════════════════════════════════════════════════════
 * A. SIGN
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. a payment cannot be negative or zero', () => {
  test('recordPayment refuses a negative amount', async () => {
    stubSale();
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await expect(
      saleService.recordPayment(SHOP, USER, 'sale-id', { amount: -500 })
    ).rejects.toThrow(/greater than 0/i);

    // Nothing may have moved.
    expect(Sale.updateOne).not.toHaveBeenCalled();
    expect(Payment.create).not.toHaveBeenCalled();
    expect(Customer.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('recordPayment refuses zero and non-numeric amounts', async () => {
    stubSale();
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    for (const amount of [0, null, undefined, '', 'abc', NaN]) {
      await expect(
        saleService.recordPayment(SHOP, USER, 'sale-id', { amount })
      ).rejects.toThrow(/greater than 0/i);
    }
  });

  test('collectDuePayment refuses a negative amount', async () => {
    const customer = {
      _id: CUSTOMER, shop: SHOP, name: 'করিম', phone: '01700000000',
      totalPaid: 0, totalDue: 5000,
      save: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => Promise.resolve(customer) });

    const req = { shop: { _id: SHOP }, branchId: null, user: { _id: USER, isOwner: true } };

    await expect(
      customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: -1000 }, req)
    ).rejects.toThrow(/greater than 0/i);

    // The ledger used to run BACKWARDS here: totalPaid down, totalDue up.
    expect(customer.totalDue).toBe(5000);
    expect(customer.totalPaid).toBe(0);
    expect(Payment.create).not.toHaveBeenCalled();
  });

  test('a legitimate payment still goes through', async () => {
    const sale = stubSale();
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 200, method: 'cash' });

    expect(Sale.updateOne).toHaveBeenCalled();
    expect(Payment.create).toHaveBeenCalled();
    expect(sale.save).toHaveBeenCalled();
  });

  test('a payment above the due is still refused', async () => {
    stubSale();
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await expect(
      saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 900 })
    ).rejects.toThrow(/exceeds due/i);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. CONCURRENCY
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. two collections cannot both settle the same due', () => {
  test('the claim re-asserts the due in its filter', async () => {
    stubSale();
    const updateOne = jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 200 });

    const [filter, update] = updateOne.mock.calls[0];
    // The guard: the same shape the stock write uses in `createSale`.
    expect(filter.due).toEqual({ $gte: 200 });
    expect(filter.status).toEqual({ $ne: 'cancelled' });
    expect(update).toEqual({ $inc: { paid: 200 } });
  });

  test('losing the race is a 409, not a silent overwrite', async () => {
    stubSale();
    // The concurrent collection got there first, so the filter no longer matches.
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 0 });

    await expect(
      saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 500 })
    ).rejects.toMatchObject({ statusCode: 409 });

    // Critically: no Payment row and no customer decrement for a payment that
    // did not land. Both used to survive the lost race.
    expect(Payment.create).not.toHaveBeenCalled();
    expect(Customer.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(CustomerBalance.applyDelta).not.toHaveBeenCalled();
  });

  test('a cancelled invoice takes no payment', async () => {
    stubSale({ status: 'cancelled' });
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await expect(
      saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 100 })
    ).rejects.toThrow(/cancelled/i);
  });

  test('the customer ledger is credited exactly once, at the sale branch', async () => {
    const branch = new mongoose.Types.ObjectId();
    stubSale({ branch });
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    await saleService.recordPayment(SHOP, USER, 'sale-id', { amount: 200 });

    expect(CustomerBalance.applyDelta).toHaveBeenCalledTimes(1);
    const [delta] = CustomerBalance.applyDelta.mock.calls[0];
    expect(delta).toMatchObject({ branch, paid: 200, due: -200 });
  });
});

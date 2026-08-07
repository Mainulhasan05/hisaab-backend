/**
 * Phase 7 — the money test.
 *
 * Under separate books, `collectDuePayment` validated the amount against
 * `Customer.totalDue`, the SHOP-WIDE figure. Branch B could therefore collect
 * ৳5,000 against a due that existed only at branch A: no error, no warning,
 * both branches' books wrong from then on. This suite exists to keep that shut.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/sms.service', () => ({
  sendPaymentReceiptAsync: jest.fn(),
}));
// The service runs inside runInTransaction; execute the callback directly so
// the test does not need a replica set.
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId(); // raised the invoice
const BRANCH_B = new mongoose.Types.ObjectId(); // where the customer walked in

/** Multi-branch shop, staff standing at BRANCH_B. */
const reqAt = (branchId, scope) => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: scope },
  branchId,
  user: { _id: USER, isOwner: true },
});

/** The customer owes ৳5,000 shop-wide — all of it raised at BRANCH_A. */
const stubCustomer = (totalDue = 5000) => {
  const doc = {
    _id: CUSTOMER, shop: SHOP, name: 'করিম', phone: '01700000000',
    totalPaid: 0, totalDue,
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  return doc;
};

beforeEach(() => {
  jest.spyOn(Payment, 'create').mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]);
  jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe('separate books — a branch cannot collect what it is not owed', () => {
  const req = reqAt(BRANCH_B, 'branch');

  it('rejects a collection against another branch\'s due', async () => {
    stubCustomer(5000);                                   // ৳5,000 shop-wide…
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(null); // …none of it here

    await expect(
      customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 5000 }, req)
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(Payment.create).not.toHaveBeenCalled();
  });

  it('rejects an amount above this branch\'s due even when the shop-wide total covers it', async () => {
    stubCustomer(5000);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 1200 });

    await expect(
      customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 1500 }, req)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts up to this branch\'s own due', async () => {
    const customer = stubCustomer(5000);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 1200 });

    await customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 1200 }, req);

    expect(Payment.create).toHaveBeenCalled();
    // Both books move together — that is what keeps the toggle migration-free.
    expect(customer.totalDue).toBe(3800);
    expect(CustomerBalance.settleDue).toHaveBeenCalledWith(
      expect.objectContaining({ preferBranch: BRANCH_B, amount: 1200 }),
      null
    );
  });
});

describe('shared book — unchanged from before Phase 7', () => {
  const req = reqAt(BRANCH_B, 'shop');

  it('validates against the shop-wide total, so any branch may collect', async () => {
    const customer = stubCustomer(5000);
    const findOne = jest.spyOn(CustomerBalance, 'findOne');

    await customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 5000 }, req);

    expect(customer.totalDue).toBe(0);
    // The branch row is never even consulted in shared mode.
    expect(findOne).not.toHaveBeenCalled();
  });

  it('still refuses more than the shop-wide due', async () => {
    stubCustomer(5000);
    await expect(
      customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 5001 }, req)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('allocates across branches rather than crediting the collector wholesale', async () => {
    stubCustomer(5000);
    await customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 5000 }, req);

    // Without this the collecting branch goes to −৳5,000 and the owing branch
    // stays at +৳5,000 — invisible until the shop flips to separate books.
    expect(CustomerBalance.settleDue).toHaveBeenCalledWith(
      expect.objectContaining({ preferBranch: BRANCH_B, amount: 5000 }),
      null
    );
  });
});

describe('single-branch shops', () => {
  const req = {
    shop: { _id: SHOP, multiBranchEnabled: false },
    branchId: null,
    user: { _id: USER, isOwner: true },
  };

  it('validate shop-wide and write no ledger row', async () => {
    const customer = stubCustomer(800);
    const findOne = jest.spyOn(CustomerBalance, 'findOne');

    await customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 800 }, req);

    expect(customer.totalDue).toBe(0);
    expect(findOne).not.toHaveBeenCalled();
    // settleDue is called but no-ops on a null branch — asserted in the ledger suite.
    expect(Payment.create.mock.calls[0][0][0].branch).toBeNull();
  });
});

describe('the payment record itself', () => {
  it('is tagged with the collecting branch, for that branch\'s cash register', async () => {
    // Distinct from the ledger attribution above: the cash physically entered
    // THIS till, and cashRegister._calculateCashFlows matches on it (H-6).
    stubCustomer(1000);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 1000 });

    await customerService.collectDuePayment(SHOP, USER, CUSTOMER, { amount: 1000 }, reqAt(BRANCH_B, 'branch'));

    expect(Payment.create.mock.calls[0][0][0]).toMatchObject({
      branch: BRANCH_B,
      type: 'due_collection',
    });
  });
});

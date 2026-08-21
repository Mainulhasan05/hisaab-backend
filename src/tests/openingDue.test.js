/**
 * Pre-software debt — the term that has no invoice behind it.
 *
 * A shop that traded on paper for years signs up owing nothing to us and being
 * owed plenty by its customers. That debt enters as `openingDue` and must
 * behave, everywhere, exactly like debt an invoice created:
 *
 *     totalDue = max(0, totalPurchases + openingDue − totalPaid)
 *
 * These tests exist because the term is easy to drop. Every path that
 * RE-DERIVES due rather than `$inc`-ing it has to carry it, and dropping it on
 * one side while keeping it on the other is silent — the money simply
 * disappears from a customer's account on their next return.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const DueAdjustment = require('../models/DueAdjustment.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

afterEach(() => jest.restoreAllMocks());

describe('the formula', () => {
  it('adds opening due on top of invoiced debt', () => {
    expect(Customer.deriveDue({ totalPurchases: 1000, openingDue: 5000, totalPaid: 200 })).toBe(5800);
  });

  it('is unchanged for a customer with no opening due', () => {
    // Every shop that existed before this field must keep its exact figures.
    expect(Customer.deriveDue({ totalPurchases: 1000, totalPaid: 200 })).toBe(800);
  });

  it('still clamps at zero when the customer has overpaid', () => {
    expect(Customer.deriveDue({ totalPurchases: 100, openingDue: 50, totalPaid: 400 })).toBe(0);
  });

  it('treats a missing document as zero rather than NaN', () => {
    // A NaN here would be written straight into totalDue and poison every
    // aggregate that sums it, with no error anywhere.
    expect(Customer.deriveDue(null)).toBe(0);
    expect(Customer.deriveDue({})).toBe(0);
  });
});

describe('CustomerBalance mirrors the same formula', () => {
  it('recomputeBalances carries the opening term', async () => {
    // This is the sales-return path. Before the term existed, a return on a
    // customer carrying খাতা debt recomputed their due from purchases alone and
    // wiped the opening balance.
    const row = { totalPurchases: 1000, openingDue: 5000, totalPaid: 200, totalDue: 0, save: jest.fn() };
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(row);

    await CustomerBalance.recomputeBalances({ shop: SHOP, customer: CUSTOMER, branch: BRANCH });

    expect(row.totalDue).toBe(5800);
    expect(row.save).toHaveBeenCalled();
  });

  it('applyDelta increments openingDue when asked', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne').mockResolvedValue({});

    await CustomerBalance.applyDelta({
      shop: SHOP, customer: CUSTOMER, branch: BRANCH, opening: 5000, due: 5000,
    });

    const [, update] = updateOne.mock.calls[0];
    expect(update.$inc).toEqual({ totalDue: 5000, openingDue: 5000 });
  });

  it('writes nothing for a single-branch shop', async () => {
    const updateOne = jest.spyOn(CustomerBalance, 'updateOne');
    await CustomerBalance.applyDelta({ shop: SHOP, customer: CUSTOMER, branch: null, opening: 5000 });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('DueAdjustment schema', () => {
  it('refuses a zero amount', () => {
    // A no-op row would sit in the খতিয়ান claiming to have changed something.
    const doc = new DueAdjustment({
      shop: SHOP, customer: CUSTOMER, amount: 0, createdBy: new mongoose.Types.ObjectId(),
    });
    expect(doc.validateSync().errors.amount).toBeTruthy();
  });

  it('allows a negative amount — corrections are rows, not edits', () => {
    const doc = new DueAdjustment({
      shop: SHOP, customer: CUSTOMER, amount: -500, createdBy: new mongoose.Types.ObjectId(),
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('cannot be hard-deleted', () => {
    // Same ledger guard as Sale and Payment: erasing the row would leave the
    // rollup asserting debt with nothing explaining it.
    expect(typeof DueAdjustment.schema.s.hooks).toBe('object');
    const doc = new DueAdjustment({
      shop: SHOP, customer: CUSTOMER, amount: 100, createdBy: new mongoose.Types.ObjectId(),
    });
    return expect(doc.deleteOne()).rejects.toThrow(/cannot be deleted/i);
  });
});

describe('setOpeningDue', () => {
  const customerService = require('../services/customer.service');
  const req = { shop: { _id: SHOP, multiBranchEnabled: false }, user: { isOwner: true } };

  it('takes a target figure and applies the difference', async () => {
    // The owner answers "খাতায় কত ছিল", not "কত বাড়াতে হবে".
    jest.spyOn(Customer, 'findOne').mockReturnValue({ lean: async () => ({ _id: CUSTOMER, openingDue: 2000 }) });
    const apply = jest.spyOn(customerService, '_applyDueAdjustment').mockResolvedValue({ applied: 3000 });

    await customerService.setOpeningDue(SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: 5000 }, req);

    expect(apply.mock.calls[0][3].amount).toBe(3000);
  });

  it('writes nothing when the figure is unchanged', async () => {
    jest.spyOn(Customer, 'findOne').mockReturnValue({ lean: async () => ({ _id: CUSTOMER, openingDue: 2000 }) });
    const apply = jest.spyOn(customerService, '_applyDueAdjustment');

    const result = await customerService.setOpeningDue(
      SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: 2000 }, req
    );

    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });

  it('rejects a negative target — this shop does not track advances', async () => {
    await expect(
      customerService.setOpeningDue(SHOP, new mongoose.Types.ObjectId(), CUSTOMER, { openingDue: -100 }, req)
    ).rejects.toThrow();
  });
});

describe('createCustomer opening due', () => {
  const customerService = require('../services/customer.service');

  const baseReq = (isOwner) => ({
    shop: { _id: SHOP, multiBranchEnabled: false },
    user: { isOwner },
  });

  it('refuses a non-zero opening due from a non-owner', async () => {
    // The route only checks `customers.create`, which a cashier holds. Writing
    // a receivable out of nothing is the part that must be owner-only, so the
    // check lives on the field rather than the endpoint.
    await expect(
      customerService.createCustomer(SHOP, new mongoose.Types.ObjectId(),
        { phone: '01711223344', name: 'করিম', openingDue: 5000 }, baseReq(false))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lets a non-owner create a customer with no opening due', async () => {
    jest.spyOn(Customer, 'findOne').mockResolvedValue(null);
    jest.spyOn(Customer, 'create').mockResolvedValue({ _id: CUSTOMER, name: 'করিম', phone: '01711223344' });
    jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(null);
    const apply = jest.spyOn(customerService, '_applyDueAdjustment');

    await customerService.createCustomer(SHOP, new mongoose.Types.ObjectId(),
      { phone: '01711223344', name: 'করিম' }, baseReq(false));

    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a negative opening due', async () => {
    await expect(
      customerService.createCustomer(SHOP, new mongoose.Types.ObjectId(),
        { phone: '01711223344', openingDue: -1 }, baseReq(true))
    ).rejects.toThrow();
  });
});

describe('import validation', () => {
  const customerService = require('../services/customer.service');
  const ownerReq = { shop: { _id: SHOP }, user: { isOwner: true } };
  const staffReq = { shop: { _id: SHOP }, user: { isOwner: false } };

  const stubNoExisting = () =>
    jest.spyOn(Customer, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });

  it('catches a duplicate phone inside the file itself', async () => {
    // The commit path cannot see this: each row is its own existence check, and
    // the first insert turns the second into a confusing "already exists".
    stubNoExisting();

    const { rows, summary } = await customerService.validateImportRows(SHOP, [
      { phone: '01711223344', name: 'করিম' },
      { phone: '01711223344', name: 'করিম মিয়া' },
    ], ownerReq);

    expect(rows[0].valid).toBe(true);
    expect(rows[1].valid).toBe(false);
    expect(rows[1].errors.join()).toMatch(/ডুপ্লিকেট/);
    expect(summary.valid).toBe(1);
  });

  it('rejects a malformed phone', async () => {
    stubNoExisting();
    const { rows } = await customerService.validateImportRows(SHOP, [{ phone: '12345' }], ownerReq);
    expect(rows[0].valid).toBe(false);
  });

  it('blocks a non-owner from importing opening dues, but not the names', async () => {
    stubNoExisting();

    const { rows } = await customerService.validateImportRows(SHOP, [
      { phone: '01711223344', openingDue: 5000 },
      { phone: '01811223344', openingDue: 0 },
    ], staffReq);

    expect(rows[0].valid).toBe(false);
    expect(rows[1].valid).toBe(true);
  });

  it('totals the opening dues that will actually be written', async () => {
    // The preview promises this figure before anything is committed, so it must
    // count only rows that will survive.
    stubNoExisting();

    const { summary } = await customerService.validateImportRows(SHOP, [
      { phone: '01711223344', openingDue: 5000 },
      { phone: '01811223344', openingDue: 2500.5 },
      { phone: 'bad', openingDue: 9999 },
    ], ownerReq);

    expect(summary.totalOpeningDue).toBe(7500.5);
    expect(summary.invalid).toBe(1);
  });

  it('flags a phone that already belongs to a customer', async () => {
    jest.spyOn(Customer, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ phone: '01711223344', name: 'করিম' }] }),
    });

    const { rows } = await customerService.validateImportRows(SHOP, [{ phone: '01711223344' }], ownerReq);
    expect(rows[0].valid).toBe(false);
    expect(rows[0].errors.join()).toMatch(/কাস্টমার আছে/);
  });

  it('refuses an oversized batch rather than timing out mid-write', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ phone: `017${String(i).padStart(8, '0')}` }));
    await expect(customerService.validateImportRows(SHOP, rows, ownerReq)).rejects.toThrow();
  });
});

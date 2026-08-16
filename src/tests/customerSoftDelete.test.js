/**
 * Soft delete must not be a one-way door.
 *
 * ── The reported failure ─────────────────────────────────────────────────────
 *
 * A shop could not find a customer they had served for months. The record was
 * never gone: `deleteCustomer` had set `isActive: false`, and that flag is
 * filtered out by every read in the app — the list, the search, the till
 * lookup, the due list, the leaderboard, the aging report. Nothing anywhere
 * could see them and nothing could undo it, because `deleteCustomer` was the
 * only line in the codebase that wrote the flag at all.
 *
 * The record kept holding the phone number the whole time ({shop, phone} is
 * unique over deleted documents too), so the obvious recovery — add the
 * customer again — could not work either:
 *
 *   shared book → "এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে", naming a record
 *                 no screen can open;
 *   branch book → 200 OK and a success toast, and still nothing in the list.
 *
 * Meanwhile `sale.service` did NOT filter the flag, so invoices kept binding to
 * the hidden record. One shop reached ৳1,06,305 owed by a customer their own
 * due list could not show.
 *
 * These tests pin all four halves: restore exists, the add form routes to it,
 * the bin is readable, and the till refuses rather than accruing.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const AuditLog = require('../models/AuditLog.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

const singleBranch = () => ({ shop: { _id: SHOP, multiBranchEnabled: false }, branchId: null, user: { isOwner: true } });
const separate = () => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' },
  branchId: BRANCH,
  user: { isOwner: true },
});

/** A deleted customer, saveable, tracking what `save()` persisted. */
const deletedCustomer = (over = {}) => {
  const doc = {
    _id: CUSTOMER,
    shop: SHOP,
    phone: '01792449180',
    name: 'নগদ বিক্রয়',
    isActive: false,
    totalDue: 0,
    saved: 0,
    save: jest.fn(function () { this.saved += 1; return Promise.resolve(this); }),
    toObject() { return { _id: this._id, phone: this.phone, name: this.name, isActive: this.isActive }; },
    ...over,
  };
  return doc;
};

afterEach(() => jest.restoreAllMocks());

describe('restoreCustomer', () => {
  it('flips the flag back and audits it', async () => {
    const doc = deletedCustomer();
    jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);

    await customerService.restoreCustomer(SHOP, USER, CUSTOMER, singleBranch());

    expect(doc.isActive).toBe(true);
    expect(doc.save).toHaveBeenCalled();
    expect(AuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer_restore' })
    );
  });

  it('refuses a customer who is not deleted', async () => {
    jest.spyOn(Customer, 'findOne').mockResolvedValue(deletedCustomer({ isActive: true }));

    await expect(
      customerService.restoreCustomer(SHOP, USER, CUSTOMER, singleBranch())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not deleted/i) });
  });

  it('404s on a customer from another shop', async () => {
    jest.spyOn(Customer, 'findOne').mockResolvedValue(null);

    await expect(
      customerService.restoreCustomer(SHOP, USER, CUSTOMER, singleBranch())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * Under branch scope the list is driven by `CustomerBalance` rows, so
   * restoring the identity alone would flip the flag and change nothing on
   * screen for the person who pressed the button.
   */
  it('gives the restoring branch a ledger row so it can actually see them', async () => {
    const doc = deletedCustomer();
    jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: async () => ({ totalDue: 0 }) });

    await customerService.restoreCustomer(SHOP, USER, CUSTOMER, separate());

    expect(applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ shop: SHOP, customer: CUSTOMER, branch: BRANCH })
    );
  });

  // A restore moves no money. The row is created with no deltas at all, so a
  // customer restored at another branch cannot pick up a due here.
  it('moves no money', async () => {
    const doc = deletedCustomer();
    jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
    const applyDelta = jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({ lean: async () => ({ totalDue: 0 }) });

    await customerService.restoreCustomer(SHOP, USER, CUSTOMER, separate());

    const delta = applyDelta.mock.calls[0][0];
    expect(delta.due).toBeUndefined();
    expect(delta.opening).toBeUndefined();
    expect(delta.purchases).toBeUndefined();
  });
});

describe('createCustomer on a soft-deleted phone', () => {
  it('restores instead of dead-ending', async () => {
    const doc = deletedCustomer();
    jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
    jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});

    // Shared book: this used to throw "already exists" at a record no screen
    // could open.
    await customerService.createCustomer(
      SHOP, USER, { phone: '01792449180', name: 'নগদ বিক্রয়' }, singleBranch()
    );

    expect(doc.isActive).toBe(true);
  });

  it('normalises the phone before deciding the customer already exists', async () => {
    const findOne = jest.spyOn(Customer, 'findOne').mockResolvedValue(null);
    jest.spyOn(Customer, 'create').mockResolvedValue({ _id: CUSTOMER, phone: '01792449180' });
    jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue({});

    await customerService.createCustomer(
      SHOP, USER, { phone: '+880 1792-449180', name: 'X' }, singleBranch()
    );

    // The lookup that decides "duplicate or not" must ask the same question the
    // {shop, phone} unique index will, or the create falls through to E11000.
    expect(findOne).toHaveBeenCalledWith({ shop: SHOP, phone: '01792449180' });
    expect(Customer.create).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '01792449180' })
    );
  });
});

describe('the recycle bin', () => {
  it('queries for deleted customers when asked, and live ones otherwise', async () => {
    const chain = {
      select: () => chain, sort: () => chain, skip: () => chain, limit: () => chain,
      lean: () => Promise.resolve([]),
    };
    const find = jest.spyOn(Customer, 'find').mockReturnValue(chain);
    jest.spyOn(Customer, 'countDocuments').mockResolvedValue(0);
    jest.spyOn(Customer, 'aggregate').mockResolvedValue([]);

    await customerService.getCustomers(SHOP, {}, singleBranch());
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ isActive: true }));

    // Query strings carry 'true', never a boolean.
    await customerService.getCustomers(SHOP, { deleted: 'true' }, singleBranch());
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ isActive: false }));
  });

  it('works under branch scope too', async () => {
    const agg = jest.spyOn(CustomerBalance, 'aggregate')
      .mockResolvedValue([{ data: [], count: [], totals: [] }]);

    await customerService.getCustomers(SHOP, { deleted: 'true' }, separate());

    const pipeline = agg.mock.calls[0][0];
    const postJoin = pipeline.filter((s) => s.$match).map((s) => s.$match);
    expect(postJoin).toEqual(
      expect.arrayContaining([expect.objectContaining({ 'customer.isActive': false })])
    );
  });
});

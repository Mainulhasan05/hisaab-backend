/**
 * Per-branch customer names.
 *
 * The reported failure: Chittagong corrected a customer's name and number, and
 * Dhaka — who had been tracking the same person as "Sadek" — could never find
 * them again. `updateCustomer` had no branch awareness whatsoever, so any
 * branch that could reach an id rewrote that customer for every other branch.
 *
 * The rule these tests pin:
 *
 *   NAME  is a label   → per branch (`CustomerBalance.localName`)
 *   PHONE is identity  → shared, always ({shop, phone} is a unique index, SMS
 *                        goes to it, Sale snapshots it, and a correction must
 *                        reach every branch rather than stopping at one)
 *
 * Money is untouched by any of this — it was already per-branch.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');

const SHOP = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

const separate = (branchId = BRANCH_A) => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' },
  branchId,
  user: { isOwner: true },
});
const shared = () => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: 'shop' },
  branchId: BRANCH_A,
  user: { isOwner: true },
});

/** A saveable Customer stub carrying the canonical name. */
const stubCustomer = (over = {}) => {
  const doc = {
    _id: CUSTOMER,
    shop: SHOP,
    name: 'Sadek',
    phone: '01711223344',
    address: 'Mirpur',
    save: jest.fn().mockResolvedValue(undefined),
    toObject() {
      const { save, toObject, ...rest } = this;
      return rest;
    },
    ...over,
  };
  jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
  return doc;
};

/** This branch's ledger row. */
const stubRow = (over = {}) => {
  const row = { localName: null, totalDue: 0, save: jest.fn().mockResolvedValue(undefined), ...over };
  jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(row);
  return row;
};

afterEach(() => jest.restoreAllMocks());

describe('schema', () => {
  it('stores localName on the branch ledger, not on Customer', () => {
    // On CustomerBalance it costs no extra query — every branch-scoped read
    // already joins this row.
    expect(CustomerBalance.schema.path('localName')).toBeDefined();
    expect(Customer.schema.path('localName')).toBeUndefined();
  });

  it('leaves the shop-wide phone uniqueness untouched', () => {
    // The guarantee we deliberately refused to trade away. A per-branch phone
    // would have moved this from the database into a racy application check.
    const unique = Customer.schema.indexes().find(([, o]) => o && o.unique);
    expect(unique[0]).toEqual({ shop: 1, phone: 1 });
  });
});

describe('renaming in branch scope', () => {
  it('writes the name to this branch and never to the shared document', async () => {
    const doc = stubCustomer();
    const row = stubRow();
    jest.spyOn(customerService, '_applyBranchFigures').mockResolvedValue({ name: 'সাদেক ভাই' });

    await customerService.updateCustomer(SHOP, USER, CUSTOMER, { name: 'সাদেক ভাই' }, separate());

    expect(row.localName).toBe('সাদেক ভাই');
    expect(row.save).toHaveBeenCalled();
    // The whole point: the other branches still see "Sadek".
    expect(doc.name).toBe('Sadek');
  });

  it('still writes phone and address to the shared document', async () => {
    // A corrected number MUST reach every branch — that is the difference
    // between fixing the confusion and burying it.
    const doc = stubCustomer();
    stubRow();
    jest.spyOn(customerService, '_applyBranchFigures').mockResolvedValue({});
    jest.spyOn(Customer, 'findOne')
      .mockResolvedValueOnce(doc)   // the load
      .mockResolvedValueOnce(null); // the phone-conflict check

    await customerService.updateCustomer(
      SHOP, USER, CUSTOMER, { phone: '01911223344', address: 'Uttara' }, separate()
    );

    expect(doc.phone).toBe('01911223344');
    expect(doc.address).toBe('Uttara');
    expect(doc.save).toHaveBeenCalled();
  });

  it('drops the override when the branch types the shared name back', async () => {
    // So a branch can always return to "just use the shop-wide name" without
    // needing a separate control for it.
    stubCustomer();
    const row = stubRow({ localName: 'সাদেক ভাই' });
    jest.spyOn(customerService, '_applyBranchFigures').mockResolvedValue({});

    await customerService.updateCustomer(SHOP, USER, CUSTOMER, { name: 'Sadek' }, separate());

    expect(row.localName).toBeNull();
  });

  it('drops the override when the name is cleared', async () => {
    stubCustomer();
    const row = stubRow({ localName: 'সাদেক ভাই' });
    jest.spyOn(customerService, '_applyBranchFigures').mockResolvedValue({});

    await customerService.updateCustomer(SHOP, USER, CUSTOMER, { name: '   ' }, separate());

    expect(row.localName).toBeNull();
  });

  it('refuses to edit a customer this branch does not serve', async () => {
    // Previously ANY reachable id was editable from any branch — which is how
    // one branch rewrote another's customer in the first place.
    stubCustomer();
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(null);

    await expect(
      customerService.updateCustomer(SHOP, USER, CUSTOMER, { name: 'X' }, separate())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('renaming with a shared book', () => {
  it('writes the name to the shared document, as before', async () => {
    // Shared mode means one book on purpose. Nothing here changed.
    const doc = stubCustomer();
    const balanceFind = jest.spyOn(CustomerBalance, 'findOne');

    await customerService.updateCustomer(SHOP, USER, CUSTOMER, { name: 'সাদেক মিয়া' }, shared());

    expect(doc.name).toBe('সাদেক মিয়া');
    expect(balanceFind).not.toHaveBeenCalled();
  });
});

describe('resolving the name on reads', () => {
  it('shows the branch label and carries the shared one alongside', async () => {
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({
      lean: async () => ({ localName: 'সাদেক ভাই', totalDue: 500, openingDue: 0 }),
    });

    const result = await customerService._applyBranchFigures(
      { _id: CUSTOMER, name: 'Sadek', toObject() { return { _id: CUSTOMER, name: 'Sadek' }; } },
      SHOP, BRANCH_A
    );

    expect(result.name).toBe('সাদেক ভাই');
    // So a screen can show "সব শাখায়: Sadek" rather than silently presenting a
    // name the rest of the shop does not use.
    expect(result.sharedName).toBe('Sadek');
    expect(result.hasLocalName).toBe(true);
    // Money is per-branch and unaffected by any of this.
    expect(result.totalDue).toBe(500);
  });

  it('falls back to the shared name with no override', async () => {
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({
      lean: async () => ({ localName: null, totalDue: 0 }),
    });

    const result = await customerService._applyBranchFigures(
      { _id: CUSTOMER, name: 'Sadek', toObject() { return { _id: CUSTOMER, name: 'Sadek' }; } },
      SHOP, BRANCH_A
    );

    expect(result.name).toBe('Sadek');
    expect(result.sharedName).toBeNull();
  });

  it('does not flag sharedName when the two happen to match', async () => {
    // An identical "সব শাখায়: X" line beside X is noise.
    jest.spyOn(CustomerBalance, 'findOne').mockReturnValue({
      lean: async () => ({ localName: 'Sadek', totalDue: 0 }),
    });

    const result = await customerService._applyBranchFigures(
      { _id: CUSTOMER, name: 'Sadek', toObject() { return { _id: CUSTOMER, name: 'Sadek' }; } },
      SHOP, BRANCH_A
    );

    expect(result.sharedName).toBeNull();
  });
});

describe('the list query', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/customer.service.js'), 'utf8');

  // Was a source-text regex (`/localName:\s*\{\s*\$regex:\s*escaped/`), which
  // broke the moment the three search sites were folded into one
  // `buildSearchOr` helper — while the behaviour it guarded was untouched. It
  // now asserts on the pipeline that actually reaches Mongo, so a future
  // refactor is free to move the code and only a real regression fails.
  it('searches the branch label as well as the shared name', async () => {
    const spy = jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{ data: [], count: [], totals: [] }]);

    await customerService.getCustomers(SHOP, { search: 'Sadek' }, separate());

    const pipeline = spy.mock.calls[0][0];
    const or = pipeline.find((s) => s.$match?.$or)?.$match.$or;

    expect(or).toEqual(expect.arrayContaining([
      { localName: { $regex: 'Sadek', $options: 'i' } },
      { 'customer.name': { $regex: 'Sadek', $options: 'i' } },
    ]));

    spy.mockRestore();
  });

  // The bug this whole change set started from: the number was stored
  // normalised and searched raw, so a shop that had the customer saved as
  // `+880 1792-449180` matched nothing.
  it('matches a phone typed in +880 form against the stored local form', async () => {
    const spy = jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{ data: [], count: [], totals: [] }]);

    await customerService.getCustomers(SHOP, { search: '+880 1792-449180' }, separate());

    const or = spy.mock.calls[0][0].find((s) => s.$match?.$or)?.$match.$or;

    expect(or).toEqual(expect.arrayContaining([
      { 'customer.phone': { $regex: '01792449180', $options: 'i' } },
    ]));

    spy.mockRestore();
  });

  it('does not add a phone term for a query with no digits in it', async () => {
    const spy = jest.spyOn(CustomerBalance, 'aggregate').mockResolvedValue([{ data: [], count: [], totals: [] }]);

    await customerService.getCustomers(SHOP, { search: 'সাদেক' }, separate());

    const or = spy.mock.calls[0][0].find((s) => s.$match?.$or)?.$match.$or;

    // Name fields plus the single raw-text phone clause, and nothing else —
    // `normalizePhone` reduces a Bengali name to '', which as a regex would
    // match every customer in the shop.
    expect(or).toHaveLength(3);

    spy.mockRestore();
  });

  it('projects the resolved name so sorting by name sorts what is displayed', () => {
    expect(src).toMatch(/name:\s*\{\s*\$ifNull:\s*\['\$localName',\s*'\$customer\.name'\]\s*\}/);
  });
});

describe('the invoice snapshot', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/sale.service.js'), 'utf8');

  it("prints the branch's name on the sale", () => {
    // customerName is a snapshot: printed, texted and reported on. Taking the
    // shop-wide name would hand a Dhaka customer an invoice in the name
    // Chittagong chose.
    expect(src).toMatch(/if\s*\(localRow\?\.localName\)\s*finalCustomerName\s*=\s*localRow\.localName/);
  });
});

/**
 * The purchase list's query contract (F-6 + the frontend filter extensions).
 *
 * The frontend agent is building against exactly this: `supplier`,
 * `startDate`/`endDate` (against the backdatable `date`), `dueOnly`, `search`
 * (invoiceNo OR supplierInvoiceNo, case-insensitive), `status=cancelled`, and
 * `includeCancelled=true` — all ANDed, all shop-scoped (I-5).
 *
 * These pin the FILTER the service builds, because a wrong filter here does
 * not throw — it returns somebody's rows or nobody's, silently.
 */

const mongoose = require('mongoose');
const purchaseService = require('../services/purchase.service');
const Purchase = require('../models/Purchase.model');

const SHOP = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();

let chain;

beforeEach(() => {
  chain = {
    populate: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve([])),
  };
  jest.spyOn(Purchase, 'find').mockReturnValue(chain);
  jest.spyOn(Purchase, 'countDocuments').mockResolvedValue(0);
});

afterEach(() => jest.restoreAllMocks());

const queryFor = async (options) => {
  await purchaseService.getPurchases(SHOP, options);
  return Purchase.find.mock.calls[0][0];
};

describe('cancelled visibility (F-6)', () => {
  it('hides cancelled bills by default', async () => {
    const q = await queryFor({});
    expect(q.shop).toBe(SHOP);
    expect(q.status).toEqual({ $ne: 'cancelled' });
  });

  it('?status=cancelled lists only the voided bills', async () => {
    const q = await queryFor({ status: 'cancelled' });
    expect(q.status).toBe('cancelled');
  });

  it('?includeCancelled=true shows them beside the live ones', async () => {
    const q = await queryFor({ includeCancelled: 'true' });
    expect(q.status).toBeUndefined();
  });
});

describe('the filter extensions', () => {
  it('casts supplier to an ObjectId explicitly', async () => {
    const q = await queryFor({ supplier: String(SUPPLIER) });
    expect(q.supplier).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(q.supplier)).toBe(String(SUPPLIER));
  });

  it('refuses a malformed supplier id with a 400, not a CastError 500', async () => {
    await expect(purchaseService.getPurchases(SHOP, { supplier: 'not-an-id' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(Purchase.find).not.toHaveBeenCalled();
  });

  it('ranges on the backdatable `date`, never createdAt', async () => {
    const q = await queryFor({ startDate: '2026-08-01', endDate: '2026-08-15' });
    expect(q.date.$gte).toBeInstanceOf(Date);
    expect(q.date.$lte).toBeInstanceOf(Date);
    expect(q.createdAt).toBeUndefined();
    // The end bound reaches the END of the Bangladesh calendar day.
    expect(q.date.$lte.getTime()).toBeGreaterThan(new Date('2026-08-15T00:00:00Z').getTime());
  });

  it('dueOnly=true means open payables: due > 0 and never cancelled', async () => {
    // A cancelled purchase keeps its stored `due` figure (the pre-save hook
    // skips cancelled docs), so the status exclusion is re-asserted even when
    // includeCancelled was also passed — a voided bill is not owed.
    const q = await queryFor({ dueOnly: 'true', includeCancelled: 'true' });
    expect(q.due).toEqual({ $gt: 0 });
    expect(q.status).toEqual({ $ne: 'cancelled' });
  });

  it('search matches invoiceNo OR supplierInvoiceNo, case-insensitive, escaped', async () => {
    const q = await queryFor({ search: 'pur(1' });
    expect(q.$or).toHaveLength(2);
    const [ours, theirs] = q.$or;
    expect(ours.invoiceNo).toBeInstanceOf(RegExp);
    expect(theirs.supplierInvoiceNo).toBeInstanceOf(RegExp);
    expect(ours.invoiceNo.flags).toContain('i');
    // The "(" survived as a literal — an unescaped one throws at construction
    // or matches the wrong rows.
    expect(ours.invoiceNo.source).toBe('pur\\(1');
    expect(ours.invoiceNo.test('PUR(123')).toBe(true);
  });

  it('everything ANDs together on one shop-scoped query (I-5)', async () => {
    const q = await queryFor({
      supplier: String(SUPPLIER),
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      dueOnly: 'true',
      search: 'PUR',
      branchId: 'branch-1',
    });
    expect(q.shop).toBe(SHOP);
    expect(q.branch).toBe('branch-1');
    expect(String(q.supplier)).toBe(String(SUPPLIER));
    expect(q.date).toBeDefined();
    expect(q.due).toEqual({ $gt: 0 });
    expect(q.$or).toHaveLength(2);
  });
});

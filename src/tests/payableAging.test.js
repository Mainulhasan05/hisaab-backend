/**
 * পাওনাদার বয়স — payables, bucketed by how long the shop has owed them.
 *
 * ── The asymmetry this closes ───────────────────────────────────────────────
 *
 * `customer.service.getDueAging` has answered "who owes me, and for how long"
 * since early on. Suppliers had no counterpart: a single `totalDue` per vendor
 * and no way to tell a bill raised last week from one sitting since April.
 *
 * That is the wrong way round for these businesses. An unprofitable month is
 * survivable and slow. A cash-flow squeeze is neither, and it arrives through
 * the payables side.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. THE DATE FIELD — payables age on `Purchase.date`, the backdatable
 *      business date, NOT on `createdAt`. This is the one place the report
 *      deliberately differs from its receivables twin, and it is the thing that
 *      would break silently if someone "made them consistent".
 *   B. OPENING PAYABLES — paper-খাতা debt with no bill behind it must appear,
 *      or the report reads ৳0 for a shop that owes ৳2 lakh.
 *   C. THE EXCLUSIONS — settled, cancelled and deleted rows leave, so the total
 *      reconciles against every other payable figure in the app.
 *   D. BRANCH — the branch that bought owes; All Branches sees the whole shop.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const supplierService = require('../services/supplier.service');
const Purchase = require('../models/Purchase.model');
const Supplier = require('../models/Supplier.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const SUP_A = new mongoose.Types.ObjectId();
const SUP_B = new mongoose.Types.ObjectId();

const stub = ({ purchases = [], adjustments = [], inactive = [] } = {}) => {
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue(purchases);
  jest.spyOn(SupplierDueAdjustment, 'aggregate').mockResolvedValue(adjustments);
  jest.spyOn(Supplier, 'find').mockImplementation((filter) => ({
    select: () => ({
      lean: async () => (filter?.isActive === false ? inactive : []),
    }),
  }));
};

/** One vendor owed across all three buckets. */
const owed = (id = SUP_A, over = {}) => ({
  _id: id,
  supplierName: 'রহিম ট্রেডার্স',
  totalDue: 6000,
  due0to30: 1000,
  due31to60: 2000,
  due60plus: 3000,
  oldestDue: new Date('2026-01-01'),
  purchaseCount: 4,
  ...over,
});

afterEach(() => jest.restoreAllMocks());

// ── A. The date field ───────────────────────────────────────────────────────

describe('A · payables age on the bill date, not on entry time', () => {
  it('buckets on Purchase.date', async () => {
    // THE REGRESSION THIS PINS. A `Purchase` carries a backdatable business
    // `date`, and every other purchase reader — the list, the supplier
    // statement, the P&L's purchase bucket — filters on it. A bill dated the
    // 3rd and entered on the 20th has been owed since the 3rd, which is what
    // the supplier will say when they call.
    //
    // Sales have no such field, so `getDueAging` uses `createdAt` there. The
    // two reports look symmetric and are not; unifying them onto one date field
    // would mis-age this side with nothing to signal it.
    stub({ purchases: [owed()] });

    await supplierService.getPayableAging(SHOP, null);

    const [[pipeline]] = Purchase.aggregate.mock.calls;
    const group = pipeline.find((s) => s.$group).$group;

    // Every bucket, and the oldest-debt marker, read `$date`.
    const asText = JSON.stringify(group);
    expect(asText).toContain('$date');
    expect(asText).not.toContain('$createdAt');
    expect(group.oldestDue).toEqual({ $min: '$date' });
  });

  it('casts both ids for the $match, because $match does not cast (I-3)', async () => {
    // A string id in an aggregation matches zero documents and raises no error.
    // The report would read ৳0 and look like a shop with nothing to pay.
    stub({ purchases: [] });

    await supplierService.getPayableAging(SHOP.toString(), { branchId: BRANCH.toString() });

    const [[pipeline]] = Purchase.aggregate.mock.calls;
    const match = pipeline.find((s) => s.$match).$match;

    expect(match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(match.branch).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});

// ── B. Debt with no bill behind it ──────────────────────────────────────────

describe('B · opening payables are part of the answer', () => {
  it('merges an adjustment onto a supplier that also has bills', async () => {
    stub({
      purchases: [owed(SUP_A, { totalDue: 5000, due0to30: 5000, due31to60: 0, due60plus: 0 })],
      adjustments: [{
        _id: SUP_A, totalDue: 2000, due0to30: 0, due31to60: 2000, due60plus: 0,
        oldestDue: new Date('2025-06-01'),
      }],
    });

    const { suppliers, summary } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].totalDue).toBe(7000);
    expect(suppliers[0].due31to60).toBe(2000);
    // The older of the two claims wins the marker — it is the oldest thing owed.
    expect(suppliers[0].oldestDue).toEqual(new Date('2025-06-01'));
    expect(summary.totalDue).toBe(7000);
  });

  it('surfaces a supplier with opening debt and no bills at all', async () => {
    // THE ONBOARDING CASE. Aging reads `Purchase.due`; a shop that signed up
    // owing ৳2 lakh on paper has no bills of ours behind it. Without this pass
    // the one report built to show that debt is the only screen that reads ৳0.
    stub({
      purchases: [],
      adjustments: [{
        _id: SUP_B, totalDue: 200000, due0to30: 200000, due31to60: 0, due60plus: 0,
        oldestDue: new Date('2026-08-01'),
      }],
    });
    jest.spyOn(Supplier, 'find').mockImplementation((filter) => ({
      select: () => ({
        lean: async () => (filter?.isActive === false
          ? []
          : [{ _id: SUP_B, name: 'করিম এন্টারপ্রাইজ', phone: '01711223344' }]),
      }),
    }));

    const { suppliers } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers).toHaveLength(1);
    // The name is looked up, because an adjustment row carries only an id.
    expect(suppliers[0].supplierName).toBe('করিম এন্টারপ্রাইজ');
    expect(suppliers[0].totalDue).toBe(200000);
    expect(suppliers[0].purchaseCount).toBe(0);
  });

  it('lets a negative correction reduce a payable', async () => {
    // `amount` is a signed delta — a correction can go either way. Filtering
    // per row rather than after grouping would drop the correction and leave
    // the payable overstated by exactly it.
    stub({
      purchases: [owed(SUP_A, { totalDue: 5000, due0to30: 5000, due31to60: 0, due60plus: 0 })],
      adjustments: [{
        _id: SUP_A, totalDue: -1500, due0to30: -1500, due31to60: 0, due60plus: 0,
        oldestDue: new Date('2026-08-20'),
      }],
    });

    const { suppliers } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers[0].totalDue).toBe(3500);
  });
});

// ── C. The exclusions ───────────────────────────────────────────────────────

describe('C · the total reconciles with every other payable figure', () => {
  it('excludes cancelled bills and settled ones at the source', async () => {
    stub({ purchases: [] });

    await supplierService.getPayableAging(SHOP, null);

    const [[pipeline]] = Purchase.aggregate.mock.calls;
    const match = pipeline.find((s) => s.$match).$match;

    expect(match.due).toEqual({ $gt: 0 });
    expect(match.status).toEqual({ $ne: 'cancelled' });
  });

  it('drops a supplier settled to exactly zero', async () => {
    // Leaving them at ৳0 pads the list with rows there is nothing to pay, which
    // is how a chase list stops being read.
    stub({ purchases: [owed(SUP_A, { totalDue: 0, due0to30: 0, due31to60: 0, due60plus: 0 })] });

    const { suppliers, summary } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers).toHaveLength(0);
    expect(summary.supplierCount).toBe(0);
  });

  it('drops soft-deleted suppliers', async () => {
    // The same population every other payable figure counts. Without this the
    // aging total is the one number on the page that still includes deleted
    // suppliers, and a shop reconciling against the supplier list finds a gap
    // with nothing to explain it.
    stub({
      purchases: [owed(SUP_A), owed(SUP_B, { supplierName: 'বন্ধ ভেন্ডর', totalDue: 999 })],
      inactive: [{ _id: SUP_B }],
    });

    const { suppliers, summary } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers.map((s) => String(s._id))).toEqual([String(SUP_A)]);
    expect(summary.totalDue).toBe(6000);
  });

  it('keeps a bill with no supplier attached', async () => {
    // It groups under `_id: null` and has no document to look up. The deleted
    // check is written as "drop what is positively known to be deleted" rather
    // than "keep what came back active" precisely so this debt survives —
    // inverting it would silently discard it.
    stub({ purchases: [owed(null, { supplierName: '', totalDue: 1200 })] });

    const { suppliers, summary } = await supplierService.getPayableAging(SHOP, null);

    expect(suppliers).toHaveLength(1);
    expect(summary.totalDue).toBe(1200);
  });
});

// ── D. Branch ───────────────────────────────────────────────────────────────

describe('D · the branch that bought is the branch that owes', () => {
  it('scopes both queries to the active branch', async () => {
    stub({ purchases: [] });

    await supplierService.getPayableAging(SHOP, { branchId: BRANCH });

    const purchaseMatch = Purchase.aggregate.mock.calls[0][0].find((s) => s.$match).$match;
    const adjMatch = SupplierDueAdjustment.aggregate.mock.calls[0][0].find((s) => s.$match).$match;

    expect(String(purchaseMatch.branch)).toBe(String(BRANCH));
    expect(String(adjMatch.branch)).toBe(String(BRANCH));
  });

  it('sends no branch predicate at all in All Branches', async () => {
    // I-1: for a single-branch shop `req.branchId` is null and the query must
    // be exactly what it would have been with no branch dimension in the
    // system. `{ branch: undefined }` is not that — Mongoose strips it from a
    // `find`, but this is an aggregation, where it is a live predicate.
    stub({ purchases: [] });

    await supplierService.getPayableAging(SHOP, { branchId: null });

    const match = Purchase.aggregate.mock.calls[0][0].find((s) => s.$match).$match;
    expect('branch' in match).toBe(false);
  });
});

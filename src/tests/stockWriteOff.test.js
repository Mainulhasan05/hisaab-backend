/**
 * ক্ষতি — stock written off as a loss, and the P&L term it feeds.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `getProfitLoss` derives COGS as `merchandiseRevenue − Sale.profit`. That
 * identity comes out of `Sale.pre('save')`, which builds profit from line
 * margins — so by construction COGS can only ever hold the cost of goods that
 * were SOLD. Goods that expired, broke or walked out of the door appear in no
 * Sale, so no rearrangement of the sales figures can find them.
 *
 * Before this, they left inventory through `updateStock` — a recount, carrying
 * no cost and reaching no report. Net profit was overstated by every taka of
 * shrinkage, which at the 2–4% a grocery actually runs is roughly a full month
 * of net profit a year, in the direction that makes an owner over-draw.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. THE GUARD — you cannot lose what you do not have. Writing off more than
 *      is on the shelf books a cost for goods the shop never held.
 *   B. THE VALUATION — cost is snapshotted at write-off time, variant before
 *      product, and the ledger row is signed like every other stock movement.
 *   C. THE P&L TERM — `netProfit` carries it, `grossProfit` does not, and the
 *      `merchandiseRevenue − cogs === grossProfit` identity still holds.
 *   D. THE NON-EVENT — a shop that has never written anything off must read
 *      exactly the numbers it read before this shipped.
 *   E. THE SANITISER — the figure reveals the cost basis and must not reach
 *      anyone who may not see `buyingPrice`.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const productService = require('../services/product.service');
const reportService = require('../services/report.service');
const cacheService = require('../services/cache.service');
const Product = require('../models/Product.model');
const StockTransaction = require('../models/StockTransaction.model');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const SalesReturn = require('../models/SalesReturn.model');
const Purchase = require('../models/Purchase.model');
const AccountTransfer = require('../models/AccountTransfer.model');
const { sanitizeReport } = require('../utils/dataSanitizer.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const PRODUCT = new mongoose.Types.ObjectId();
const VARIANT = new mongoose.Types.ObjectId();

/** A request with a branch active and no opt-in capabilities — the default shop. */
const req = () => ({
  shop: { _id: SHOP, features: {} },
  branchId: BRANCH,
  user: { _id: USER },
});

/** A plain product: 20 on the shelf at ৳50 cost. */
const product = (over = {}) => ({
  _id: PRODUCT,
  shop: SHOP,
  branch: BRANCH,
  name: 'চাল',
  code: 'P-1',
  type: 'simple',
  stock: 20,
  buyingPrice: 50,
  sellingPrice: 70,
  hasVariants: false,
  variants: [],
  batches: [],
  trackBatches: false,
  save: jest.fn().mockResolvedValue(true),
  markModified: jest.fn(),
  ...over,
});

const stubWriteOff = (doc) => {
  jest.spyOn(Product, 'findOne').mockResolvedValue(doc);
  jest.spyOn(StockTransaction, 'create').mockResolvedValue({});
  jest.spyOn(cacheService, 'bumpShopCacheVersion').mockResolvedValue(1);
  // `_transformProduct` is the shared response shaper; it is not what this
  // file is about, so it is stubbed to hand the document straight back.
  jest.spyOn(productService, '_transformProduct').mockImplementation((p) => p);
};

afterEach(() => jest.restoreAllMocks());

// ── A. The guard ────────────────────────────────────────────────────────────

describe('A · you cannot lose what you do not have', () => {
  it('refuses a write-off larger than the stock on hand', async () => {
    // THE REGRESSION. Writing off 30 when 8 are there drives stock negative AND
    // books ৳1,100 of cost for goods the shop never held — a loss that did not
    // happen, landing in a figure the owner reads as one that did. A recount is
    // the right tool for a wrong count and it is one screen away.
    const doc = product({ stock: 8 });
    stubWriteOff(doc);

    await expect(
      productService.writeOffStock(SHOP, USER, PRODUCT, { quantity: 30, reason: 'lost' }, req())
    ).rejects.toThrow(/only 8 in stock|8/);

    expect(StockTransaction.create).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('allows writing off the entire shelf', async () => {
    // The boundary is `>`, not `>=`. A carton that all spoiled is the ordinary
    // case, and refusing it would send the shopkeeper back to the recount screen
    // — which is exactly the path that loses the cost.
    const doc = product({ stock: 8 });
    stubWriteOff(doc);

    await productService.writeOffStock(SHOP, USER, PRODUCT, { quantity: 8, reason: 'damaged' }, req());

    expect(doc.stock).toBe(0);
    expect(StockTransaction.create).toHaveBeenCalled();
  });
});

// ── B. The valuation and the ledger row ─────────────────────────────────────

describe('B · the row carries the cost, signed like every other movement', () => {
  it('values at the cost basis of the day and stores a negative quantity', async () => {
    const doc = product({ stock: 20, buyingPrice: 50 });
    stubWriteOff(doc);

    await productService.writeOffStock(
      SHOP, USER, PRODUCT, { quantity: 3, reason: 'expired', notes: 'back shelf' }, req()
    );

    const row = StockTransaction.create.mock.calls[0][0];
    expect(row.type).toBe('damage');
    expect(row.writeOffReason).toBe('expired');
    expect(row.unitCost).toBe(50);
    expect(row.totalCost).toBe(150);
    // Signed, so the ledger's own arithmetic holds for this row too:
    //   previousStock + quantity === newStock
    expect(row.quantity).toBe(-3);
    expect(row.previousStock + row.quantity).toBe(row.newStock);
    expect(row.newStock).toBe(17);
    expect(doc.stock).toBe(17);
  });

  it('takes the variant cost, not the product one', async () => {
    // A product's `buyingPrice` is the fallback and is often stale on a
    // variant-bearing item. Valuing a written-off variant at it would report a
    // loss the shop did not take — in either direction.
    const doc = product({
      hasVariants: true,
      stock: 0,
      buyingPrice: 50,
      variants: [{ _id: VARIANT, sku: 'V-1', stock: 10, buyingPrice: 80, attributes: { size: 'L' } }],
    });
    doc.variants.id = (id) => doc.variants.find((v) => String(v._id) === String(id));
    stubWriteOff(doc);

    await productService.writeOffStock(
      SHOP, USER, PRODUCT, { quantity: 2, variantId: VARIANT, reason: 'damaged' }, req()
    );

    const row = StockTransaction.create.mock.calls[0][0];
    expect(row.unitCost).toBe(80);
    expect(row.totalCost).toBe(160);
    expect(doc.variants[0].stock).toBe(8);
  });

  it('retires the cached report generation immediately, not on the 30s debounce', async () => {
    // A write-off is a deliberate act the owner performs and then goes to look
    // at. Serving them the P&L they had before reads as the feature not
    // working, and the natural response is to do it again — writing the loss
    // off twice.
    const doc = product();
    stubWriteOff(doc);

    await productService.writeOffStock(SHOP, USER, PRODUCT, { quantity: 1, reason: 'lost' }, req());

    expect(cacheService.bumpShopCacheVersion).toHaveBeenCalledWith(SHOP, 0);
  });
});

// ── C/D. The P&L term ───────────────────────────────────────────────────────

/**
 * Stub the nine aggregations `getProfitLoss` runs, in the order `Promise.all`
 * evaluates them. `mockResolvedValueOnce` chains rather than a single value
 * because `Sale` and `Expense` are each queried more than once and the calls
 * mean different things.
 */
const stubProfitLoss = ({ shrinkage = [] } = {}) => {
  jest.spyOn(cacheService, 'getShopCacheVersion').mockResolvedValue(1);
  jest.spyOn(cacheService, 'get').mockResolvedValue(null);
  jest.spyOn(cacheService, 'set').mockResolvedValue(true);

  jest.spyOn(Sale, 'aggregate')
    // 1. summary — ৳10,000 of merchandise, ৳3,000 margin on it
    .mockResolvedValueOnce([{
      totalRevenue: 10000, totalProfit: 3000, totalPaid: 10000, totalDue: 0,
      totalDiscount: 0, totalLineDiscount: 0, totalTax: 0, totalDelivery: 0, count: 5,
    }])
    // 6. daily chart
    .mockResolvedValueOnce([]);

  jest.spyOn(Expense, 'aggregate')
    .mockResolvedValueOnce([{ totalExpenses: 1000, count: 2 }])  // 2. total
    .mockResolvedValueOnce([])                                    // 3. by category
    .mockResolvedValueOnce([]);                                   // 7. daily

  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
  jest.spyOn(AccountTransfer, 'aggregate').mockResolvedValue([]);
  jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue(shrinkage);
};

describe('C · the P&L carries shrinkage, and only where it belongs', () => {
  it('subtracts written-off cost from netProfit', async () => {
    stubProfitLoss({
      shrinkage: [
        { _id: 'expired', total: 400, count: 3 },
        { _id: 'damaged', total: 100, count: 1 },
      ],
    });

    const pl = await reportService.getProfitLoss(SHOP, {}, null);

    expect(pl.shrinkage).toBe(500);
    // 3000 margin − 1000 expenses − 0 charges − 500 shrinkage
    expect(pl.netProfit).toBe(1500);
  });

  it('leaves grossProfit and the COGS identity untouched', async () => {
    // Shrinkage does NOT go into `cogs`. `merchandiseRevenue − cogs ===
    // grossProfit` is what `Sale.pre('save')` computes per invoice, and the P&L
    // strips tax and delivery out of revenue specifically so the three tie out.
    // Folding a write-off in would break the tie and make gross margin
    // unreadable — there is no revenue on the other side of a loss to earn it
    // against.
    stubProfitLoss({ shrinkage: [{ _id: 'lost', total: 900, count: 2 }] });

    const pl = await reportService.getProfitLoss(SHOP, {}, null);

    expect(pl.grossProfit).toBe(3000);
    expect(pl.merchandiseRevenue - pl.cogs).toBe(pl.grossProfit);
  });

  it('reports the reason split, because the total alone is unactionable', async () => {
    // "৳12,000 lost" is a number an owner can do nothing with. "৳9,000 of it
    // expired" tells them to order smaller and more often; "৳9,000 walked" is a
    // different conversation entirely.
    stubProfitLoss({
      shrinkage: [
        { _id: 'expired', total: 900, count: 4 },
        { _id: 'lost', total: 300, count: 1 },
      ],
    });

    const pl = await reportService.getProfitLoss(SHOP, {}, null);

    expect(pl.writeOffs.totalCost).toBe(1200);
    expect(pl.writeOffs.byReason).toEqual([
      { reason: 'expired', totalCost: 900, count: 4 },
      { reason: 'lost', totalCost: 300, count: 1 },
    ]);
  });
});

describe('D · a shop that has written nothing off reads exactly what it read before', () => {
  it('is a no-op when the stock ledger has no damage rows', async () => {
    // On the day this shipped that was every shop. The feature must cost them
    // nothing — not a taka of movement in `netProfit`, not a section of zeroes
    // on the screen.
    stubProfitLoss({ shrinkage: [] });

    const pl = await reportService.getProfitLoss(SHOP, {}, null);

    expect(pl.shrinkage).toBe(0);
    expect(pl.netProfit).toBe(2000); // 3000 − 1000, exactly as before
    expect(pl.writeOffs.byReason).toEqual([]);
  });
});

// ── E. The sanitiser ────────────────────────────────────────────────────────

describe('E · the figure reveals the cost basis, so it is a cost key', () => {
  // Permissions live on `req.user.permissions` — `canViewCost` reads them from
  // there. This viewer MAY see profit and MAY NOT see cost, which is the exact
  // combination that makes this test meaningful: a fixture denying both would
  // pass whether or not `shrinkage` is a cost key.
  const noCost = {
    user: {
      isOwner: false,
      permissions: { products: { view_cost: false }, reports: { view_profit: true } },
    },
  };

  it('strips shrinkage and the write-off costs from a viewer without view_cost', () => {
    // A write-off row carries a QUANTITY. Anyone who can read its value can
    // divide the two and recover the buying price the shop withholds from them
    // — the same trap `packUnitCost` was added to close.
    const out = sanitizeReport(
      {
        shrinkage: 500,
        writeOffs: { totalCost: 500, byReason: [{ reason: 'expired', totalCost: 500, count: 3 }] },
        revenue: 10000,
      },
      noCost
    );

    expect(out.shrinkage).toBeUndefined();
    expect(out.writeOffs.totalCost).toBeUndefined();
    expect(out.writeOffs.byReason[0].totalCost).toBeUndefined();
    // The non-cost shape survives, so the client still knows a write-off
    // happened and how many — it just cannot price it.
    expect(out.writeOffs.byReason[0].count).toBe(3);
    expect(out.revenue).toBe(10000);
  });
});

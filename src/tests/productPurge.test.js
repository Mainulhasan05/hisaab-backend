/**
 * Product purge — the first hard delete the admin console has had since
 * `purgeShop` was disabled.
 *
 * `utils/deletionDisabled.util.js` set three conditions for reintroducing any
 * deletion. These tests pin all three plus the eligibility rules, because the
 * failure mode is not an exception — it is data that is simply gone.
 *
 * The rule the whole feature rests on: **a product is erased only if it is
 * already soft-deleted AND nothing references it**, re-verified server-side at
 * submit time rather than trusted from whatever the console last displayed.
 */

jest.mock('../utils/authCache.util', () => ({
  invalidateShopAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserAuthCache: jest.fn().mockResolvedValue(undefined),
  invalidateBranchCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

const mongoose = require('mongoose');
const adminService = require('../services/admin.service');
const Product = require('../models/Product.model');
const Sale = require('../models/Sale.model');
const StockTransaction = require('../models/StockTransaction.model');
const Admin = require('../models/Admin.model');
const AuditLog = require('../models/AuditLog.model');

const ADMIN = new mongoose.Types.ObjectId();
const SHOP = new mongoose.Types.ObjectId();
const P1 = new mongoose.Types.ObjectId();
const P2 = new mongoose.Types.ObjectId();

/** A step-up that succeeds, so tests can focus on the eligibility rules. */
const allowStepUp = () =>
  jest.spyOn(Admin, 'findById').mockReturnValue({
    select: () => Promise.resolve({ comparePassword: async () => true }),
  });

/** `Product.find({...}).select(...).lean()` returning the given docs. */
const stubProductFind = (docs) =>
  jest.spyOn(Product, 'find').mockReturnValue({
    select: () => ({ lean: async () => docs }),
  });

beforeEach(() => {
  jest.spyOn(Product, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
  jest.spyOn(StockTransaction, 'deleteMany').mockResolvedValue({ deletedCount: 3 });
  // The driver handle, not `Sale.deleteOne`. The service deliberately reaches
  // beneath Mongoose here because `immutableGuard` blocks the model method —
  // see the note at that call site. Stubbing the model method instead is what
  // hid a live 403 for as long as this test has existed.
  jest.spyOn(Sale.collection, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
});

afterEach(() => jest.restoreAllMocks());

describe('step-up authentication', () => {
  it('refuses without a password, before reading anything', async () => {
    const find = jest.spyOn(Product, 'find');

    await expect(
      adminService.purgeProducts(ADMIN, { productIds: [String(P1)] })
    ).rejects.toMatchObject({ statusCode: 401 });

    // Not merely refused — refused before the products were even looked up.
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses on a wrong password', async () => {
    jest.spyOn(Admin, 'findById').mockReturnValue({
      select: () => Promise.resolve({ comparePassword: async () => false }),
    });

    await expect(
      adminService.purgeProducts(ADMIN, { productIds: [String(P1)], password: 'nope' })
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(Product.deleteOne).not.toHaveBeenCalled();
  });
});

describe('eligibility', () => {
  it('erases a deleted product that nothing references', async () => {
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'Test product', code: 'T-1', shop: SHOP }]);
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: true, blockers: [], cancelledSales: 0 },
    });

    const result = await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
    });

    expect(result.summary.purged).toBe(1);
    expect(Product.deleteOne).toHaveBeenCalledWith({ _id: String(P1) });
    expect(StockTransaction.deleteMany).toHaveBeenCalledWith({ product: String(P1) });
  });

  it('refuses a product that is on an active invoice', async () => {
    // The rule the user asked for, and the one that protects a real invoice
    // from becoming unreadable.
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'Sold product', shop: SHOP }]);
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: false, blockers: ['২টি সক্রিয় ইনভয়েসে আছে'], cancelledSales: 0 },
    });

    const result = await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
    });

    expect(result.summary.purged).toBe(0);
    expect(result.refused[0].reason).toMatch(/সক্রিয় ইনভয়েসে/);
    expect(Product.deleteOne).not.toHaveBeenCalled();
  });

  it('never touches a product that is not soft-deleted', async () => {
    // `Product.find` is filtered on `isDeleted: true`, so a live id comes back
    // empty and is reported rather than silently ignored.
    allowStepUp();
    stubProductFind([]); // nothing matched isDeleted: true
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({});

    const result = await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
    });

    expect(result.summary.purged).toBe(0);
    expect(result.refused[0].reason).toMatch(/ডিলিট করা অবস্থায় নেই/);
    expect(Product.deleteOne).not.toHaveBeenCalled();
  });

  it('re-checks links itself rather than trusting the console', async () => {
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'x', shop: SHOP }]);
    const inspect = jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: true, blockers: [], cancelledSales: 0 },
    });

    await adminService.purgeProducts(ADMIN, { productIds: [String(P1)], password: 'ok' });

    // A preview taken minutes ago cannot authorise the delete.
    expect(inspect).toHaveBeenCalledWith([String(P1)]);
  });
});

describe('cancelled invoices', () => {
  const linksWithCancelled = () =>
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: true, blockers: [], cancelledSales: 2 },
    });

  it('refuses by default when only cancelled invoices remain', async () => {
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'x', shop: SHOP }]);
    linksWithCancelled();

    const result = await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
    });

    expect(result.summary.purged).toBe(0);
    expect(result.refused[0].reason).toMatch(/বাতিল ইনভয়েসে/);
  });

  it('removes them only when explicitly opted in', async () => {
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'x', shop: SHOP }]);
    linksWithCancelled();
    jest.spyOn(Sale, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ _id: 'S1', invoiceNo: 'INV-1' }] }),
    });

    const result = await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
      purgeCancelledInvoices: true,
    });

    expect(result.summary.purged).toBe(1);
    // One call per document, through the driver handle. `Sale.deleteOne` is
    // guarded and would 403 the whole purge — this assertion is what keeps
    // someone from "simplifying" it back.
    expect(Sale.collection.deleteOne).toHaveBeenCalledWith({ _id: 'S1' });
  });

  it('does not reach for the guarded model method', async () => {
    // The regression. Against the old code this purge threw 403 before
    // returning, and the suite never noticed because `Sale.deleteOne` was
    // mocked out from under the guard.
    const guarded = jest.spyOn(Sale, 'deleteOne');
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'x', shop: SHOP }]);
    linksWithCancelled();
    jest.spyOn(Sale, 'find').mockReturnValue({
      select: () => ({ lean: async () => [{ _id: 'S1', invoiceNo: 'INV-1' }] }),
    });

    await adminService.purgeProducts(ADMIN, {
      productIds: [String(P1)],
      password: 'ok',
      purgeCancelledInvoices: true,
    });

    expect(guarded).not.toHaveBeenCalled();
  });

  it('the guard really does refuse the model method', async () => {
    // Pins the premise the call site rests on. If `immutableGuard` ever stops
    // covering the query form, the raw-driver detour becomes unnecessary and
    // this test says so.
    await expect(Sale.deleteOne({ _id: 'S1' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('audit trail', () => {
  it('records intent with before-state BEFORE deleting anything', async () => {
    allowStepUp();
    stubProductFind([{ _id: P1, name: 'x', code: 'C', shop: SHOP }]);
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: true, blockers: [], cancelledSales: 0 },
    });

    const order = [];
    AuditLog.create.mockImplementation(async (doc) => {
      order.push(doc.action);
      return {};
    });
    Product.deleteOne.mockImplementation(async () => {
      order.push('DELETE');
      return { deletedCount: 1 };
    });

    await adminService.purgeProducts(ADMIN, { productIds: [String(P1)], password: 'ok' });

    // The exact ordering deletionDisabled.util.js demands: if the process dies
    // mid-purge, the record of what was attempted survives.
    expect(order).toEqual(['product_purge_begin', 'DELETE', 'product_purge']);
  });
});

describe('media cascade', () => {
  const mediaService = require('../services/media.service');

  it('releases the product photos so the reclamation sweep can collect them', async () => {
    const mediaId = new mongoose.Types.ObjectId();
    const variantMediaId = new mongoose.Types.ObjectId();

    allowStepUp();
    stubProductFind([{
      _id: P1,
      name: 'Test product',
      code: 'T-1',
      shop: SHOP,
      catalogImages: [{ mediaId }],
      variants: [{ sku: 'v1', imageMediaId: variantMediaId }],
    }]);
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: true, blockers: [], cancelledSales: 0 },
    });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });

    await adminService.purgeProducts(ADMIN, { productIds: [String(P1)], password: 'ok' });

    // For products soft-deleted before `deleteProduct` started detaching, this
    // is the ONLY thing that ever decrements their refCount — without it the
    // purge frees the row and leaves the bytes charged to the shop forever.
    const [shop, previous, next] = reconcile.mock.calls[0];
    expect(String(shop)).toBe(String(SHOP));
    expect(previous.map(String).sort()).toEqual([String(mediaId), String(variantMediaId)].sort());
    expect(next).toEqual([]);
  });

  it('does not release photos of a product it refused to purge', async () => {
    allowStepUp();
    stubProductFind([{
      _id: P1, name: 'Linked', code: 'T-1', shop: SHOP,
      catalogImages: [{ mediaId: new mongoose.Types.ObjectId() }],
      variants: [],
    }]);
    jest.spyOn(adminService, 'inspectProductLinks').mockResolvedValue({
      [String(P1)]: { safeToPurge: false, blockers: ['২টি ইনভয়েসে আছে'], cancelledSales: 0 },
    });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const reconcile = jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });

    await adminService.purgeProducts(ADMIN, { productIds: [String(P1)], password: 'ok' });

    // The product is still live. Releasing its reference would hand its photo to
    // the orphan sweep while the product is still showing it.
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('batch limits', () => {
  it('refuses an oversized batch', async () => {
    const ids = Array.from({ length: 501 }, () => String(new mongoose.Types.ObjectId()));
    await expect(
      adminService.purgeProducts(ADMIN, { productIds: ids, password: 'ok' })
    ).rejects.toThrow();
  });

  it('refuses an empty selection', async () => {
    await expect(
      adminService.purgeProducts(ADMIN, { productIds: [], password: 'ok' })
    ).rejects.toThrow();
  });
});

describe('inspectProductLinks', () => {
  it('returns an empty map for no ids rather than scanning every sale', async () => {
    const agg = jest.spyOn(Sale, 'aggregate');
    expect(await adminService.inspectProductLinks([])).toEqual({});
    expect(agg).not.toHaveBeenCalled();
  });

  it('ignores malformed ids instead of throwing a cast error', async () => {
    const agg = jest.spyOn(Sale, 'aggregate');
    expect(await adminService.inspectProductLinks(['not-an-objectid'])).toEqual({});
    expect(agg).not.toHaveBeenCalled();
  });

  it('marks a product with only cancelled invoices as safe, but reports them', async () => {
    jest.spyOn(Sale, 'aggregate').mockResolvedValue([
      { _id: P2, activeCount: 0, cancelledCount: 3, samples: [] },
    ]);
    jest.spyOn(require('../models/Purchase.model'), 'aggregate').mockResolvedValue([]);
    jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue([]);
    jest.spyOn(require('../models/HeldCart.model'), 'aggregate').mockResolvedValue([]);

    const links = await adminService.inspectProductLinks([String(P2)]);

    // Safe, because nothing LIVE points at it — but the caller still has to opt
    // in to removing the cancelled invoices.
    expect(links[String(P2)].safeToPurge).toBe(true);
    expect(links[String(P2)].cancelledSales).toBe(3);
  });

  it('blocks on a purchase record even with no invoices', async () => {
    jest.spyOn(Sale, 'aggregate').mockResolvedValue([]);
    jest.spyOn(require('../models/Purchase.model'), 'aggregate').mockResolvedValue([
      { _id: P2, count: 1 },
    ]);
    jest.spyOn(StockTransaction, 'aggregate').mockResolvedValue([]);
    jest.spyOn(require('../models/HeldCart.model'), 'aggregate').mockResolvedValue([]);

    const links = await adminService.inspectProductLinks([String(P2)]);

    // A purchase naming a missing product breaks the supplier ledger the same
    // way a sale breaks an invoice.
    expect(links[String(P2)].safeToPurge).toBe(false);
    expect(links[String(P2)].blockers.join()).toMatch(/ক্রয় রেকর্ডে/);
  });
});

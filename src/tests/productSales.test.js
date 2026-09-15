/**
 * পণ্যভিত্তিক বিক্রি — every sale line of a product, with seller, invoice,
 * customer and price.
 *
 * The aggregation itself was exercised against real data (see the PR notes);
 * these pin the parts a mocked model CAN pin: the filter the pipeline is given
 * (ids cast, shop always present, cancelled rows listed but not totalled), the
 * per-user cost strip, the route gate, and the sale-time ledger reference.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const User = require('../models/User.model');
const Branch = require('../models/Branch.model');
const Product = require('../models/Product.model');
const service = require('../services/productSales.service');
const { sanitizeReport } = require('../utils/dataSanitizer.util');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const PRODUCT = new mongoose.Types.ObjectId();
const STAFF = new mongoose.Types.ObjectId();

const lean = (value) => ({
  select: () => ({ lean: async () => value, sort: () => ({ lean: async () => value }) }),
});

let pipelines;

beforeEach(() => {
  jest.restoreAllMocks();
  pipelines = [];
  jest.spyOn(Sale, 'aggregate').mockImplementation(async (p) => {
    pipelines.push(p);
    return [{
      rows: [{
        lineId: new mongoose.Types.ObjectId(), saleId: new mongoose.Types.ObjectId(),
        invoiceNo: 'INV-1', status: 'cancelled', branch: null, staffId: STAFF,
        productId: PRODUCT, productName: 'চাল', quantity: 2, unitPrice: 100,
        discount: 0, total: 200, buyingPrice: 80,
      }],
      summary: [{
        lineCount: 1, cancelledLines: 1, bills: [null], customers: [null],
        quantity: 0, grossAmount: 0, discount: 0, totalAmount: 0, totalCost: 0,
      }],
    }];
  });
  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  jest.spyOn(User, 'find').mockReturnValue(lean([{ _id: STAFF, name: 'রহিম' }]));
  jest.spyOn(Branch, 'find').mockReturnValue(lean([]));
  jest.spyOn(Product, 'findOne').mockReturnValue(lean({ _id: PRODUCT, name: 'চাল', variants: [] }));
});

describe('the filter handed to the pipeline', () => {
  it('casts every id — a string in $match matches nothing (I-3)', () => {
    const { sale, line } = service._scope(String(SHOP), {
      productId: String(PRODUCT), staffId: String(STAFF),
    }, String(BRANCH));

    expect(sale.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(sale.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(sale['items.product']).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(line['items.product']).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(sale.createdBy).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('always carries the shop, and no branch for a single-branch shop (I-1, I-5)', () => {
    const { sale } = service._scope(String(SHOP), {}, null);
    expect(String(sale.shop)).toBe(String(SHOP));
    expect('branch' in sale).toBe(false);
  });

  it('ignores a malformed id instead of throwing a CastError', () => {
    const { sale } = service._scope(String(SHOP), { productId: 'not-an-id', customerId: '123' }, null);
    expect(sale['items.product']).toBeUndefined();
    expect(sale.customer).toBeUndefined();
  });

  it('escapes the search term — a regex character is text, not a pattern', () => {
    const { line } = service._scope(String(SHOP), { search: 'INV-1 (a)' }, null);
    expect(line.$or[0].invoiceNo.$regex).toBe('INV-1 \\(a\\)');
  });

  it('lists cancelled sales by default, and filters them on request', () => {
    expect(service._scope(String(SHOP), {}, null).sale.status).toBeUndefined();
    expect(service._scope(String(SHOP), { status: 'cancelled' }, null).sale.status).toBe('cancelled');
    expect(service._scope(String(SHOP), { status: 'active' }, null).sale.status).toEqual({ $ne: 'cancelled' });
  });
});

describe('getProductSales', () => {
  it('matches the product BEFORE and AFTER the unwind — one row per line, not per bill', async () => {
    await service.getProductSales(String(SHOP), { productId: String(PRODUCT) }, null);
    const p = pipelines[0];
    const unwindAt = p.findIndex((s) => s.$unwind === '$items');
    expect(p[0].$match['items.product']).toBeDefined();
    expect(p[unwindAt + 1].$match['items.product']).toBeDefined();
  });

  it('excludes cancelled lines from every total, while still listing them', async () => {
    await service.getProductSales(String(SHOP), {}, null);
    const group = pipelines[0].at(-1).$facet.summary[0].$group;
    expect(JSON.stringify(group.totalAmount)).toContain('cancelled');
    expect(JSON.stringify(group.quantity)).toContain('cancelled');
  });

  it('a cancelled line earns no profit', async () => {
    const out = await service.getProductSales(String(SHOP), {}, null);
    expect(out.rows[0].profit).toBe(0);
  });

  it('names the seller, and a single-branch row carries no branch keys', async () => {
    const out = await service.getProductSales(String(SHOP), {}, null);
    expect(out.rows[0].staffName).toBe('রহিম');
    expect('branch' in out.rows[0]).toBe(false);
    expect('branchName' in out.rows[0]).toBe(false);
  });

  it('quantity is only summed when one product is in scope — kg plus pieces is no number', async () => {
    const all = await service.getProductSales(String(SHOP), {}, null);
    expect(all.summary.quantity).toBeNull();
    const one = await service.getProductSales(String(SHOP), { productId: String(PRODUCT) }, null);
    expect(one.summary.quantity).toBe(0);
  });

  it('caps the page size', async () => {
    const out = await service.getProductSales(String(SHOP), { limit: 99999 }, null);
    expect(out.pagination.limit).toBe(500);
  });

  it('the staff roster and the seller lookup are shop-scoped', async () => {
    await service.getProductSales(String(SHOP), {}, null);
    for (const [filter] of User.find.mock.calls) {
      expect(String(filter.shop)).toBe(String(SHOP));
    }
  });
});

describe('who may see cost', () => {
  const report = {
    rows: [{ unitPrice: 100, total: 200, buyingPrice: 80, totalCost: 160, profit: 40 }],
    summary: { totalAmount: 200, totalCost: 160, totalProfit: 40 },
  };
  const reqWith = (perms) => ({ user: { isOwner: false, permissions: perms } });

  it('strips cost and profit for a user without view_cost / view_profit', () => {
    const out = sanitizeReport(report, reqWith({ reports: { view: true } }));
    expect(out.rows[0]).not.toHaveProperty('buyingPrice');
    expect(out.rows[0]).not.toHaveProperty('totalCost');
    expect(out.rows[0]).not.toHaveProperty('profit');
    expect(out.summary).not.toHaveProperty('totalProfit');
    expect(out.rows[0].unitPrice).toBe(100);
  });
});

describe('wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('is behind reports.view', () => {
    expect(read('../routes/report.routes.js'))
      .toMatch(/router\.get\('\/product-sales', rbac\('reports', 'view'\)/);
  });

  it('has an index to find a product\'s lines by', () => {
    const indexes = Sale.schema.indexes().map(([fields]) => fields);
    expect(indexes).toContainEqual({ shop: 1, 'items.product': 1, createdAt: -1 });
  });

  it('sale-time stock rows reference the sale they belong to', () => {
    // They carried no reference at all, so the stock history could not open the
    // invoice behind a "বিক্রি" row. The id is minted before the ledger insert
    // and the same id is given to Sale.create.
    const source = read('../services/sale.service.js');
    const start = source.indexOf('async createSale(');
    const body = source.slice(start, source.indexOf('\n  async ', start + 10));
    const mintAt = body.indexOf('const newSaleId = new mongoose.Types.ObjectId()');
    const stampAt = body.indexOf("txn.reference = { type: 'sale', id: newSaleId }");
    const insertAt = body.indexOf('StockTransaction.insertMany(stockTransactions');
    const createAt = body.indexOf('_id: newSaleId');

    expect(mintAt).toBeGreaterThan(-1);
    expect(stampAt).toBeGreaterThan(mintAt);
    expect(insertAt).toBeGreaterThan(stampAt);
    expect(createAt).toBeGreaterThan(insertAt);
  });
});

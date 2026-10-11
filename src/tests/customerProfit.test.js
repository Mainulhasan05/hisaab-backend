/**
 * এই কাস্টমার থেকে লাভ — GET /customers/:id/profit.
 *
 * Models are mocked, so these pin what a mocked model CAN pin: the `$match` the
 * aggregation is handed (ids cast, shop always present, cancelled out, branch
 * only under separate books), that the figure is the stored `Sale.profit` and
 * not a line sum, the margin arithmetic, and the permission gate.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Sale = require('../models/Sale.model');
const customerService = require('../services/customer.service');
const customerController = require('../controllers/customer.controller');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();

let pipelines;

function mockSales(row) {
  jest.spyOn(Sale, 'aggregate').mockImplementation(async (p) => {
    pipelines.push(p);
    return row ? [row] : [];
  });
}

const shopReq = (shop, branchId = null, user = { isOwner: true }) => ({ shop, branchId, user });
const singleBranch = { _id: SHOP, multiBranchEnabled: false };
const separateBooks = { _id: SHOP, multiBranchEnabled: true, customerScope: 'branch' };
const sharedBook = { _id: SHOP, multiBranchEnabled: true, customerScope: 'shop' };

beforeEach(() => {
  jest.restoreAllMocks();
  pipelines = [];
  jest.spyOn(customerService, 'getCustomerById').mockResolvedValue({ _id: CUSTOMER });
});

describe('the $match', () => {
  it('casts shop and customer — a string in $match matches nothing (I-3)', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    const { $match } = pipelines[0][0];
    expect($match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
    expect($match.customer).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String($match.shop)).toBe(String(SHOP));
  });

  it('leaves out cancelled sales, which includes superseded revisions', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect(pipelines[0][0].$match.status).toEqual({ $ne: 'cancelled' });
  });

  it('carries no branch for a single-branch shop (I-1)', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect('branch' in pipelines[0][0].$match).toBe(false);
  });

  it('narrows to the branch, cast, under separate books (I-4, I-3)', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(separateBooks, String(BRANCH)));
    const { $match } = pipelines[0][0];
    expect($match.branch).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String($match.branch)).toBe(String(BRANCH));
  });

  it('stays shop-wide under a shared book, and in All Branches — same as the history tab', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(sharedBook, String(BRANCH)));
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(separateBooks, null));
    expect('branch' in pipelines[0][0].$match).toBe(false);
    expect('branch' in pipelines[1][0].$match).toBe(false);
  });

  it('applies the customer visibility rule first — 404 here means no figure', async () => {
    customerService.getCustomerById.mockRejectedValue(Object.assign(new Error('nf'), { statusCode: 404 }));
    mockSales({ profit: 999 });
    await expect(
      customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(separateBooks, String(BRANCH)))
    ).rejects.toThrow('nf');
    expect(pipelines).toHaveLength(0);
  });
});

describe('the figures', () => {
  it('sums the stored Sale.profit — net of the bill discount and returns — not the lines', async () => {
    mockSales(null);
    await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    const group = pipelines[0][1].$group;
    expect(group.profit).toEqual({ $sum: { $ifNull: ['$profit', 0] } });
    expect(JSON.stringify(group)).not.toContain('items');
  });

  it('margin is profit over merchandise net of the bill discount and of returns', async () => {
    // ৳1,100 of goods after the bill discount, ৳100 of it returned → ৳1,000
    // sold; ৳125 earned → 12.5%. VAT and delivery are not in the base.
    mockSales({ profit: 125, merchandise: 1100, returnedAmount: 100, billCount: 3 });
    const out = await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect(out).toMatchObject({ profit: 125, netSales: 1000, returnedAmount: 100, profitMargin: 12.5, billCount: 3 });
  });

  it('a loss reads as a loss', async () => {
    mockSales({ profit: -40, merchandise: 400, returnedAmount: 0, billCount: 1 });
    const out = await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect(out.profit).toBe(-40);
    expect(out.profitMargin).toBe(-10);
  });

  it('no sales → zero profit and NO margin, never "0%"', async () => {
    mockSales(null);
    const out = await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect(out).toMatchObject({ profit: 0, netSales: 0, profitMargin: null, billCount: 0, lastSale: null });
  });

  it('quantizes money — no float tails from summing paisa', async () => {
    mockSales({ profit: 0.1 + 0.2, merchandise: 10, returnedAmount: 0, billCount: 1 });
    const out = await customerService.getCustomerProfit(String(SHOP), String(CUSTOMER), shopReq(singleBranch));
    expect(out.profit).toBe(0.3);
  });
});

describe('who may see it', () => {
  const run = async (user) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    const req = { ...shopReq(singleBranch, null, user), params: { id: String(CUSTOMER) } };
    await customerController.getCustomerProfit(req, res, next);
    await new Promise((r) => setImmediate(r));
    return { res, next };
  };

  beforeEach(() => mockSales({ profit: 10, merchandise: 100, returnedAmount: 0, billCount: 1 }));

  it('403s a user without view_profit, before any query runs', async () => {
    const { res, next } = await run({ isOwner: false, permissions: { customers: { view: true } } });
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(res.json).not.toHaveBeenCalled();
    expect(pipelines).toHaveLength(0);
  });

  it.each([
    ['the owner', { isOwner: true }],
    ['sales.view_profit', { isOwner: false, permissions: { sales: { view_profit: true } } }],
    ['reports.view_profit', { isOwner: false, permissions: { reports: { view_profit: true } } }],
  ])('answers %s', async (_label, user) => {
    const { res, next } = await run(user);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.profit).toBe(10);
  });

  it('is routed behind customers.view', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../routes/customer.routes.js'), 'utf8');
    expect(routes).toMatch(
      /router\.get\('\/:id\(\[0-9a-fA-F\]\{24\}\)\/profit', rbac\('customers', 'view'\), customerController\.getCustomerProfit\)/
    );
  });
});

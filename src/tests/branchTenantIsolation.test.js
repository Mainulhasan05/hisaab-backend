/**
 * Regression tests for the two cross-tenant defects found in the multi-branch
 * audit (FEATURE_AUDIT.md C-1, C-2).
 *
 * Both bugs shared one shape: a query that was supposed to be shop-scoped went
 * out with no shop predicate at all, so it reached every tenant on the platform.
 * These tests assert the shop scope is present — they do not hit a database.
 */

const mongoose = require('mongoose');

jest.mock('../services/stockTransfer.service');
jest.mock('../models/HeldCart.model');

const stockTransferService = require('../services/stockTransfer.service');
const stockTransferController = require('../controllers/stockTransfer.controller');
const HeldCart = require('../models/HeldCart.model');
const heldCartService = require('../services/heldCart.service');

const SHOP_A = new mongoose.Types.ObjectId();
const SHOP_B = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();
const TRANSFER_ID = new mongoose.Types.ObjectId();

/** Minimal express req/res doubles matching what `protect` actually sets. */
const makeReq = (overrides = {}) => ({
  shop: { _id: SHOP_A },
  user: { _id: USER_ID, shop: SHOP_A },
  params: {},
  query: {},
  body: {},
  ...overrides,
});

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

/** asyncHandler wraps handlers, so invoke with an explicit next and surface errors. */
const invoke = async (handler, req, res) => {
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls.length && next.mock.calls[0][0]) throw next.mock.calls[0][0];
};

describe('C-1 — stock transfer handlers must scope by shop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stockTransferService.createTransfer.mockResolvedValue({});
    stockTransferService.getTransfers.mockResolvedValue({ data: [] });
    stockTransferService.getTransferById.mockResolvedValue({});
    stockTransferService.approveTransfer.mockResolvedValue({});
    stockTransferService.receiveTransfer.mockResolvedValue({});
    stockTransferService.rejectTransfer.mockResolvedValue({});
  });

  it('getTransfers passes the authenticated shop id, never undefined', async () => {
    const req = makeReq();
    await invoke(stockTransferController.getTransfers, req, makeRes());

    const [shopArg] = stockTransferService.getTransfers.mock.calls[0];
    expect(shopArg).toBeDefined();
    expect(String(shopArg)).toBe(String(SHOP_A));
  });

  it('getTransferById passes the authenticated shop id', async () => {
    const req = makeReq({ params: { id: TRANSFER_ID } });
    await invoke(stockTransferController.getTransferById, req, makeRes());

    const [, shopArg] = stockTransferService.getTransferById.mock.calls[0];
    expect(String(shopArg)).toBe(String(SHOP_A));
  });

  it.each([
    ['approveTransfer', 'approveTransfer'],
    ['receiveTransfer', 'receiveTransfer'],
    ['rejectTransfer', 'rejectTransfer'],
  ])('%s passes the authenticated shop id', async (handlerName, serviceName) => {
    const req = makeReq({ params: { id: TRANSFER_ID } });
    await invoke(stockTransferController[handlerName], req, makeRes());

    const [, shopArg] = stockTransferService[serviceName].mock.calls[0];
    expect(shopArg).toBeDefined();
    expect(String(shopArg)).toBe(String(SHOP_A));
  });

  it('createTransfer scopes to the authenticated shop and ignores a shop sent in the body', async () => {
    // A client must not be able to create a transfer inside another tenant by
    // putting `shop` in the request body.
    const req = makeReq({ body: { shop: SHOP_B, fromBranch: 'x', toBranch: 'y', items: [] } });
    await invoke(stockTransferController.createTransfer, req, makeRes());

    const [payload] = stockTransferService.createTransfer.mock.calls[0];
    expect(String(payload.shop)).toBe(String(SHOP_A));
    expect(String(payload.shop)).not.toBe(String(SHOP_B));
  });

  it('never reads req.user.currentShop — the field that did not exist', async () => {
    // The original bug: `req.user.currentShop` is undefined, Mongoose strips
    // undefined from filters, and the query escaped its tenant. Guard against a
    // reintroduction by proving the handler works on a req that has no such key.
    const req = makeReq();
    expect(req.user.currentShop).toBeUndefined();

    await invoke(stockTransferController.getTransfers, req, makeRes());

    const [shopArg] = stockTransferService.getTransfers.mock.calls[0];
    expect(shopArg).not.toBeUndefined();
  });
});

describe('C-2 — held cart expiry must be scoped to one shop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    HeldCart.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
  });

  it('includes the shop in the updateMany filter', async () => {
    await heldCartService.expireOldCarts(SHOP_A);

    expect(HeldCart.updateMany).toHaveBeenCalledTimes(1);
    const [filter] = HeldCart.updateMany.mock.calls[0];
    expect(filter.shop).toBeDefined();
    expect(String(filter.shop)).toBe(String(SHOP_A));
    expect(filter.status).toBe('held');
  });

  it('refuses to run without a shop instead of expiring every tenant', async () => {
    await expect(heldCartService.expireOldCarts(undefined)).rejects.toThrow();
    await expect(heldCartService.expireOldCarts(null)).rejects.toThrow();
    expect(HeldCart.updateMany).not.toHaveBeenCalled();
  });
});

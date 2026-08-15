/**
 * The merchant order lifecycle — service-level guards, models stubbed.
 *
 * What is asserted here is the DECISION layer: which transitions are allowed,
 * what the per-phone ceiling refuses, what the merchant projection withholds,
 * and what the order-number prefix survives. The money path (`confirmOrder` →
 * `createSale`) is exercised against real data per AGENT_WORKFLOW.md §7.2 —
 * unit mocks cannot prove a query is right, only that it was shaped.
 */

const mongoose = require('mongoose');

jest.mock('../models/Order.model', () => {
  const ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    ORDER_STATUSES,
    PRE_CONFIRM_STATUSES: ['pending', 'cancelled'],
  };
});
jest.mock('../models/OrderCounter.model', () => ({ nextSeq: jest.fn() }));
jest.mock('../models/Product.model', () => ({ find: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ updateOne: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/publicStorefront.service', () => ({
  _effective: jest.fn(() => ({ price: 100, compareAt: null })),
  _onlinePriceOf: jest.fn(() => null),
}));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Order = require('../models/Order.model');
const OrderCounter = require('../models/OrderCounter.model');
const orderService = require('../services/order.service');

const SHOP_ID = new mongoose.Types.ObjectId();
const req = () => ({ shop: { _id: SHOP_ID }, branchId: null, user: { _id: new mongoose.Types.ObjectId() } });

const leanable = (result) => ({ lean: () => Promise.resolve(result) });

beforeEach(() => jest.clearAllMocks());

describe('placeOrder — the per-phone daily ceiling', () => {
  test('REGRESSION: the eleventh storefront order from one phone today is refused with 429', async () => {
    Order.countDocuments.mockResolvedValue(10);

    await expect(
      orderService.placeOrder({
        shop: SHOP_ID,
        storefront: { delivery: { zones: [] } },
        customer: { name: 'রহিম', phone: '01712345678', address: 'ঢাকা' },
        items: [{ productId: String(new mongoose.Types.ObjectId()), quantity: 1 }],
        source: 'storefront',
      })
    ).rejects.toMatchObject({ statusCode: 429 });

    // The count was scoped to shop + phone — the index this was built for.
    const filter = Order.countDocuments.mock.calls[0][0];
    expect(String(filter.shop)).toBe(String(SHOP_ID));
    expect(filter['customer.phone']).toBe('01712345678');
  });

  test('GUARD: manual entry is exempt from the ceiling', async () => {
    // No countDocuments call should be made for source: 'manual' before line
    // resolution — the next failure is the empty product lookup, not a 429.
    Order.countDocuments.mockResolvedValue(999);
    const ProductModel = require('../models/Product.model');
    ProductModel.find.mockReturnValue({ lean: () => Promise.resolve([]) });

    await expect(
      orderService.placeOrder({
        shop: SHOP_ID,
        storefront: { delivery: { zones: [] } },
        customer: { name: 'রহিম', phone: '01712345678', address: 'ঢাকা' },
        items: [{ productId: String(new mongoose.Types.ObjectId()), quantity: 1 }],
        source: 'manual',
        onlineOnly: false,
      })
    ).rejects.toMatchObject({ statusCode: 400 }); // "product no longer available"

    expect(Order.countDocuments).not.toHaveBeenCalled();
  });
});

describe('updateStatus — the forward-only state machine', () => {
  test('packed may only leave from confirmed — the filter says so atomically', async () => {
    Order.findOneAndUpdate.mockReturnValue(leanable({ _id: 'x', status: 'packed', items: [] }));

    await orderService.updateStatus(req(), String(new mongoose.Types.ObjectId()), 'packed', {});

    const [filter, update] = Order.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({ $in: ['confirmed'] });
    expect(String(filter.shop)).toBe(String(SHOP_ID));
    expect(update.$set.status).toBe('packed');
  });

  test('REGRESSION: a pending order cannot be packed — confirm is the only door (I-9)', async () => {
    Order.findOneAndUpdate.mockReturnValue(leanable(null));
    Order.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ status: 'pending' }) }),
    });

    await expect(
      orderService.updateStatus(req(), String(new mongoose.Types.ObjectId()), 'packed', {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('confirmed/cancelled are not reachable through updateStatus at all', async () => {
    await expect(
      orderService.updateStatus(req(), 'id', 'confirmed', {})
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      orderService.updateStatus(req(), 'id', 'cancelled', {})
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(Order.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('delivered stamps deliveredAt', async () => {
    Order.findOneAndUpdate.mockReturnValue(leanable({ _id: 'x', status: 'delivered', items: [] }));

    await orderService.updateStatus(req(), String(new mongoose.Types.ObjectId()), 'delivered', {});

    const [, update] = Order.findOneAndUpdate.mock.calls[0];
    expect(update.$set.deliveredAt).toBeInstanceOf(Date);
  });
});

describe('toMerchantOrder — what staff do not see', () => {
  test('REGRESSION: items[].buyingPrice and the idempotency key never reach the panel', () => {
    const projected = orderService.toMerchantOrder({
      _id: 'x',
      orderNo: 'ORD-1',
      status: 'pending',
      customer: { name: 'ক', phone: '01712345678', address: 'ঢাকা' },
      items: [{ name: 'পণ্য', quantity: 1, unitPrice: 100, lineTotal: 100, buyingPrice: 60 }],
      subtotal: 100,
      total: 160,
      meta: { ip: '1.2.3.4', userAgent: 'ua', idempotencyKey: 'secret-key' },
    });

    expect(projected.items[0].buyingPrice).toBeUndefined();
    expect(projected.meta.idempotencyKey).toBeUndefined();
    // The forensics the shop legitimately needs stay.
    expect(projected.meta.ip).toBe('1.2.3.4');
  });
});

describe('nextOrderNo — the shop prefix', () => {
  test('REGRESSION: the stored prefix is used, not hard-coded ORD', async () => {
    OrderCounter.nextSeq.mockResolvedValue(7);
    const no = await orderService.nextOrderNo(SHOP_ID, 'SHOP1');
    expect(no).toMatch(/^SHOP1-\d{6}-0007$/);
  });

  test('a prefix that cannot survive a URL falls back to ORD', async () => {
    OrderCounter.nextSeq.mockResolvedValue(1);
    const no = await orderService.nextOrderNo(SHOP_ID, 'বাজার!');
    expect(no).toMatch(/^ORD-\d{6}-0001$/);
  });
});

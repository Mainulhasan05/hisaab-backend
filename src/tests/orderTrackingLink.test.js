/**
 * `getById().tracking` — the customer's tracking page, handed to the shopkeeper.
 *
 * ── WHY THE NULL CASES ARE THE POINT ────────────────────────────────────────
 *
 * The happy path is a string concatenation and would barely be worth a test.
 * What is worth pinning is every case that must NOT produce a link, because
 * each one fails the same way if it regresses: the panel renders a confident
 * button, the shopkeeper taps it in front of a customer on the phone, and the
 * storefront answers 404. A shop reads that as its own order having vanished,
 * not as its website being unpublished — which is the one thing this screen
 * must never suggest.
 *
 * So: live storefront, and only a live storefront, earns the link.
 *
 * ── AND WHY THE PATH IS ENCODED ─────────────────────────────────────────────
 *
 * The phone rides in the query string because the public page requires it
 * alongside the order number — order numbers are sequential and guessable, and
 * the record behind one is a name, an address and a shopping list. Encoding it
 * is not decoration: a slug or a number carrying a `&` or a `#` would truncate
 * the URL at exactly the parameter that makes it work.
 *
 * Models are stubbed (the harness from orderWorklist.test.js): this asserts a
 * decision, which needs no database.
 */

const mongoose = require('mongoose');

jest.mock('../models/Order.model', () => ({
  findOne: jest.fn(),
  ORDER_STATUSES: ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'],
  PRE_CONFIRM_STATUSES: ['pending', 'cancelled'],
}));
jest.mock('../models/OrderCounter.model', () => ({ nextSeq: jest.fn() }));
jest.mock('../models/Product.model', () => ({ find: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ findOne: jest.fn() }));
jest.mock('../services/publicStorefront.service', () => ({
  _effective: jest.fn(() => ({ price: 100, compareAt: null })),
  _onlinePriceOf: jest.fn(() => null),
}));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Order = require('../models/Order.model');
const Storefront = require('../models/Storefront.model');
const orderService = require('../services/order.service');

const SHOP_ID = new mongoose.Types.ObjectId();
const ORDER_ID = new mongoose.Types.ObjectId();

const req = (shop = {}) => ({
  shop: { _id: SHOP_ID, slug: 'rahim-store', ...shop },
  branchId: null,
  user: { _id: new mongoose.Types.ObjectId() },
});

const ORDER = {
  _id: ORDER_ID,
  shop: SHOP_ID,
  orderNo: 'ORD-260908-0001',
  status: 'pending',
  source: 'storefront',
  customer: { name: 'রহিম', phone: '01712345678', address: 'ঢাকা' },
  items: [],
  subtotal: 0,
  deliveryCharge: 0,
  total: 0,
  statusHistory: [],
  notifications: [],
};

/** `Storefront.findOne(…).select(…).lean()` */
const storefrontIs = (doc) => {
  Storefront.findOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(doc) }),
  });
};

const orderIs = (doc) => {
  Order.findOne.mockReturnValue({ lean: () => Promise.resolve(doc) });
};

beforeEach(() => {
  jest.clearAllMocks();
  orderIs(ORDER);
  storefrontIs({ status: 'live', pausedByAdmin: false });
});

describe('a live storefront earns a tracking link', () => {
  it('addresses the page by order number AND phone', async () => {
    const out = await orderService.getById(req(), ORDER_ID);
    expect(out.tracking).toEqual({
      path: '/s/rahim-store/order/ORD-260908-0001?phone=01712345678',
    });
  });

  it('percent-encodes each part rather than pasting it in raw', async () => {
    orderIs({ ...ORDER, orderNo: 'ORD/26 09#1', customer: { ...ORDER.customer, phone: '+8801712345678' } });
    const { tracking } = await orderService.getById(req({ slug: 'a&b' }), ORDER_ID);
    // A bare `#` would truncate the URL before the phone, and a bare `&` would
    // split the slug into a second query parameter.
    expect(tracking.path).toBe('/s/a%26b/order/ORD%2F26%2009%231?phone=%2B8801712345678');
  });

  it('is offered on a manual order too — the page does not care how it arrived', async () => {
    orderIs({ ...ORDER, source: 'manual', sourceNote: 'ফোনে' });
    const { tracking } = await orderService.getById(req(), ORDER_ID);
    expect(tracking.path).toContain('/order/ORD-260908-0001');
  });
});

describe('everything that must NOT produce a link', () => {
  it('a storefront still in draft', async () => {
    storefrontIs({ status: 'draft', pausedByAdmin: false });
    expect((await orderService.getById(req(), ORDER_ID)).tracking).toBeNull();
  });

  it('a storefront an admin has paused — the switch a shop cannot clear itself', async () => {
    storefrontIs({ status: 'live', pausedByAdmin: true });
    expect((await orderService.getById(req(), ORDER_ID)).tracking).toBeNull();
  });

  it('a shop with no storefront document at all', async () => {
    storefrontIs(null);
    expect((await orderService.getById(req(), ORDER_ID)).tracking).toBeNull();
  });

  it('an order with no phone — the page cannot be opened without one', async () => {
    orderIs({ ...ORDER, customer: { name: 'রহিম', phone: '', address: 'ঢাকা' } });
    expect((await orderService.getById(req(), ORDER_ID)).tracking).toBeNull();
    // And it did not pay for a storefront lookup to find that out.
    expect(Storefront.findOne).not.toHaveBeenCalled();
  });

  it('a shop whose slug never reached the request', async () => {
    expect((await orderService.getById(req({ slug: undefined }), ORDER_ID)).tracking).toBeNull();
    expect(Storefront.findOne).not.toHaveBeenCalled();
  });
});

describe('the rest of the order is untouched by any of this', () => {
  it('still returns the merchant projection beside the link', async () => {
    const out = await orderService.getById(req(), ORDER_ID);
    expect(out.orderNo).toBe('ORD-260908-0001');
    expect(out.customer.phone).toBe('01712345678');
  });

  it('a draft storefront costs the shopkeeper nothing but the link', async () => {
    storefrontIs({ status: 'draft' });
    const out = await orderService.getById(req(), ORDER_ID);
    expect(out.orderNo).toBe('ORD-260908-0001');
    expect(out.tracking).toBeNull();
  });
});

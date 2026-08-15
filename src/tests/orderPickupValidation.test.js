/**
 * The pickup-checkout regression, asserted at the layer it broke.
 *
 * REGRESSION: `Order.customer.address` was unconditionally required, and
 * `placeOrder` writes `''` for a pickup order — so Mongoose rejected EVERY
 * pickup checkout with a 422 while the delivery path worked. The fix makes the
 * requirement conditional on `delivery.isPickup`. The pickup case below FAILS
 * against the old schema (verified by reverting the `required` function);
 * the delivery cases are invariant guards and pass both ways.
 *
 * Real model, no database: `document.validate()` runs schema validation
 * locally.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order.model');

const baseOrder = (over = {}) => ({
  shop: new mongoose.Types.ObjectId(),
  orderNo: 'ORD-260815-0001',
  customer: {
    name: 'রহিম উদ্দিন',
    phone: '01712345678',
    address: 'বাড়ি ১২, রোড ৩, ধানমন্ডি, ঢাকা',
  },
  items: [{
    product: new mongoose.Types.ObjectId(),
    name: 'টেস্ট পণ্য',
    quantity: 1,
    unitPrice: 100,
    lineTotal: 100,
  }],
  delivery: { zoneKey: 'inside-dhaka', zoneName: 'ঢাকার ভিতরে', charge: 60, isPickup: false },
  subtotal: 100,
  deliveryCharge: 60,
  total: 160,
  ...over,
});

describe('Order model — pickup address requirement', () => {
  test('REGRESSION: a pickup order with an empty address validates', async () => {
    const doc = new Order(baseOrder({
      customer: { name: 'রহিম উদ্দিন', phone: '01712345678', address: '' },
      delivery: { zoneKey: null, zoneName: null, charge: 0, isPickup: true },
      deliveryCharge: 0,
      total: 100,
    }));
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('GUARD: a delivery order with an empty address is refused', async () => {
    const doc = new Order(baseOrder({
      customer: { name: 'রহিম উদ্দিন', phone: '01712345678', address: '' },
    }));
    await expect(doc.validate()).rejects.toMatchObject({
      errors: expect.objectContaining({ 'customer.address': expect.anything() }),
    });
  });

  test('GUARD: a delivery order with an address still validates', async () => {
    const doc = new Order(baseOrder());
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

describe('Order model — the duplicate-placement backstop', () => {
  test('the unique sparse index on {shop, meta.idempotencyKey} exists', () => {
    const indexes = Order.schema.indexes();
    const backstop = indexes.find(([fields]) =>
      fields.shop === 1 && fields['meta.idempotencyKey'] === 1
    );
    expect(backstop).toBeDefined();
    expect(backstop[1]).toMatchObject({ unique: true, sparse: true });
  });
});

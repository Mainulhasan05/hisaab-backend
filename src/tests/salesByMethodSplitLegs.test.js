/**
 * "পেমেন্ট মাধ্যম" must split an invoice across the methods that actually paid it.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * `Sale.paymentMethod` is not "how this invoice was paid". `createSale` sets it
 * to whichever leg was LARGEST:
 *
 *     paymentMethod = payments.reduce((max, p) => (p.amount > max.amount ? p : max)).method
 *
 * while `total` stays the whole invoice. The daily summary grouped `_id:
 * '$paymentMethod'` and summed `'$total'`, so a split invoice landed entirely in
 * one bucket and contributed nothing to the others:
 *
 *     ৳400 cash + ৳600 bKash  →  bkash ৳1000, cash ৳0
 *
 * `cashRegister.service._calculateCashFlows` spotted exactly this trap and reads
 * the legs — there is a long comment there about it. The report did not, so the
 * till and the daily summary disagreed about the same day, by the whole split
 * amount, with each insisting it was right.
 *
 * ── Why these assert on the PIPELINE ────────────────────────────────────────
 *
 * Same reason `reportDateBuckets` does: the defect is entirely in the pipeline
 * the service builds, and a stubbed `aggregate` will happily return
 * correct-looking rows for a wrong pipeline. There is no in-memory MongoDB in
 * this project to run the real thing against.
 *
 * REGRESSION, not an invariant guard — every assertion below fails against the
 * pre-fix service.
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale.model');
const Expense = require('../models/Expense.model');
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');
const SalesReturn = require('../models/SalesReturn.model');
const Product = require('../models/Product.model');
const CashRegister = require('../models/CashRegister.model');
const reportService = require('../services/report.service');

jest.mock('../services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  getShopCacheVersion: jest.fn().mockResolvedValue(1),
  bumpShopCacheVersion: jest.fn().mockResolvedValue(undefined),
}));

const SHOP = new mongoose.Types.ObjectId().toString();

/** A chainable `find()` stub — the low-stock and top-product reads use one. */
function findStub() {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    populate: () => chain,
    lean: () => Promise.resolve([]),
    then: (resolve) => Promise.resolve([]).then(resolve),
  };
  return chain;
}

/**
 * Runs `getDailySummary` with every collection stubbed empty and returns the
 * pipelines `Sale.aggregate` was called with.
 */
async function salePipelines() {
  const saleAgg = jest.fn().mockResolvedValue([]);
  jest.spyOn(Sale, 'aggregate').mockImplementation(saleAgg);
  jest.spyOn(Expense, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Purchase, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
  jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
  jest.spyOn(Product, 'find').mockImplementation(findStub);
  jest.spyOn(Product, 'aggregate').mockResolvedValue([]);
  jest.spyOn(CashRegister, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });

  await reportService.getDailySummary(SHOP, { date: '2026-08-18' }, null);

  return saleAgg.mock.calls.map(([pipeline]) => pipeline);
}

/** The one pipeline that produces the payment-method breakdown. */
function methodPipeline(pipelines) {
  return pipelines.find((p) => p.some((stage) => stage.$unwind === '$legs'));
}

afterEach(() => jest.restoreAllMocks());

describe('daily summary — money by payment method', () => {
  it('groups on the payment LEG, never on the invoice-level paymentMethod', async () => {
    const pipeline = methodPipeline(await salePipelines());

    expect(pipeline).toBeDefined();

    const group = pipeline.find((stage) => stage.$group);
    expect(group.$group._id).toBe('$legs.method');

    // The exact shape of the bug: `_id: '$paymentMethod'` summing `'$total'`.
    expect(group.$group._id).not.toBe('$paymentMethod');
    expect(JSON.stringify(group.$group.total)).not.toContain('$total');
  });

  it('sums each leg\'s own amount, so a split invoice lands in both buckets', async () => {
    const pipeline = methodPipeline(await salePipelines());
    const group = pipeline.find((stage) => stage.$group);

    // ৳400 cash + ৳600 bKash: each leg contributes ITS amount to ITS method.
    expect(JSON.stringify(group.$group.total)).toContain('$legs.amount');
  });

  it('builds the legs from Sale.payments[], the only place split truth lives', async () => {
    const pipeline = methodPipeline(await salePipelines());
    const project = pipeline.find((stage) => stage.$project);

    expect(JSON.stringify(project.$project.legs)).toContain('$payments');
  });

  it('falls back to paymentMethod + paid for sales predating split payments', async () => {
    const pipeline = methodPipeline(await salePipelines());
    const legs = JSON.stringify(pipeline.find((stage) => stage.$project).$project.legs);

    // `payments[]` is auto-filled for single-method sales written since the
    // feature shipped, but older rows have an empty array and must not vanish
    // from the breakdown entirely.
    expect(legs).toContain('$paymentMethod');
    expect(legs).toContain('$paid');
  });

  it('still excludes cancelled invoices', async () => {
    const pipeline = methodPipeline(await salePipelines());
    const match = pipeline.find((stage) => stage.$match).$match;

    // Pre-existing behaviour the rewrite must not drop.
    expect(match.status).toEqual({ $ne: 'cancelled' });
    // I-3: ids reaching a `$match` are cast, or the pipeline matches nothing.
    expect(match.shop).toBeInstanceOf(mongoose.Types.ObjectId);
  });
});

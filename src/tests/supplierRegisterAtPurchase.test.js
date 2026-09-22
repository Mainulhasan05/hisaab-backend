/**
 * সরবরাহকারী পরিশোধ must list money paid ON the bill at delivery.
 *
 * `createPurchase` writes no Payment row for it, and the register read only
 * Payment rows — so a shop that pays cash on delivery saw an empty register
 * while the supplier statement (which derives the figure) showed every taka.
 *
 * REGRESSIONS: the bill arm exists, is filtered like the payment arm, and uses
 * the statement's formula. INVARIANT GUARD: an অগ্রিম-only view lists no bills.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Payment = require('../models/Payment.model');
const Supplier = require('../models/Supplier.model');
const Purchase = require('../models/Purchase.model');
const supplierService = require('../services/supplier.service');

const SHOP = new mongoose.Types.ObjectId();
const req = { shop: { _id: SHOP, multiBranchEnabled: false }, branchId: null };

function capture() {
  const agg = jest.spyOn(Payment, 'aggregate').mockResolvedValue([{ rows: [], total: [], live: [] }]);
  return () => agg.mock.calls[0][0];
}
const billArm = (pipeline) => pipeline.find((s) => s.$unionWith)?.$unionWith;

afterEach(() => jest.restoreAllMocks());

describe('the bill arm', () => {
  it('unions purchases into the register by default', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, {}, req);
    const arm = billArm(pipeline());
    expect(arm).toBeDefined();
    expect(arm.coll).toBe(Purchase.collection.name);
    expect(arm.pipeline[0].$match).toMatchObject({ shop: SHOP, paid: { $gt: 0 } });
  });

  it('shapes each bill as a purchase_payment row naming the bill', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, {}, req);
    const project = billArm(pipeline()).pipeline.find((s) => s.$project).$project;
    expect(project).toMatchObject({
      type: { $literal: 'purchase_payment' },
      atPurchase: { $literal: true },
      purchase: '$_id',
      paidAt: '$date',
      status: 1,
    });
  });

  it('drops bills whose money all arrived later — no ৳0 rows, no double count', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, {}, req);
    const stages = billArm(pipeline()).pipeline;
    expect(stages.some((s) => s.$lookup?.as === 'laterPayments')).toBe(true);
    expect(stages).toContainEqual({ $match: { atPurchaseAmount: { $gt: 0 } } });
  });

  it('honours the date range on the bill date', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { startDate: '2026-09-01', endDate: '2026-09-30' }, req);
    expect(billArm(pipeline()).pipeline[0].$match.date.$gte).toEqual(new Date('2026-09-01'));
  });

  it('excludes cancelled bills when voided rows are not wanted', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { includeCancelled: false }, req);
    expect(billArm(pipeline()).pipeline[0].$match.status).toEqual({ $ne: 'cancelled' });
  });

  it('searches bills by invoice number and by supplier', async () => {
    const vendor = new mongoose.Types.ObjectId();
    jest.spyOn(Supplier, 'find').mockReturnValue({ limit: () => ({ lean: async () => [{ _id: vendor }] }) });
    jest.spyOn(Purchase, 'find').mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { search: 'রহিম' }, req);
    const or = billArm(pipeline()).pipeline[0].$match.$or;
    expect(or).toEqual(expect.arrayContaining([{ supplier: { $in: [vendor] } }]));
    expect(or.some((c) => c.invoiceNo instanceof RegExp)).toBe(true);
  });

  it('INVARIANT: an অগ্রিম-only view lists no bills', async () => {
    const pipeline = capture();
    await supplierService.getSupplierPaymentRegister(SHOP, { types: 'supplier_advance' }, req);
    expect(billArm(pipeline())).toBeUndefined();
  });
});

describe('one formula for "paid at purchase"', () => {
  it('the statement and both supplier readers share purchasePayment.util', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'services', f), 'utf8');
    expect(read('detailedReport.service.js')).toMatch(/require\('\.\.\/utils\/purchasePayment\.util'\)/);
    expect(read('detailedReport.service.js')).not.toMatch(/const laterPaymentsLookup\s*=/);
    const supplier = read('supplier.service.js');
    expect((supplier.match(/laterPaymentsLookup\(/g) || []).length).toBe(2);
  });
});

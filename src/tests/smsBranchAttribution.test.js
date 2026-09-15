/**
 * SMS log branch attribution.
 *
 * Production, 2026-09-14: a due-collection receipt reached the customer, the
 * shop's quota was charged for it, and the shop's SMS history did not show it.
 * The log existed — with `branch: null`, because every background receipt calls
 * `sendSingle` without a `req`. A multi-branch owner viewing a branch reads
 * `{ shop, branch }`, so 66 of that shop's 73 logs were invisible.
 *
 * Also pinned: `requireBranch` used to run AFTER the gateway call, so an
 * All-Branches request sent the message, refunded the quota and failed to log.
 */
const mongoose = require('mongoose');

jest.mock('../services/sms/dispatcher', () => ({
  sendSingle: jest.fn(),
  sendBulk: jest.fn(),
  sendDynamic: jest.fn(),
  checkAllBalances: jest.fn(),
}));
jest.mock('../services/sms/earnings', () => ({
  priceAndRecord: jest.fn(async () => ({ unitCost: null, totalCost: null, revenue: null })),
}));

const dispatcher = require('../services/sms/dispatcher');
const smsService = require('../services/sms.service');
const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const Shop = require('../models/Shop.model');
const Customer = require('../models/Customer.model');
const Sale = require('../models/Sale.model');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

let logs;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  logs = [];

  jest.spyOn(SMSQuota, 'getOrCreate').mockResolvedValue({ isEnabled: true, remainingQuota: 100 });
  jest.spyOn(SMSQuota, 'reserve').mockResolvedValue({ remainingQuota: 98 });
  jest.spyOn(SMSQuota, 'refund').mockResolvedValue({});
  jest.spyOn(SMSQuota, 'findOne').mockResolvedValue({ isEnabled: true, remainingQuota: 100 });
  jest.spyOn(SMSLog, 'create').mockImplementation(async (doc) => { logs.push(doc); return doc; });
  jest.spyOn(SMSLog, 'findOne').mockResolvedValue(null);

  dispatcher.sendSingle.mockResolvedValue({
    success: true, provider: 'automas', messageId: 'm1', data: { ok: true }, method: 'single',
  });
});

describe('sendSingle — where the log row is filed', () => {
  it('writes the branch a background caller hands it', async () => {
    await smsService.sendSingle(SHOP, USER, '01700000000', 'hi', null, null, {
      shopName: 'Shop', branch: BRANCH, audience: 'payment_receipt',
    });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].branch)).toBe(String(BRANCH));
  });

  it('records what produced the send', async () => {
    await smsService.sendSingle(SHOP, USER, '01700000000', 'hi', null, null, {
      shopName: 'Shop', audience: 'purchase_receipt',
    });
    expect(logs[0].audience).toBe('purchase_receipt');
  });

  it('still derives the branch from req for a request-bound send', async () => {
    const req = { shop: { _id: SHOP, multiBranchEnabled: true }, branchId: BRANCH };
    await smsService.sendSingle(SHOP, USER, '01700000000', 'hi', null, req, { shopName: 'Shop' });
    expect(String(logs[0].branch)).toBe(String(BRANCH));
  });

  it('refuses an All-Branches send BEFORE charging or sending — not after', async () => {
    const req = { shop: { _id: SHOP, multiBranchEnabled: true }, branchId: null };
    await expect(
      smsService.sendSingle(SHOP, USER, '01700000000', 'hi', null, req, { shopName: 'Shop' })
    ).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });

    expect(SMSQuota.reserve).not.toHaveBeenCalled();
    expect(dispatcher.sendSingle).not.toHaveBeenCalled();
  });

  it('single-branch shop: branch stays null (I-1 guard)', async () => {
    const req = { shop: { _id: SHOP, multiBranchEnabled: false }, branchId: null };
    await smsService.sendSingle(SHOP, USER, '01700000000', 'hi', null, req, { shopName: 'Shop' });
    expect(logs[0].branch).toBeNull();
  });
});

describe('background receipts carry their record\'s branch', () => {
  it('payment receipt → Payment.branch', async () => {
    jest.spyOn(Shop, 'findById').mockResolvedValue({
      _id: SHOP, name: 'Shop', settings: { smsSettings: { autoSendOnDuePayment: true } },
    });
    jest.spyOn(Customer, 'findById').mockResolvedValue({ _id: CUSTOMER, name: 'Rahim', phone: '01700000000' });

    smsService.sendPaymentReceiptAsync(SHOP, USER, {
      customerId: CUSTOMER, amount: 6000, remainingDue: 11325, branch: BRANCH,
    });
    await settle();

    expect(logs).toHaveLength(1);
    expect(String(logs[0].branch)).toBe(String(BRANCH));
    expect(logs[0].audience).toBe('payment_receipt');
  });

  it('sale receipt → Sale.branch', async () => {
    const saleId = new mongoose.Types.ObjectId();
    jest.spyOn(Sale, 'findById').mockResolvedValue({
      _id: saleId, invoiceNo: 'INV-1', branch: BRANCH, smsSent: false, previousDue: 0, due: 0,
    });
    jest.spyOn(Sale, 'updateOne').mockResolvedValue({});
    jest.spyOn(Shop, 'findById').mockResolvedValue({
      _id: SHOP, name: 'Shop', settings: { smsSettings: { autoSendOnSale: true } },
    });

    smsService.sendSaleReceiptAsync(SHOP, USER, {
      id: saleId, invoiceNumber: 'INV-1', total: 500, paid: 500, due: 0, customerPhone: '01700000000',
    });
    await settle();

    expect(logs).toHaveLength(1);
    expect(String(logs[0].branch)).toBe(String(BRANCH));
    expect(logs[0].audience).toBe('sale_receipt');
  });
});

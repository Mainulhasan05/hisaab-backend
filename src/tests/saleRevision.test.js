/**
 * Revising a printed invoice.
 *
 * Two things are being defended here, and they are different in kind:
 *
 *   THE GUARDS (§3.4) — every one of them stands between a correction and a
 *   number that has already been counted somewhere else: a return that put
 *   stock back, a drawer that has been reconciled, a day that has been reported
 *   on. Each must refuse in its own words, because "cannot revise" with no
 *   reason sends the seller to support instead of to the return screen.
 *
 *   THE SUPERSESSION — the invoice number moves to the new document, the old
 *   one is kept under `~r1`, and the order rename → cancel → create is not
 *   negotiable. Get the order wrong and either the unique index rejects the
 *   revision or the stock guard measures against stock that is about to come
 *   back.
 *
 * The transaction is shimmed away (no replica set in CI), which is why a
 * separate suite — ambientTransaction.test.js — tests the join itself. Here the
 * question is what gets written and in what order, not what commits.
 */

jest.mock('../utils/transaction.util', () => {
  // A stand-in for the session a real transaction would open. Mirrors the join
  // exactly: a passed session is handed straight through, otherwise a new one
  // is "opened". Returning null instead would make every session assertion
  // below pass on `null === null` and prove nothing.
  const OPENED = { id: 'test-session' };
  return {
    runInTransaction: (cb, options = {}) => cb(options.session || OPENED),
    __OPENED: OPENED,
  };
});
jest.mock('../services/sms.service', () => ({
  sendSaleReceiptAsync: jest.fn(),
  sendPaymentReceiptAsync: jest.fn(),
}));

const mongoose = require('mongoose');

const saleService = require('../services/sale.service');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const CashRegister = require('../models/CashRegister.model');
const AuditLog = require('../models/AuditLog.model');
const { MODULES, ROLE_PRESETS, PRESET_VERSION, buildPresetUpgradePatch } = require('../config/permissions');
const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();

/** A live, revisable sale rung up today. */
function saleDoc(over = {}) {
  const { startOfDay } = getBangladeshDayRange(getBangladeshTodayStr());
  // Midday of the Bangladesh trading day, so the doc is unambiguously "today"
  // whatever hour the suite runs at.
  const createdAt = new Date(startOfDay.getTime() + 12 * 60 * 60 * 1000);

  const doc = {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    branch: null,
    invoiceNo: 'INV-MAIN-20260816-0007',
    status: 'completed',
    channel: 'pos',
    isOnline: false,
    returnedAmount: 0,
    revision: 0,
    revisedTo: undefined,
    total: 1000,
    paid: 1000,
    due: 0,
    createdAt,
    items: [{ product: new mongoose.Types.ObjectId(), quantity: 2 }],
    ...over,
  };
  doc.toObject = () => ({ ...doc });
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
}

/** No later payment, no closed drawer — the two guards that cost a query. */
function stubCleanDownstream() {
  jest.spyOn(Payment, 'exists').mockResolvedValue(null);
  jest.spyOn(CashRegister, 'findOne').mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(null) }),
  });
}

afterEach(() => jest.restoreAllMocks());

/* ════════════════════════════════════════════════════════════════════════
 * A. THE GUARDS — each refuses in its own words
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. where a revision is refused', () => {
  it('refuses a sale with a return against it, and points at the return', async () => {
    // The return already restored stock and already credited the customer, and
    // it allocated its refund proportionally against the ORIGINAL line values.
    // Revising on top counts both twice.
    stubCleanDownstream();
    const reason = await saleService.reviseBlockedReason(SHOP, saleDoc({ returnedAmount: 300 }));

    expect(reason.code).toBe('HAS_RETURN');
    expect(reason.statusCode).toBe(409);
    expect(reason.messageBn).toMatch(/মাল ফেরত/);
  });

  it('refuses a sale from a previous trading day', async () => {
    stubCleanDownstream();
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const reason = await saleService.reviseBlockedReason(SHOP, saleDoc({ createdAt: yesterday }));

    expect(reason.code).toBe('DIFFERENT_DAY');
    expect(reason.messageBn).toMatch(/সেদিনই/);
  });

  it('refuses once the day’s drawer has been closed', async () => {
    jest.spyOn(Payment, 'exists').mockResolvedValue(null);
    jest.spyOn(CashRegister, 'findOne').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ status: 'closed', closedAt: new Date() }) }),
    });

    const reason = await saleService.reviseBlockedReason(SHOP, saleDoc());
    expect(reason.code).toBe('REGISTER_CLOSED');
    expect(reason.messageBn).toMatch(/ক্যাশ রেজিস্টার/);
  });

  it('allows a revision while the drawer is still open', async () => {
    jest.spyOn(Payment, 'exists').mockResolvedValue(null);
    jest.spyOn(CashRegister, 'findOne').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ status: 'open' }) }),
    });

    expect(await saleService.reviseBlockedReason(SHOP, saleDoc())).toBeNull();
  });

  it('refuses when money arrived AFTER checkout, not because of the checkout leg', async () => {
    // `createSale` always writes a Payment row for a paid sale, so "any payment
    // exists" would refuse every revision ever. `atCheckout` is exactly the
    // distinction — the query must ask for rows that are NOT the checkout leg.
    const exists = jest.spyOn(Payment, 'exists').mockResolvedValue({ _id: 'later' });
    jest.spyOn(CashRegister, 'findOne').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(null) }),
    });

    const reason = await saleService.reviseBlockedReason(SHOP, saleDoc());

    expect(reason.code).toBe('LATER_PAYMENT');
    expect(exists.mock.calls[0][0]).toMatchObject({ atCheckout: { $ne: true } });
  });

  it('refuses an already-cancelled sale', async () => {
    stubCleanDownstream();
    const reason = await saleService.reviseBlockedReason(SHOP, saleDoc({ status: 'cancelled' }));
    expect(reason.code).toBe('SALE_CANCELLED');
  });

  it('refuses a version that has already been superseded', async () => {
    // Revising an old version would fork the chain and leave two documents
    // claiming the same invoice number.
    stubCleanDownstream();
    const reason = await saleService.reviseBlockedReason(
      SHOP,
      saleDoc({ revisedTo: new mongoose.Types.ObjectId() })
    );
    expect(reason.code).toBe('ALREADY_REVISED');
  });

  it('refuses an online order’s sale', async () => {
    stubCleanDownstream();
    const reason = await saleService.reviseBlockedReason(
      SHOP,
      saleDoc({ isOnline: true, channel: 'website' })
    );
    expect(reason.code).toBe('ONLINE_SALE');
    expect(reason.messageBn).toMatch(/অর্ডার/);
  });

  it('lets an ordinary POS sale rung up today through', async () => {
    stubCleanDownstream();
    expect(await saleService.reviseBlockedReason(SHOP, saleDoc())).toBeNull();
  });

  it('gives every refusal a Bengali reason and an HTTP status', async () => {
    // A refusal with no reason sends the seller to support instead of to the
    // return screen. Checked as a set so a guard added later cannot skip it.
    stubCleanDownstream();
    const cases = [
      saleDoc({ status: 'cancelled' }),
      saleDoc({ revisedTo: new mongoose.Types.ObjectId() }),
      saleDoc({ returnedAmount: 1 }),
      saleDoc({ createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000) }),
      saleDoc({ isOnline: true }),
    ];

    for (const sale of cases) {
      const reason = await saleService.reviseBlockedReason(SHOP, sale);
      expect(reason).not.toBeNull();
      expect(reason.code).toEqual(expect.any(String));
      expect(reason.messageBn).toMatch(/[ঀ-৿]/); // Bengali codepoints
      expect([400, 409]).toContain(reason.statusCode);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. SUPERSESSION — the number moves, the old document is kept
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. supersession', () => {
  /**
   * Drive `reviseSale` with the two heavy collaborators stubbed, and report
   * exactly what it did and in what order.
   */
  async function runRevise(over = {}) {
    const original = saleDoc(over);
    const calls = [];

    jest.spyOn(Sale, 'findOne').mockResolvedValue(original);
    jest.spyOn(Sale, 'updateOne').mockImplementation((filter, update) => {
      calls.push({ op: 'updateOne', update: update.$set });
      return Promise.resolve({ modifiedCount: 1 });
    });
    jest.spyOn(AuditLog, 'create').mockResolvedValue({});

    const cancel = jest.spyOn(saleService, 'cancelSale').mockImplementation(async (...args) => {
      calls.push({ op: 'cancel', reason: args[3], session: args[5]?.session });
      return original;
    });

    const created = {
      _id: new mongoose.Types.ObjectId(),
      invoiceNo: original.invoiceNo,
      total: 1500,
      paid: 1500,
      due: 0,
      items: [{}, {}, {}],
    };
    const create = jest.spyOn(saleService, 'createSale').mockImplementation(async (...args) => {
      calls.push({ op: 'create', internal: args[4] });
      return created;
    });

    const result = await saleService.reviseSale(SHOP, USER, original._id, { items: [] }, {
      branchId: over.branch || null,
    });

    return { result, original, calls, cancel, create, created };
  }

  beforeEach(stubCleanDownstream);

  it('renames the old document, THEN cancels, THEN creates', async () => {
    // Rename before create or the {shop, invoiceNo} unique index rejects the new
    // document. Cancel before create or the stock guard measures against stock
    // that is about to be restored — so a revision that merely ADDS an item
    // fails on a product the shop has plenty of.
    const { calls } = await runRevise();

    expect(calls.map((c) => c.op)).toEqual(['updateOne', 'cancel', 'create', 'updateOne']);
    expect(calls[0].update.invoiceNo).toBe('INV-MAIN-20260816-0007~r1');
  });

  it('gives the live invoice number to the NEW document', async () => {
    // The customer is holding paper with that number on it. After a reprint the
    // paper must still be the invoice.
    const { calls } = await runRevise();
    const create = calls.find((c) => c.op === 'create');

    expect(create.internal.forceInvoiceNo).toBe('INV-MAIN-20260816-0007');
  });

  it('suffixes with `~`, which no generated number can contain', async () => {
    // `~` is what keeps `{shop, invoiceNo}` unique while leaving a prefix search
    // for the original number able to find every version.
    const { calls } = await runRevise();
    expect(calls[0].update.invoiceNo).toContain('~');
    expect(calls[0].update.invoiceNo).not.toMatch(/~.*~/);
  });

  it('counts revisions up, so a second revision writes ~r2', async () => {
    const { calls } = await runRevise({ revision: 1 });
    expect(calls[0].update.invoiceNo).toBe('INV-MAIN-20260816-0007~r2');
    expect(calls.find((c) => c.op === 'create').internal.revision).toBe(2);
  });

  it('keeps the new sale on the original’s day', async () => {
    // Load-bearing: revising a 9pm sale at 9:05 would otherwise move it across
    // midnight, taking its invoice number, stock movements, reports and drawer
    // into a day it did not happen on.
    const { calls, original } = await runRevise();
    expect(calls.find((c) => c.op === 'create').internal.forceCreatedAt).toBe(original.createdAt);
  });

  it('links both directions — revisedFrom forward, revisedTo back', async () => {
    const { calls, original, created } = await runRevise();

    expect(calls.find((c) => c.op === 'create').internal.revisedFrom).toBe(original._id);
    expect(calls[3].update.revisedTo).toBe(created._id);
  });

  it('cancels with reason `revised`, not as an ordinary void', async () => {
    const { calls } = await runRevise();
    expect(calls.find((c) => c.op === 'cancel').reason).toBe('revised');
  });

  it('runs cancel AND create inside the caller’s single transaction', async () => {
    // Half of this landing — stock restored, no replacement invoice — leaves the
    // shop short a sale it has already been paid for. Both steps must therefore
    // receive the SAME session object; two sessions would be two commit
    // boundaries, and under snapshot read concern the create could not even see
    // the stock the cancel had just restored.
    const { __OPENED } = require('../utils/transaction.util');
    const { calls } = await runRevise();
    const cancel = calls.find((c) => c.op === 'cancel');
    const create = calls.find((c) => c.op === 'create');

    expect(cancel.session).toBe(__OPENED);
    expect(create.internal.session).toBe(__OPENED);
  });

  it('returns the new live invoice, not the superseded one', async () => {
    const { result, created } = await runRevise();
    expect(result).toBe(created);
  });

  it('audits both ids, both totals and the line delta', async () => {
    const create = jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    const { original, created } = await runRevise();

    const entry = create.mock.calls[0][0];
    expect(entry.action).toBe('sale_revise');
    expect(String(entry.changes.before.saleId)).toBe(String(original._id));
    expect(String(entry.changes.after.saleId)).toBe(String(created._id));
    expect(entry.changes.before.total).toBe(1000);
    expect(entry.changes.after.total).toBe(1500);
    expect(entry.changes.before.itemCount).toBe(1);
    expect(entry.changes.after.itemCount).toBe(3);
  });

  it('refuses before renaming anything when a guard fires', async () => {
    // A guard that fired after the rename would leave a live invoice carrying a
    // `~r1` number with no revision behind it.
    const blocked = saleDoc({ returnedAmount: 500 });
    jest.spyOn(Sale, 'findOne').mockResolvedValue(blocked);
    const updateOne = jest.spyOn(Sale, 'updateOne').mockResolvedValue({});
    const cancel = jest.spyOn(saleService, 'cancelSale').mockResolvedValue(blocked);

    await expect(
      saleService.reviseSale(SHOP, USER, blocked._id, { items: [] }, {})
    ).rejects.toMatchObject({ statusCode: 409, code: 'HAS_RETURN' });

    expect(updateOne).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C. THE INVARIANT — an ordinary sale is untouched by any of this
 * ════════════════════════════════════════════════════════════════════════ */
describe('C. ordinary sales are unchanged', () => {
  it('writes no revision fields when createSale is called with no internal options', async () => {
    // The invariant guard from the plan: adding these options must be invisible
    // to every existing caller. `revisedFrom`/`revisedTo` absent and `revision`
    // left at its schema default is what makes this a no-migration change —
    // absent means "never revised", for every sale ever written.
    const doc = new Sale({
      shop: SHOP,
      branch: null,
      invoiceNo: 'INV-1',
      items: [],
      subtotal: 0,
      total: 0,
      createdBy: USER,
    }).toObject();

    expect(doc.revisedFrom).toBeUndefined();
    expect(doc.revisedTo).toBeUndefined();
    expect(doc.revision).toBe(0);
  });

  it('keeps `cancelled` as the status of a superseded sale — no new enum member', async () => {
    // A `superseded` status would mean auditing every `status: 'cancelled'`
    // query in the codebase for whether it meant to include supersessions.
    const values = Sale.schema.path('status').enumValues;
    expect(values).not.toContain('superseded');
    expect(values).toContain('cancelled');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * D. THE PERMISSION
 * ════════════════════════════════════════════════════════════════════════ */
describe('D. sales.revise', () => {
  it('is its own action, not folded into create or update', async () => {
    // `update` is recording a payment against a due invoice — it changes no line
    // and no stock. Revising is spending authority, and an owner must be able to
    // take it away without stopping someone ringing sales.
    expect(MODULES.sales.actions).toContain('revise');
  });

  it('is granted to the counter roles and withheld from floor staff', async () => {
    expect(ROLE_PRESETS.manager.permissions.sales.revise).toBe(true);
    expect(ROLE_PRESETS.cashier.permissions.sales.revise).toBe(true);
    expect(ROLE_PRESETS.salesperson.permissions.sales.revise).not.toBe(true);
    expect(ROLE_PRESETS.inventory_manager.permissions.sales?.revise).not.toBe(true);
  });

  it('reaches shops that already exist, via a preset upgrade', async () => {
    // Editing ROLE_PRESETS alone only touches newly seeded shops — every shop
    // that exists holds its own Role documents.
    expect(PRESET_VERSION).toBeGreaterThanOrEqual(6);

    const patch = buildPresetUpgradePatch('cashier', 5);
    expect(patch).toMatchObject({ 'permissions.sales.revise': true });
  });

  it('does not re-grant to a role already at the current version', async () => {
    // An owner who narrowed a default role keeps their decision.
    expect(buildPresetUpgradePatch('cashier', PRESET_VERSION)).toBeNull();
  });
});

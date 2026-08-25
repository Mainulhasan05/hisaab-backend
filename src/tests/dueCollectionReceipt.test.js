/**
 * বাকি আদায় — the receipt, and the message that quotes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS ABOUT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A due collection used to leave the customer with nothing: no slip, and an SMS
 * that was sent only if a platform admin had switched it on for the shop. The
 * message itself read the balance LIVE out of the customer document from a
 * callback dispatched inside the settlement transaction — so it raced the
 * commit, and under separate branch books it read a different book from the one
 * the collection had just been validated against.
 *
 * Three things are pinned here, and each of them is a way the customer ends up
 * holding a number the shop's books do not agree with:
 *
 *  1. The payment row carries a রসিদ নং and BOTH balances, frozen.
 *  2. Those frozen balances come from whichever book the collection was checked
 *     against — the branch's under separate books.
 *  3. The SMS quotes the frozen figure and is dispatched only AFTER the
 *     settlement returns, never from inside it.
 *
 * The preview-vs-sent half of the promise is pinned on the other side of the
 * wire, in `hisaab-frontend/tests/smsTemplateParity.test.mjs`, which runs both
 * implementations of every builder against the same inputs.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/sms.service', () => ({
  sendPaymentReceiptAsync: jest.fn(),
}));
// The service runs inside runInTransaction; execute the callback directly so
// the test does not need a replica set.
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const customerService = require('../services/customer.service');
const SMSService = require('../services/sms.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const { buildPaymentReceiptNo } = require('../utils/receiptNo.util');
const { buildPaymentReceipt } = require('../utils/smsTemplates.util');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();

/**
 * `'shop'` is the SHARED-books default here, not `'shared'`.
 *
 * `customerScope()` reads anything that is not literally `'shop'` as `'branch'`
 * — it fails safe toward separation — so a plausible-looking `'shared'` silently
 * puts the test on the branch-scoped path and validates against a branch
 * balance nobody set up.
 */
const reqAt = (branchId, scope = 'shop') => ({
  shop: { _id: SHOP, multiBranchEnabled: true, customerScope: scope },
  branchId,
  user: { _id: USER, isOwner: true },
});

const stubCustomer = (totalDue = 5000) => {
  const doc = {
    _id: CUSTOMER, shop: SHOP, name: 'করিম', phone: '01700000000',
    totalPaid: 0, totalDue,
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Customer, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
  return doc;
};

/** Whatever `Payment.create` was handed — the document as it will be stored. */
let created;

beforeEach(() => {
  created = null;
  jest.spyOn(Payment, 'create').mockImplementation(async (docs) => {
    created = Array.isArray(docs) ? docs[0] : docs;
    return [created];
  });
  jest.spyOn(CustomerBalance, 'settleDue').mockResolvedValue([]);
  // The branch rollup. Stubbed in EVERY test, not only the branch-scoped ones:
  // a mongoose query with no connection behind it never rejects, it buffers —
  // so an unstubbed read here does not fail the test, it hangs it until Jest's
  // timeout and then reports something that looks like a logic error.
  // Individual tests override the return where the figure matters.
  jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue(null);
  jest.spyOn(CustomerBalance, 'applyDelta').mockResolvedValue(undefined);
  // Empty allocation pool, so `reallocateCustomerInvoices` short-circuits
  // before it reaches for a real database. Where the money lands on the
  // INVOICES has its own suite (dueCollectionHitsInvoices.test.js); unstubbed
  // this would reach for a real connection and hang the file on a timeout.
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  SMSService.sendPaymentReceiptAsync.mockClear();
});

/* ════════════════════════════════════════════════════════════════════════════
 * The receipt number
 * ════════════════════════════════════════════════════════════════════════════ */

describe('buildPaymentReceiptNo', () => {
  it('renders RCP-<BD date>-<id counter>', () => {
    const id = new mongoose.Types.ObjectId('60c72b2f9b1e8a1a2c3d4e5f');
    // 2026-08-25T06:00:00Z is noon in Dhaka on the 25th.
    const no = buildPaymentReceiptNo(id, new Date('2026-08-25T06:00:00.000Z'));
    expect(no).toBe('RCP-260825-3D4E5F');
  });

  it('dates the receipt in Bangladesh time, not UTC', () => {
    /**
     * 18:30 UTC on the 24th is 00:30 on the 25th in Dhaka. A receipt handed
     * over just after midnight must carry the day the customer thinks it is,
     * and it is the same rule `InvoiceCounter` and `ReturnCounter` follow — a
     * receipt dated a day apart from the sale it settles is the exact defect
     * `ReturnCounter` was written to remove.
     */
    const id = new mongoose.Types.ObjectId('60c72b2f9b1e8a1a2c3d4e5f');
    expect(buildPaymentReceiptNo(id, new Date('2026-08-24T18:30:00.000Z')))
      .toBe('RCP-260825-3D4E5F');
  });

  it('uses paidAt, so a backdated collection is dated the day the money came in', () => {
    const id = new mongoose.Types.ObjectId('60c72b2f9b1e8a1a2c3d4e5f');
    expect(buildPaymentReceiptNo(id, new Date('2026-08-15T06:00:00.000Z')))
      .toBe('RCP-260815-3D4E5F');
  });

  it('returns empty rather than a short number for a non-ObjectId', () => {
    // The caller stores whatever comes back, and a truncated receipt number
    // that looks plausible is worse than none at all.
    expect(buildPaymentReceiptNo('', new Date())).toBe('');
    expect(buildPaymentReceiptNo('abc', new Date())).toBe('');
    expect(buildPaymentReceiptNo(null, new Date())).toBe('');
  });

  it('is unique across payments taken on the same day', () => {
    const day = new Date('2026-08-25T06:00:00.000Z');
    const numbers = new Set(
      Array.from({ length: 500 }, () =>
        buildPaymentReceiptNo(new mongoose.Types.ObjectId(), day)
      )
    );
    expect(numbers.size).toBe(500);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * What gets written on a collection
 * ════════════════════════════════════════════════════════════════════════════ */

describe('collectDuePayment — the receipt on the payment row', () => {
  it('stamps a receipt number and both balances', async () => {
    stubCustomer(5000);

    const result = await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 2000, method: 'cash' }, reqAt(BRANCH_A)
    );

    expect(created.receiptNo).toMatch(/^RCP-\d{6}-[0-9A-F]{6}$/);
    expect(created.dueBefore).toBe(5000);
    expect(created.dueAfter).toBe(3000);
    // The receipt number is derived from the row's own id, so the two must be
    // the same document — that is what makes a reprint findable.
    expect(created.receiptNo).toBe(buildPaymentReceiptNo(created._id, created.paidAt));
    expect(result.dueAfter).toBe(3000);
  });

  it('freezes the BRANCH balance under separate books, not the shop-wide one', async () => {
    /**
     * The customer owes ৳5,000 shop-wide, of which ৳1,200 is this branch's.
     * The branch may only collect against its own receivable, and the slip it
     * hands over — and the SMS it sends — must describe that book. Quoting
     * ৳3,800 here would tell a customer standing at this counter about debt
     * belonging to a branch they have never visited, which is precisely what
     * separate books exist to keep apart.
     */
    stubCustomer(5000);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 1200 });

    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 200, method: 'cash' }, reqAt(BRANCH_B, 'branch')
    );

    expect(created.dueBefore).toBe(1200);
    expect(created.dueAfter).toBe(1000);
  });

  it('clamps a full settlement to exactly zero', async () => {
    stubCustomer(2000);
    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 2000, method: 'cash' }, reqAt(BRANCH_A)
    );
    expect(created.dueAfter).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The message
 * ════════════════════════════════════════════════════════════════════════════ */

describe('collectDuePayment — the receipt SMS', () => {
  it('quotes the frozen balance rather than leaving the sender to re-read it', async () => {
    stubCustomer(5000);

    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 2000, method: 'cash' }, reqAt(BRANCH_A)
    );

    expect(SMSService.sendPaymentReceiptAsync).toHaveBeenCalledTimes(1);
    const [, , payload] = SMSService.sendPaymentReceiptAsync.mock.calls[0];
    expect(payload.remainingDue).toBe(3000);
    expect(payload.amount).toBe(2000);
  });

  it('passes the branch figure under separate books', async () => {
    // The half of the race that no clock could fix: the sender used to read
    // `Customer.totalDue`, which is shop-wide, while the preview the shopkeeper
    // approved showed the branch's.
    stubCustomer(5000);
    jest.spyOn(CustomerBalance, 'findOne').mockResolvedValue({ totalDue: 1200 });

    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 200, method: 'cash' }, reqAt(BRANCH_B, 'branch')
    );

    const [, , payload] = SMSService.sendPaymentReceiptAsync.mock.calls[0];
    expect(payload.remainingDue).toBe(1000);
  });

  it('forwards the collection screen\'s SMS switch', async () => {
    stubCustomer(5000);
    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 500, method: 'cash', sendSms: true }, reqAt(BRANCH_A)
    );
    expect(SMSService.sendPaymentReceiptAsync.mock.calls[0][2].forceSend).toBe(true);
  });

  it('leaves the shop setting in charge when the switch is absent', async () => {
    // Every caller that predates the switch. `forceSend: false` means the
    // sender falls through to `settings.smsSettings.autoSendOnDuePayment`,
    // which is exactly the behaviour those callers have always had.
    stubCustomer(5000);
    await customerService.collectDuePayment(
      SHOP, USER, CUSTOMER, { amount: 500, method: 'cash' }, reqAt(BRANCH_A)
    );
    expect(SMSService.sendPaymentReceiptAsync.mock.calls[0][2].forceSend).toBe(false);
  });

  it('is not sent when the settlement throws', async () => {
    /**
     * The other half of the race. The send used to be dispatched from INSIDE
     * the transaction callback, so a collection that failed validation — or
     * one whose transaction aborted — still texted the customer a receipt for
     * money the books never recorded.
     */
    stubCustomer(1000);

    await expect(
      customerService.collectDuePayment(
        SHOP, USER, CUSTOMER, { amount: 5000, method: 'cash' }, reqAt(BRANCH_A)
      )
    ).rejects.toThrow();

    expect(SMSService.sendPaymentReceiptAsync).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The body itself
 * ════════════════════════════════════════════════════════════════════════════ */

describe('buildPaymentReceipt', () => {
  it('states a remaining balance', () => {
    expect(
      buildPaymentReceipt({
        customerName: 'Rahim Mia', amount: 500, remainingDue: 1000, shopName: 'Rahim Store',
      })
    ).toBe('Rahim Mia,\nTk500 payment received.\nCurrent due: Tk1000\nThank you - Rahim Store');
  });

  it('says the khata is clear in words rather than printing Tk0', () => {
    // The single most valuable thing this message can tell a customer, and
    // `Current due: Tk0` is the line they read three times to be sure of.
    expect(
      buildPaymentReceipt({
        customerName: 'Rahim Mia', amount: 2000, remainingDue: 0, shopName: 'Rahim Store',
      })
    ).toBe('Rahim Mia,\nTk2000 payment received.\nNo due remaining.\nThank you - Rahim Store');
  });

  it('says nothing about the balance when the caller does not know it', () => {
    /**
     * `recordPayment` settles one named invoice; what the customer owes overall
     * is a question it never asked. Printing `Tk0` there would tell a customer
     * owing ৳2,990 that they are clear — the same failure `showsTotalDue`
     * exists to prevent on the sale receipt.
     */
    const body = buildPaymentReceipt({
      customerName: 'Rahim Mia', amount: 500, remainingDue: null, shopName: 'Rahim Store',
    });
    expect(body).toBe('Rahim Mia,\nTk500 payment received.\nThank you - Rahim Store');
    expect(body).not.toMatch(/due/i);
  });

  it('renders a template-picker token so the picker shows the whole message', () => {
    expect(
      buildPaymentReceipt({
        customerName: '{customer_name}',
        amount: '{amount}',
        remainingDue: '{remaining_due}',
        shopName: 'Shop',
      })
    ).toContain('Current due: Tk{remaining_due}');
  });

  it('carries no receipt number — it cannot be previewed, so it is not sent', () => {
    /**
     * The রসিদ নং is derived from the payment's `_id`, which does not exist
     * when the shopkeeper is shown the preview. Putting it in the body would
     * mean either previewing a number that never reaches the customer, or
     * under-counting the segments the shop is billed for. It lives on the
     * printed slip instead, where it is free.
     */
    const body = buildPaymentReceipt({
      customerName: 'Rahim', amount: 500, remainingDue: 100, shopName: 'Shop',
    });
    expect(body).not.toMatch(/RCP-/);
    expect(body).not.toMatch(/Receipt:/);
  });
});

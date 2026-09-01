/**
 * Voiding a বাকি আদায় that should never have been taken.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE IS THE CAREFUL ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A void is the only operation in the app that MANUFACTURES DEBT. It takes a
 * customer who believes they have paid and puts the balance back on them, moves
 * money out of a fund account, and changes what a past day reported. Every one
 * of those five writes has to happen, and none of them may happen twice.
 *
 * The failure mode that worries me most is not any of them going wrong — it is
 * a reader that never learned about `status` and keeps counting the reversed
 * money. That one is silent: no error, no log, just a cash figure that is high
 * by exactly the collections the shop cancelled. `describe('every reader')`
 * below scans the services for it, because a comment asking future authors to
 * remember is not a mechanism.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/sms.service', () => ({
  sendPaymentReceiptAsync: jest.fn(),
}));
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const customerService = require('../services/customer.service');
const dueSettlement = require('../services/dueSettlement.service');
const paymentAccountService = require('../services/paymentAccount.service');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');
const { LIVE_PAYMENT } = require('../utils/paymentDate.util');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const CUSTOMER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId();
const BRANCH_B = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

const req = { shop: { _id: SHOP }, user: { _id: USER, isOwner: true } };

/**
 * The customer as they stand AFTER the collection being cancelled.
 *
 * Built from the three COMPONENTS, with both money halves derived from them —
 * because that is the only shape the real document is ever in. A stub that sets
 * `totalDue` freely can assert arithmetic the model forbids: `totalDue: 3000`
 * beside `totalPaid: 2000` and no purchases describes a customer who cannot
 * exist, and a reversal validated against it is validated against nothing.
 */
const stubCustomer = ({ purchases = 5000, paid = 2000, opening = 0 } = {}) => {
  const net = purchases + opening - paid;
  const doc = {
    _id: CUSTOMER, shop: SHOP, name: 'করিম', phone: '01700000000',
    totalPurchases: purchases, openingDue: opening, totalPaid: paid,
    totalDue: Math.max(0, net),
    advanceBalance: Math.max(0, -net),
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Customer, 'findOne').mockResolvedValue(doc);
  return doc;
};

/** The payment row being voided. */
const stubPayment = (overrides = {}) => {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP,
    customer: CUSTOMER,
    branch: BRANCH_A,
    account: ACCOUNT,
    amount: 2000,
    type: 'due_collection',
    status: 'active',
    receiptNo: 'RCP-260825-A3F19C',
    branchAllocation: [],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  jest.spyOn(Payment, 'findOne').mockResolvedValue(doc);
  return doc;
};

let accountDeltas;
let balanceDeltas;
let recomputed;

beforeEach(() => {
  accountDeltas = [];
  balanceDeltas = [];
  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(async (d) => {
    accountDeltas.push(d);
  });
  jest.spyOn(CustomerBalance, 'applyDelta').mockImplementation(async (d) => {
    balanceDeltas.push(d);
  });
  // The re-derive that follows every delta. Stubbed because the real static
  // reads the row back off a connection these suites do not have.
  recomputed = [];
  jest.spyOn(CustomerBalance, 'recomputeBalances').mockImplementation(async (d) => {
    recomputed.push(d);
    return null;
  });
  // Empty allocation pool, so `reallocateCustomerInvoices` short-circuits
  // before it reaches for a real connection.
  jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  AuditLog.log.mockClear();
});

const cancel = (reason = 'ভুল কাস্টমারে এন্ট্রি হয়েছিল') =>
  dueSettlement.cancelDueCollection(
    { shopId: SHOP, userId: USER, paymentId: new mongoose.Types.ObjectId(), reason, req },
    null
  );

/* ════════════════════════════════════════════════════════════════════════════
 * The five writes
 * ════════════════════════════════════════════════════════════════════════════ */

describe('cancelDueCollection — undoing the settlement', () => {
  it('marks the row cancelled rather than deleting it', async () => {
    // The receipt is already in the customer's hand. Its number has to keep
    // resolving — to "বাতিল", which is an answer, rather than to a 404, which
    // is indistinguishable from the shop having lost the record.
    const payment = stubPayment();
    stubCustomer();

    await cancel('ভুল অ্যামাউন্ট');

    expect(payment.status).toBe('cancelled');
    expect(payment.cancelReason).toBe('ভুল অ্যামাউন্ট');
    expect(payment.cancelledBy).toBe(USER);
    expect(payment.cancelledAt).toBeInstanceOf(Date);
    expect(payment.save).toHaveBeenCalled();
  });

  it('takes the money back out of the fund account', async () => {
    stubPayment();
    stubCustomer();

    await cancel();

    expect(accountDeltas).toEqual([
      expect.objectContaining({ shop: SHOP, account: ACCOUNT, amount: -2000 }),
    ]);
  });

  it('puts the due back on the customer and removes the credit', async () => {
    // Both halves. Moving `totalDue` without `totalPaid` leaves the customer's
    // lifetime-paid figure permanently overstating what they handed over.
    // ৳5,000 of goods, ৳2,000 of it collected — void the collection and they
    // are back to owing the lot.
    const customer = stubCustomer({ purchases: 5000, paid: 2000 });
    stubPayment();

    await cancel();

    expect(customer.totalDue).toBe(5000);
    expect(customer.totalPaid).toBe(0);
    expect(customer.save).toHaveBeenCalled();
  });

  it('voiding an অগ্রিম does not manufacture a debt', async () => {
    /**
     * THE REGRESSION. This used to read `totalDue += amount` and never touch
     * `advanceBalance` at all, so voiding a ৳400 deposit taken from a customer
     * who owed nothing left them owing ৳400 they had never been billed for AND
     * still holding ৳400 of credit — both of `Customer`'s stored invariants
     * broken by one button, in the direction a shopkeeper reads as "the
     * software invented a debt".
     *
     * A deposit is cancellable through this same door on purpose (the delete
     * guard refuses to remove a customer holding one), so this is not a
     * theoretical shape.
     */
    // Bought ৳2,600, handed over ৳3,000 — ৳400 of it held as অগ্রিম.
    const customer = stubCustomer({ purchases: 2600, paid: 3000 });
    expect(customer.advanceBalance).toBe(400);
    stubPayment({ type: 'advance', amount: 400, branchAllocation: [] });

    await cancel('ভুল করে অগ্রিম রাখা হয়েছিল');

    // The deposit is gone and NOTHING took its place.
    expect(customer.totalPaid).toBe(2600);
    expect(customer.totalDue).toBe(0);
    expect(customer.advanceBalance).toBe(0);
  });

  it('re-derives the invoice allocation instead of reversing it by hand', async () => {
    // `reallocateCustomerInvoices` recomputes from a pool that no longer
    // contains the cancelled row, so the invoices this money was holding open
    // simply go back to being open — no reversal logic to get wrong.
    const spy = jest.spyOn(dueSettlement, 'reallocateCustomerInvoices');
    stubPayment();
    stubCustomer();

    await cancel();

    // Called via the module's own reference, so assert the effect rather than
    // the spy: the pool aggregate is what it runs, and it ran.
    expect(Payment.aggregate).toHaveBeenCalled();
    spy.mockRestore();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * Putting the money back where it came from
 * ════════════════════════════════════════════════════════════════════════════ */

describe('branch attribution', () => {
  it('restores each branch by the amount it actually gave', async () => {
    /**
     * The snapshot exists because the balances have moved since. Spreading the
     * reversal by TODAY's figures would credit branches that never held this
     * debt while leaving the ones that did permanently overstated — and nothing
     * would report an error.
     */
    stubPayment({
      amount: 2000,
      branchAllocation: [
        { branch: BRANCH_A, amount: 1500 },
        { branch: BRANCH_B, amount: 500 },
      ],
    });
    stubCustomer();

    await cancel();

    // The COMPONENT only — `due` is re-derived per branch, not `$inc`-ed.
    // Clamping the shop-wide book while incrementing the branch rows is exactly
    // how `Σ CustomerBalance.totalDue === Customer.totalDue` stops holding.
    expect(balanceDeltas).toEqual([
      expect.objectContaining({ branch: BRANCH_A, paid: -1500 }),
      expect.objectContaining({ branch: BRANCH_B, paid: -500 }),
    ]);
    expect(balanceDeltas.every((d) => d.due === undefined)).toBe(true);
    expect(recomputed.map((r) => r.branch)).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('falls back to the payment\'s own branch when there is no snapshot', async () => {
    // Every collection taken before `branchAllocation` existed, and every
    // single-branch shop. The money was taken at this branch, and under
    // separate books that is where `settleCustomerDue` guarantees all of it
    // landed.
    stubPayment({ branchAllocation: [] });
    stubCustomer();

    await cancel();

    expect(balanceDeltas).toEqual([
      expect.objectContaining({ branch: BRANCH_A, paid: -2000 }),
    ]);
    expect(recomputed).toEqual([
      expect.objectContaining({ branch: BRANCH_A }),
    ]);
  });

  it('touches no branch row when there is no branch at all', async () => {
    stubPayment({ branch: null, branchAllocation: [] });
    stubCustomer();

    await cancel();

    expect(balanceDeltas).toEqual([]);
    expect(recomputed).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * What it refuses
 * ════════════════════════════════════════════════════════════════════════════ */

describe('refusals', () => {
  it('requires a reason', async () => {
    // A void manufactures debt. "Why?" is the first question anyone auditing
    // this will ask, and it has to have been captured while it was still known.
    stubPayment();
    stubCustomer();

    await expect(cancel('   ')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a second cancellation rather than reversing twice', async () => {
    // A double-tapped বাতিল on a slow connection. Refusing tells the caller
    // something true; a silent success would suggest a second reversal
    // happened, and the money would be out by 2×.
    stubPayment({ status: 'cancelled' });
    stubCustomer();

    await expect(cancel()).rejects.toMatchObject({ statusCode: 400 });
    expect(accountDeltas).toEqual([]);
  });

  it('refuses anything that is not a due collection', async () => {
    /**
     * A checkout leg belongs to its sale and is undone by cancelling the sale;
     * an invoice payment moves `Sale.paid` and `Sale.status` too, which is a
     * different reversal that this one would get wrong. Refusing loudly beats a
     * void that half works.
     */
    stubPayment({ type: 'sale_payment' });
    stubCustomer();

    await expect(cancel()).rejects.toMatchObject({ statusCode: 400 });
    expect(accountDeltas).toEqual([]);
  });

  it('404s an unknown payment', async () => {
    jest.spyOn(Payment, 'findOne').mockResolvedValue(null);
    await expect(cancel()).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The trail
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the audit entry', () => {
  it('records who, why and which receipt', async () => {
    // Six months later, "why does this customer owe ৳2,000 again" has to have
    // an answer with a name, a reason and a receipt number on it.
    stubPayment();
    stubCustomer();

    await customerService.cancelDueCollection(
      SHOP, USER, new mongoose.Types.ObjectId(), { reason: 'ভুল কাস্টমার' }, req
    );

    expect(AuditLog.log).toHaveBeenCalledTimes(1);
    const entry = AuditLog.log.mock.calls[0][0];
    expect(entry.action).toBe('due_collection_cancel');
    expect(entry.user).toBe(USER);
    expect(entry.description).toContain('RCP-260825-A3F19C');
    expect(entry.description).toContain('ভুল কাস্টমার');
    expect(entry.descriptionBn).toContain('বাতিল');
  });

  it('writes nothing when the cancellation is refused', async () => {
    stubPayment({ status: 'cancelled' });
    stubCustomer();

    await expect(
      customerService.cancelDueCollection(
        SHOP, USER, new mongoose.Types.ObjectId(), { reason: 'x' }, req
      )
    ).rejects.toThrow();

    expect(AuditLog.log).not.toHaveBeenCalled();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The silent failure: a reader that forgot
 * ════════════════════════════════════════════════════════════════════════════ */

describe('LIVE_PAYMENT', () => {
  it('excludes cancelled rows without excluding rows that predate the field', () => {
    /**
     * The single most important line in this feature.
     *
     * Every Payment written before `status` existed has no `status` at all.
     * `$ne: 'cancelled'` matches a missing field; `status: 'active'` does not —
     * so the equality version would report every shop's entire history as zero,
     * on every report, with no error anywhere. It is also why there is no
     * migration: the absence of the field IS active.
     */
    expect(LIVE_PAYMENT).toEqual({ status: { $ne: 'cancelled' } });
  });
});

describe('every reader either excludes cancelled money or says why not', () => {
  /**
   * A source scan, in the same spirit as the courier-handover guard in
   * `codCourier.test.js`.
   *
   * There are fourteen places that read `Payment`, spread over eight services.
   * One of them forgetting `LIVE_PAYMENT` does not throw and does not log — it
   * just reports cash the shop does not have, forever. A convention nobody can
   * check is not a convention, so this checks it.
   *
   * A reader that deliberately INCLUDES cancelled rows — the খতিয়ান, the
   * receipt lookup, the register, the history tabs — declares itself with a
   * `cancelled-inclusive:` comment. Being forced to write that sentence is the
   * point: it is a decision, not a default.
   */
  const SERVICES = path.join(__dirname, '..', 'services');
  // The lookbehind is load-bearing: without it this also matches
  // `PlatformPayment.aggregate`, which is the PLATFORM's own income — a
  // different model, with its own reversal mechanism (`reversalOf`) and no
  // `status` field to look for.
  const READ = /(?<![A-Za-z])Payment\s*\.\s*(find|findOne|aggregate|countDocuments)\s*\(/g;

  /**
   * Index just past the `)` that closes the `(` at `open`.
   *
   * Naive about parentheses inside string literals; a Payment query containing
   * an unbalanced one in a string would make this over-read, which costs a
   * false PASS rather than a false failure. Worth it to avoid depending on a JS
   * parser for a twelve-line guard.
   */
  const balancedEnd = (source, open) => {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return source.length;
  };

  const files = fs
    .readdirSync(SERVICES)
    .filter((f) => f.endsWith('.service.js'))
    .map((f) => path.join(SERVICES, f));

  it('finds the readers it is supposed to be guarding', () => {
    // A guard that silently matches nothing passes forever. If the call shape
    // changes, this fails first and says so.
    const total = files.reduce((n, file) => {
      const src = fs.readFileSync(file, 'utf8');
      return n + (src.match(READ) || []).length;
    }, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    const name = path.basename(file);
    const src = fs.readFileSync(file, 'utf8');
    const hits = [...src.matchAll(READ)];
    if (hits.length === 0) continue;

    it(`${name} guards every Payment read`, () => {
      for (const hit of hits) {
        const lineNo = src.slice(0, hit.index).split('\n').length;
        const lines = src.split('\n');
        /**
         * The window is the CALL ITSELF plus the comment above it — not a fixed
         * number of lines.
         *
         * A line window has to be wide enough for `cashRegister`'s `$match`,
         * which runs thirty lines because half of it is prose. At that width it
         * also reaches into the NEXT reader and borrows its filter, which is a
         * guard passing on a predicate belonging to someone else. Walking the
         * parentheses is exact: it ends where the call ends.
         */
        const argsEnd = balancedEnd(src, hit.index + hit[0].length - 1);
        const preamble = lines.slice(Math.max(0, lineNo - 13), lineNo).join('\n');
        const window = preamble + '\n' + src.slice(hit.index, argsEnd);

        const guarded =
          window.includes('LIVE_PAYMENT') ||
          window.includes("status: { $ne: 'cancelled' }") ||
          window.includes('cancelled-inclusive:');

        // Thrown rather than asserted, because this Jest does not take a
        // message argument and "expected false to be true" would send the next
        // reader hunting for which of fourteen call sites it meant.
        if (!guarded) {
          throw new Error(
            `${name}:${lineNo} reads Payment without LIVE_PAYMENT and without a ` +
              `"cancelled-inclusive:" note saying why. A voided collection is money ` +
              `the shop gave back; counting it is silent and permanent.`
          );
        }
      }
    });
  }
});

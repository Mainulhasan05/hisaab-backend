/**
 * The owner's own money, and the drawer that has to know about it.
 *
 * ── The bug these close ─────────────────────────────────────────────────────
 *
 * `AccountEntry` (FUND_ACCOUNT_PLAN §3.6) exists so that an owner taking
 * ৳30,000 out of the till for household expenses has somewhere honest to put
 * it. Its own docblock names the two wrong answers it replaces, and the second
 * is this:
 *
 *   · nowhere — the cash box is ৳30,000 short of what the app expects, every
 *     day, forever.
 *
 * Phase 4 shipped the entry, and `applyAccountDelta` moved `PaymentAccount
 * .balance` correctly. But `cashRegister._calculateCashFlows` was taught about
 * transfers in Phase 3 and never came back for entries, so the register went on
 * expecting money that had legitimately left the box — and the shop's two cash
 * figures, `expectedClosing` and the cash account's `balance`, disagreed by
 * exactly the draw with nothing comparing them.
 *
 * REGRESSIONS on the register arithmetic and the flow mapping; INVARIANT GUARDS
 * on the shop that has no fund accounts.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const CashRegister = require('../models/CashRegister.model');
const AccountEntry = require('../models/AccountEntry.model');
const cashRegisterService = require('../services/cashRegister.service');

const SHOP = new mongoose.Types.ObjectId();

/** Run a document through the pre-save hook and hand back the document. */
const applyHook = (register) =>
  new Promise((resolve) => {
    CashRegister.schema.s.hooks.execPre('save', register, () => resolve(register));
  });

describe('the register counts the owner out of the drawer', () => {
  it('subtracts a withdrawal from the expected closing', async () => {
    // ৳5,000 opening, ৳40,000 sold, ৳30,000 drawn. The box holds ৳15,000 and
    // the register must say so. Before the `owner` bucket existed this read
    // ৳45,000 and the shopkeeper was ৳30,000 "short".
    const register = await applyHook(new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 5000,
      cashIn: { sales: 40000 },
      cashOut: { owner: 30000 },
    }));

    expect(register.totalCashOut).toBe(30000);
    expect(register.expectedClosing).toBe(15000);
  });

  it('adds the owner putting their own money in', async () => {
    // The same movement in reverse — cash put in to cover a delivery. It is
    // not revenue, and the drawer still has to know it is there.
    const register = await applyHook(new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 1000,
      cashIn: { sales: 2000, owner: 25000 },
    }));

    expect(register.totalCashIn).toBe(27000);
    expect(register.expectedClosing).toBe(28000);
  });

  it('counts a draw and a deposit on the same day independently', async () => {
    // Both directions land in one day's till and must not net against each
    // other before reaching the two rows the shopkeeper reads.
    const register = await applyHook(new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 0,
      cashIn: { sales: 10000, owner: 4000 },
      cashOut: { owner: 6000 },
    }));

    expect(register.cashIn.owner).toBe(4000);
    expect(register.cashOut.owner).toBe(6000);
    expect(register.expectedClosing).toBe(8000);
  });

  it('reports the difference against a real count', async () => {
    // The point of the whole exercise: the evening count now reconciles.
    const register = await applyHook(new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 5000,
      cashIn: { sales: 40000 },
      cashOut: { owner: 30000 },
      actualClosing: 15000,
    }));

    expect(register.difference).toBe(0);
  });
});

describe('_calculateCashFlows reads AccountEntry', () => {
  const CASH = new mongoose.Types.ObjectId();

  afterEach(() => jest.restoreAllMocks());

  /** Every aggregation in the flow helper answers empty except the named one. */
  function stubFlows({ entries = [] } = {}) {
    jest.spyOn(require('../models/PaymentAccount.model'), 'find').mockReturnValue({
      lean: async () => [{ _id: CASH }],
    });
    for (const model of ['Sale', 'Payment', 'Expense', 'Purchase', 'AccountTransfer']) {
      jest.spyOn(require('../models/' + model + '.model'), 'aggregate').mockResolvedValue([]);
    }
    return jest.spyOn(AccountEntry, 'aggregate').mockResolvedValue(entries);
  }

  it('returns both directions as separate figures', async () => {
    stubFlows({ entries: [{ _id: null, in: 25000, out: 30000 }] });

    const flows = await cashRegisterService._calculateCashFlows(
      SHOP, new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T23:59:59Z'), null
    );

    expect(flows.ownerIn).toBe(25000);
    expect(flows.ownerOut).toBe(30000);
  });

  it('scopes the query to the cash accounts, not to the branch', async () => {
    // An entry's `branch` is where it was RECORDED. The account is what says
    // whether the money came out of this drawer — the same rule the transfer
    // aggregations already follow.
    const agg = stubFlows({ entries: [] });

    await cashRegisterService._calculateCashFlows(
      SHOP, new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T23:59:59Z'), null
    );

    const match = agg.mock.calls[0][0][0].$match;
    expect(match.account).toEqual({ $in: [CASH] });
    expect(match.branch).toBeUndefined();
  });

  it('bounds on `date`, the day the money moved', async () => {
    // Not `createdAt`. A Thursday draw entered on Saturday belongs to
    // Thursday's till — the rule `Payment.paidAt` and `Expense.date` follow.
    const agg = stubFlows({ entries: [] });
    const start = new Date('2026-08-20T00:00:00Z');
    const end = new Date('2026-08-20T23:59:59Z');

    await cashRegisterService._calculateCashFlows(SHOP, start, end, null);

    const match = agg.mock.calls[0][0][0].$match;
    expect(match.date).toEqual({ $gte: start, $lte: end });
    expect(match.createdAt).toBeUndefined();
  });

  it('reads zero when the shop has recorded no entries', async () => {
    stubFlows({ entries: [] });

    const flows = await cashRegisterService._calculateCashFlows(
      SHOP, new Date(), new Date(), null
    );

    expect([flows.ownerIn, flows.ownerOut]).toEqual([0, 0]);
  });
});

describe('the flow mapping is written once', () => {
  it('carries both owner figures onto the register', () => {
    const register = new CashRegister({ shop: SHOP, date: new Date(), createdBy: SHOP });

    cashRegisterService._applyFlows(register, {
      sales: 1, dueCollections: 2, expenses: 3, purchases: 4, refunds: 5,
      transfersIn: 6, transfersOut: 7, ownerIn: 8, ownerOut: 9,
    });

    expect(register.cashIn.owner).toBe(8);
    expect(register.cashOut.owner).toBe(9);
  });

  it('leaves the manual boxes alone', () => {
    // `other` is what the shopkeeper typed. A recalculation that overwrites it
    // is a recalculation that eats their work — and every page load
    // recalculates.
    const register = new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      cashIn: { other: 500, otherNote: 'ঋণ ফেরত' },
      cashOut: { other: 200, otherNote: 'চা' },
    });

    cashRegisterService._applyFlows(register, {
      sales: 0, dueCollections: 0, expenses: 0, purchases: 0, refunds: 0,
      transfersIn: 0, transfersOut: 0, ownerIn: 0, ownerOut: 0,
    });

    expect(register.cashIn.other).toBe(500);
    expect(register.cashIn.otherNote).toBe('ঋণ ফেরত');
    expect(register.cashOut.other).toBe(200);
  });

  it('is the only copy of the assignment block', () => {
    // It was written out five times before this helper existed, and adding a
    // bucket meant editing all five. A call site missed is a till whose
    // expected closing omits a bucket the other four include.
    const source = fs.readFileSync(
      require.resolve('../services/cashRegister.service.js'), 'utf8'
    );
    expect(source.match(/register\.cashIn\.sales = flows\.sales;/g)).toHaveLength(1);
    expect(source.match(/this\._applyFlows\(register, flows\);/g)).toHaveLength(5);
  });
});

describe('invariant guards', () => {
  it('a shop with no fund accounts reads exactly as before (I-1)', () => {
    const register = new CashRegister({
      shop: SHOP, date: new Date(), createdBy: SHOP,
      openingBalance: 1000, cashIn: { sales: 500 },
    });

    expect(register.cashIn.owner).toBe(0);
    expect(register.cashOut.owner).toBe(0);
  });

  it('skips the entry query entirely when the shop holds no cash accounts', () => {
    // Not merely returning zero — not asking. Same rule the transfer queries
    // follow: a shop without the capability must not pay for it on the till's
    // hot path.
    const source = fs.readFileSync(
      require.resolve('../services/cashRegister.service.js'), 'utf8'
    );
    const guard = 'cashAccountIds.length === 0 ? Promise.resolve([]) : AccountEntry.aggregate';
    expect(source).toContain(guard);
  });

  it('keeps the model and the client naming the same buckets', () => {
    // The page sums its own copy of these lists. Two lists that drift make one
    // till read two different totals on two parts of one screen.
    expect(CashRegister.CASH_IN_KEYS).toEqual(
      ['sales', 'dueCollections', 'transfers', 'owner', 'other']
    );
    expect(CashRegister.CASH_OUT_KEYS).toEqual(
      ['expenses', 'purchases', 'refunds', 'transfers', 'owner', 'other']
    );
  });
});

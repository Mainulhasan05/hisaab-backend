const mongoose = require('mongoose');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const Sale = require('../models/Sale.model');
const { AppError } = require('../middleware/error.middleware');
const paymentAccountService = require('./paymentAccount.service');
const { toMoney, settlementFor, statusFor } = require('../utils/invoiceMath.util');
const { quantizeMoney } = require('../utils/quantity.util');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE PLACE MONEY REDUCES A CUSTOMER'S DUE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There are two ways a shop collects against the খাতা, and until this file
 * there was one implementation and one about to be written beside it:
 *
 *   1. বাকি আদায় on the customer page — `customer.service.collectDuePayment`.
 *   2. Surplus tendered at the till — a customer owing ৳2,200 buys ৳500 of
 *      goods, hands over ৳2,700, and the change is applied to the debt instead
 *      of being counted back across the counter.
 *
 * Both must do the SAME six things in the same order, and getting any one of
 * them wrong is silent:
 *
 *   - refuse an amount larger than the book being collected against, and under
 *     separate books that book is the BRANCH's, not the shop's (a branch
 *     writing down another branch's receivable leaves one negative and the
 *     other overstated, permanently, with no error);
 *   - write a `Payment{type:'due_collection'}` row, because that type is what
 *     every collection report, the cash register and the খতিয়ান read;
 *   - move the fund-account balance;
 *   - reduce `Customer.totalDue`, quantized per write;
 *   - allocate the same reduction across `CustomerBalance` rows oldest-first,
 *     so the invariant `Σ CustomerBalance.totalDue === Customer.totalDue`
 *     survives;
 *   - do all of it inside the caller's transaction.
 *
 * This is the same lesson `invoiceMath.util.js` was extracted for: two call
 * sites doing the same money arithmetic separately WILL drift, and the drift
 * surfaces as a book that has never reconciled rather than as an error anyone
 * can catch. So `collectDuePayment` delegates here rather than being copied.
 *
 * What deliberately stays with the CALLERS: the audit log, the receipt SMS and
 * the `paidAt` decision. Those genuinely differ per flow — a walk-in collection
 * may be backdated to the day the money arrived, while a checkout settlement is
 * dated to the sale it rode in on — and folding them in would mean one
 * parameter per difference.
 */

/**
 * Apply `amount` against a customer's outstanding due.
 *
 * @param {Object}   p
 * @param {ObjectId} p.shopId
 * @param {ObjectId} p.userId              who took the money
 * @param {Object}   p.customer            a LOADED Customer doc; mutated and saved here
 * @param {number}   p.amount              taka to apply; coerced and bounded
 * @param {ObjectId|null} p.branchId       the collecting branch
 * @param {boolean}  p.branchScoped        true when the shop keeps separate books
 * @param {string}   [p.method]            'cash' unless named
 * @param {*}        [p.rawAccount]        caller-named fund account, validated here
 * @param {Date}     [p.paidAt]            when the money changed hands
 * @param {ObjectId} [p.viaSale]           the checkout this rode in on, if any
 * @param {string}   [p.transactionId]
 * @param {string}   [p.notes]
 * @param {Object}   [p.req]               for fund-account resolution
 * @param {Object|null} session            the caller's transaction
 * @returns {Promise<{payment: Object, amount: number, dueBefore: number, dueAfter: number}>}
 */
async function settleCustomerDue(
  {
    shopId,
    userId,
    customer,
    amount: rawAmount,
    branchId = null,
    branchScoped = false,
    method,
    rawAccount = null,
    paidAt,
    viaSale = null,
    transactionId,
    notes,
    req = null,
  },
  session = null
) {
  const sessionOpt = session ? { session } : {};

  // Coerced and bounded before anything reads it. A NEGATIVE amount passes an
  // `amount > due` check and runs the ledger backwards — `totalPaid` down,
  // `totalDue` UP, plus a negative cash-in row the register subtracts from the
  // drawer. The customer routes carry no Joi schema at all, so for বাকি আদায়
  // this IS the boundary; the sale routes do carry one, and this is its second
  // line of defence.
  const amount = toMoney(rawAmount);
  if (amount <= 0) {
    throw new AppError(
      'Payment amount must be greater than 0',
      'পেমেন্টের পরিমাণ ০ এর বেশি হতে হবে',
      400
    );
  }

  // Validate against whichever book this shop keeps.
  //
  // Under separate books this MUST be the branch figure. Validating against the
  // shop-wide total would let a branch collect ৳5,000 against a due that exists
  // only at another branch: the collecting branch goes negative, the owing
  // branch stays overstated, and nothing anywhere reports an error.
  let dueBefore;
  if (branchScoped) {
    const branchBalance = await CustomerBalance.findOne(
      { shop: shopId, customer: customer._id, branch: branchId },
      null,
      sessionOpt
    );
    dueBefore = branchBalance?.totalDue || 0;
    if (amount > dueBefore) {
      throw new AppError(
        'Payment amount exceeds this branch due balance',
        'পেমেন্টের পরিমাণ এই শাখার বাকির চেয়ে বেশি',
        400
      );
    }
  } else {
    dueBefore = customer.totalDue || 0;
    if (amount > dueBefore) {
      throw new AppError(
        'Payment amount exceeds due balance',
        'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি',
        400
      );
    }
  }

  // Which fund account the money came into. Named by the caller, or resolved
  // from the method's default so an older client posting a bare
  // `method: 'bkash'` still books the money somewhere real. Null throughout for
  // a shop without `features.fundAccounts`, which makes the delta below a
  // no-op (I-1).
  const account = rawAccount
    ? (await paymentAccountService.assertUsableAccount(shopId, rawAccount, req))._id
    : await paymentAccountService.resolveAccountForMethod(
        req?.shop || { _id: shopId },
        method || 'cash',
        req
      );

  // `branch` is required: `cashRegister._calculateCashFlows` matches due
  // collections by branch, so an untagged payment is invisible to every
  // branch's till and understates expected closing (FEATURE_AUDIT.md H-6).
  const [payment] = await Payment.create(
    [
      {
        shop: shopId,
        branch: branchId,
        customer: customer._id,
        // NOT `sale`. See the note on `viaSale` in Payment.model.js — this money
        // settles older invoices, not the one it was handed over at.
        viaSale,
        amount,
        method: method || 'cash',
        account,
        transactionId,
        type: 'due_collection',
        paidAt,
        notes,
        receivedBy: userId,
      },
    ],
    sessionOpt
  );

  // Money in. `atCheckout` stays false by default on this row, which is what
  // tells `recalc-account-balances.js` and the cash register to count it HERE
  // rather than assume it was already counted as a sale leg. For a checkout
  // settlement that is not an oversight: the ৳2,200 is genuinely not in
  // `Sale.payments[]`, which carries the ৳500 bill only.
  await paymentAccountService.applyAccountDelta({
    shop: shopId,
    account,
    amount,
    session: session || null,
  });

  // The shop-wide rollup is maintained in BOTH modes, so `customerScope` stays
  // a read-path switch with nothing to migrate.
  //
  // Quantized per write, mirroring `CustomerBalance.settleDue` below and
  // `Customer.addPayment`. Unrounded, a customer who pays their book off in
  // instalments settles at 1e-13 rather than 0 and never leaves the বাকি list
  // (`totalDue: { $gt: 0 }`), with nothing left to pay that could clear them.
  customer.totalPaid = quantizeMoney((customer.totalPaid || 0) + amount);
  customer.totalDue = quantizeMoney((customer.totalDue || 0) - amount);
  await customer.save(sessionOpt);

  // A collection is not tied to an invoice, so it is allocated to the branches
  // that actually hold the debt — collecting branch first, then oldest. Under
  // separate books the check above guarantees it all lands on the collecting
  // branch, so one code path serves both modes.
  await CustomerBalance.settleDue(
    {
      shop: shopId,
      customer: customer._id,
      preferBranch: branchId,
      amount,
    },
    session
  );

  // ── And finally, the invoices that actually hold the debt ─────────────────
  //
  // The five writes above move the ROLLUPS. For eighteen months they were the
  // whole of this function, and the invoices themselves were never touched — so
  // a customer's page read ৳0 owed while the invoice that created the debt sat
  // at `due: 4200, status: 'partial'` forever, and every report that sums
  // `Sale.due` as "মোট বাকি" kept counting money the shop had already banked.
  //
  // See `reallocateCustomerInvoices` for why this is a full recompute rather
  // than a delta applied to whichever invoice happens to be oldest.
  const allocations = await reallocateCustomerInvoices(
    { shopId, customerId: customer._id, branchScoped },
    session
  );

  return {
    payment,
    amount,
    dueBefore: quantizeMoney(dueBefore),
    dueAfter: quantizeMoney(dueBefore - amount),
    // Which invoices this collection moved, so the till and the customer page
    // can tell the shopkeeper where their money went instead of showing a total
    // that changed for reasons they cannot follow.
    allocations,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SPREAD KHATA COLLECTIONS BACK OVER THE INVOICES THAT HOLD THE DEBT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Sale.due` is what ten aggregations across `report.service`,
 * `staffReport.service` and `sale.service` sum as "মোট বাকি". `Customer.totalDue`
 * is what the customer page shows. A collection tied to a named invoice
 * (`recordPayment`) has always moved both. A collection against the খাতা as a
 * whole — বাকি আদায়, or the surplus settled at a later checkout — moved only the
 * second, and the two have been drifting apart by exactly the sum of every such
 * collection ever taken.
 *
 * ── Why a recompute and not a delta ───────────────────────────────────────────
 *
 * The obvious fix is "walk the open invoices oldest-first and `$inc` them by the
 * amount just collected". It is wrong, and wrong in the way this codebase keeps
 * getting burned by: an ALLOCATION is not an EVENT. Both sides of it move on
 * their own afterwards —
 *
 *   - the invoice is cancelled, and the money allocated to it has to land
 *     somewhere else or the drift comes straight back;
 *   - the invoice is revised, which cancels it and writes a replacement;
 *   - a return is taken against it, shrinking what it can absorb;
 *   - `recordPayment` settles part of it directly, ditto.
 *
 * Four services would each need their own reversal, they would drift, and the
 * drift would be invisible — the same shape as the bug being fixed. So this
 * derives the whole allocation from scratch every time: total collections in,
 * spread over open invoices oldest-first, whatever was there before discarded.
 * That makes it idempotent, safe to call from anywhere, and self-healing —
 * historical drift repairs itself the next time anything touches the customer.
 *
 * ── Allocation order ──────────────────────────────────────────────────────────
 *
 * Oldest invoice first, which is what a shopkeeper means by "পুরোনো বাকি আগে
 * শোধ" and what `CustomerBalance.settleDue` already does on the rollup side.
 *
 * Under SEPARATE books the pool and the invoices are both partitioned by branch,
 * because `settleCustomerDue` has already refused any amount larger than the
 * collecting branch's own due — a branch must never write down another branch's
 * receivable. Under SHARED books there is one pool and one queue, because one
 * book is precisely what shared means.
 *
 * ── What is deliberately NOT allocated ────────────────────────────────────────
 *
 * `openingDue` — the pre-software খাতা figure — has no invoice behind it, so any
 * collection beyond what the open invoices can absorb simply stays unallocated.
 * That is correct rather than a shortfall: `Customer.deriveDue` already carries
 * the opening term, and inventing an invoice to hang it on would be worse than
 * leaving it where it is.
 *
 * @param {Object} p
 * @param {ObjectId} p.shopId
 * @param {ObjectId} p.customerId
 * @param {boolean} [p.branchScoped]  omit to resolve from the shop — see below
 * @param {Object|null} session
 * @returns {Promise<Array<{sale, invoiceNo, applied, dueBefore, dueAfter, cleared}>>}
 *   only the invoices whose allocation CHANGED, newest change first — the list
 *   the UI shows as "এই টাকা কোন বিলে বসেছে".
 */
async function reallocateCustomerInvoices(
  { shopId, customerId, branchScoped },
  session = null
) {
  if (!customerId) return [];

  const sessionOpt = session ? { session } : {};
  const shopOid = new mongoose.Types.ObjectId(String(shopId));
  const customerOid = new mongoose.Types.ObjectId(String(customerId));

  // ── The pool: every ৳ this customer has handed over off-invoice ───────────
  //
  // TWO types, and they are here for the same reason despite being different
  // economic events. `due_collection` is money settling debt the shop had
  // already earned; `advance` is a deposit against goods not yet sold. What
  // they share is the only property this function cares about: the customer
  // gave it to us, and it is not tied to any one invoice. Both are therefore
  // available to settle whatever this customer owes, oldest first.
  //
  // Keeping them separate as TYPES while joining them HERE is deliberate — see
  // PAYMENT_TYPES.ADVANCE. The reports that must not conflate them read the
  // type; the two places that must join them (this pool, and the cash drawer)
  // say so out loud with an `$in`.
  //
  // Grouped by branch so separate books can be kept separate below; a
  // single-branch shop puts everything under the one null key.
  //
  // FIRST, and deliberately so. This runs on every `recordPayment`, every
  // cancellation and every return, and for the overwhelming majority of
  // customers — anyone who has never had a khata collection taken — the answer
  // is "nothing to allocate". Served straight off `{shop, customer, createdAt}`,
  // so the common case costs one indexed aggregate and nothing else: no shop
  // lookup, no invoice scan, no writes.
  //
  // The session rides in the OPTIONS argument rather than through `.session()`.
  // Both join the transaction; this one leaves the call a plain awaitable, which
  // is what lets the unit suites that mock this module's collaborators stub it
  // with a flat `mockResolvedValue([])` instead of hand-building an Aggregate.
  const pools = await Payment.aggregate(
    [
      { $match: { shop: shopOid, customer: customerOid, type: { $in: ['due_collection', 'advance'] } } },
      { $group: { _id: '$branch', total: { $sum: '$amount' } } },
    ],
    sessionOpt
  );

  if (!pools || pools.length === 0) return [];

  /**
   * Resolved HERE rather than trusted from the caller, unless the caller is
   * holding the answer already.
   *
   * This function is called from four services and only one of them
   * (`settleCustomerDue`) has a `req` to read the flag off — `cancelSale`,
   * `recordPayment` and the returns path take a bare `shopId`. Defaulting the
   * parameter to `false` would therefore have made the WRONG mode the silent
   * default for exactly the callers least able to notice: under separate books,
   * a cancellation would re-spread one branch's khata money across another
   * branch's invoices — the same cross-branch write-down `settleCustomerDue`
   * refuses to let a cashier do by hand.
   *
   * So an omitted flag means "look it up", not "assume shared". Placed after
   * the pool check because a shop with no collections never needs the answer.
   */
  if (branchScoped === undefined) {
    const Shop = require('../models/Shop.model');
    const shop = await Shop.findById(shopId, 'multiBranchEnabled customerScope')
      .session(session || null)
      .lean();
    branchScoped = Boolean(shop?.multiBranchEnabled) && shop?.customerScope !== 'shop';
  }

  // ── The queue: every invoice that could still hold some of it ──────────────
  //
  // Cancelled invoices are excluded — a voided sale is not a receivable, and
  // allocating to one would hide money that has to land on a live invoice.
  //
  // Ordered by `saleDate` where present and `createdAt` otherwise: a backdated
  // invoice belongs in the queue on the day it happened, not the day it was
  // typed in, which is the same rule `paymentDate.util` applies to money.
  const sales = await Sale.find(
    { shop: shopId, customer: customerId, status: { $ne: 'cancelled' } },
    'invoiceNo branch total paid returnedAdjustment ledgerSettled due status saleDate createdAt',
    { ...sessionOpt, lean: true }
  ).sort({ createdAt: 1 });

  sales.sort((a, b) => {
    const aAt = a.saleDate || a.createdAt;
    const bAt = b.saleDate || b.createdAt;
    return new Date(aAt) - new Date(bAt);
  });

  // One pool and one queue under shared books; one of each PER BRANCH under
  // separate books. `String(null)` and `String(undefined)` differ, so branches
  // are keyed through a helper that flattens both to the same single-branch key.
  const key = (branch) => (branch ? String(branch) : '~');
  const remaining = new Map();
  if (branchScoped) {
    for (const p of pools) remaining.set(key(p._id), quantizeMoney(p.total));
  } else {
    remaining.set('~', quantizeMoney(pools.reduce((s, p) => s + p.total, 0)));
  }

  /**
   * ── The পুরোনো খাতা comes off the pool FIRST ─────────────────────────────
   *
   * `openingDue` is the balance the customer carried in from the shop's paper
   * খাতা. It is older than every invoice in the system by construction, so
   * oldest-first means it is settled before any of them — and it has no invoice
   * to record that on, so its share is simply consumed here.
   *
   * Skipping this step is subtly wrong in two directions:
   *
   *   1. It back-dates money. A customer with ৳11,000 of opening debt who pays
   *      ৳5,000 has cleared ৳5,000 of the খাতা, not their ৳260 invoice from
   *      last week. Closing the invoice instead tells the shop the newest debt
   *      is settled and the oldest is not, which is the reverse of what
   *      happened, and it is the aging report that reads it.
   *
   *   2. It makes an unrelated FUTURE sale settle itself. Left in the pool,
   *      that ৳4,740 of unallocated money would be picked up by the next credit
   *      invoice this customer takes — the shopkeeper sells ৳3,000 on বাকি and
   *      the invoice reads "পুরো পেয়েছি" before the customer is out of the
   *      shop. The recompute is global, so this would appear the first time
   *      anything touched the customer, long after the sale, with nothing to
   *      connect the two.
   *
   *      ── This is NOT the advance case, and the difference is the point ────
   *
   *      An `advance` row is money the customer deliberately left on deposit,
   *      and a future invoice consuming it is the entire feature. Point 2 is
   *      about surplus arriving by ACCIDENT — unlabelled pool money left over
   *      because an opening balance was skipped — where the shopkeeper never
   *      agreed to anything and the invoice closing itself is inexplicable.
   *
   *      What separates them is intent recorded at the till: `advance` is typed
   *      by the cashier, confirmed by the customer, and visible as a balance on
   *      the customer's page BEFORE it is spent. Consuming opening debt first,
   *      immediately below, is what keeps the accidental kind out of the pool
   *      so only the deliberate kind survives to reach an invoice.
   *
   *      So do not "fix" this by capping the pool at what the invoices can
   *      absorb — that cap is what would break advances, and it would do it
   *      silently.
   *
   * Read per branch under separate books, for the same reason everything else
   * here is: `CustomerBalance.openingDue` is that branch's share, and charging
   * one branch's collection against another's opening debt is the same
   * cross-branch write-down group C exists to prevent.
   *
   * `Customer.openingDue` is NOT decremented — it is a permanent record of what
   * the খাতা said on day one, and `deriveDue` already nets collections off
   * through `totalPaid`. This consumes pool, not the field.
   */
  const openings = new Map();
  if (branchScoped) {
    const rows = await CustomerBalance.find(
      { shop: shopId, customer: customerId },
      'branch openingDue',
      { ...sessionOpt, lean: true }
    );
    for (const r of rows) openings.set(key(r.branch), quantizeMoney(r.openingDue || 0));
  } else {
    const cust = await Customer.findById(customerId, 'openingDue')
      .session(session || null)
      .lean();
    openings.set('~', quantizeMoney(cust?.openingDue || 0));
  }

  for (const [bucket, pool] of remaining) {
    const opening = openings.get(bucket) || 0;
    if (opening > 0) {
      remaining.set(bucket, quantizeMoney(Math.max(0, pool - opening)));
    }
  }

  const changed = [];

  for (const sale of sales) {
    const bucket = branchScoped ? key(sale.branch) : '~';
    const pool = remaining.get(bucket) || 0;

    // What this invoice can absorb, and what it owes once it has. Derived from
    // the STORED figures via the shared helper rather than read off `sale.due`,
    // because `due` already has the previous allocation baked into it — using it
    // would make each pass allocate on top of the last instead of replacing it,
    // and the idempotence the whole design rests on would be gone.
    const { due: capacity } = settlementFor({
      total: sale.total || 0,
      paid: sale.paid || 0,
      returnedAdjustment: sale.returnedAdjustment,
      ledgerSettled: 0,
    });

    const take = quantizeMoney(Math.min(pool, capacity));
    const before = quantizeMoney(sale.ledgerSettled || 0);

    if (take !== before) {
      const dueBefore = quantizeMoney(sale.due || 0);
      const settled = settlementFor({
        total: sale.total || 0,
        paid: sale.paid || 0,
        returnedAdjustment: sale.returnedAdjustment,
        ledgerSettled: take,
      });

      /**
       * `updateOne`, NOT `sale.save()`.
       *
       * `Sale.pre('save')` re-derives every figure on the invoice from
       * `this.items` — which means saving here would require loading the full
       * line items of every one of a customer's invoices to move a single
       * number on some of them, on a path that runs at every checkout payment,
       * cancellation and return. Proportional to basket size, for nothing.
       *
       * This is not the "patch it by hand" that `invoiceMath.util`'s header
       * warns about: `settlementFor` is the same function the hook calls, split
       * out precisely so this call site could share it rather than copy it.
       * `subtotal`, `total`, `discountAmount` and `profit` are untouched, so
       * there is nothing else for the hook to re-derive.
       *
       * `reviseSale` skips the hook by update for the same reason.
       */
      await Sale.updateOne(
        { _id: sale._id },
        {
          $set: {
            ledgerSettled: settled.ledgerSettled,
            due: settled.due,
            status: statusFor({
              due: settled.due,
              paid: sale.paid || 0,
              settled: quantizeMoney(settled.ledgerSettled + settled.returnedAdjustment),
              current: sale.status,
            }),
          },
        },
        sessionOpt
      );

      changed.push({
        sale: sale._id,
        invoiceNo: sale.invoiceNo,
        applied: quantizeMoney(settled.ledgerSettled - before),
        dueBefore,
        dueAfter: settled.due,
        cleared: settled.due <= 0,
      });
    }

    remaining.set(bucket, quantizeMoney(pool - take));
  }

  // Most recently affected first: the invoice a shopkeeper is looking for after
  // taking money is the one that just closed, not the oldest one on the book.
  return changed.reverse();
}

/**
 * What a customer owes in the book this shop keeps, read BEFORE a sale touches
 * it. This is both the snapshot `Sale.previousDue` stores and the ceiling a
 * checkout settlement is capped at.
 *
 * Returns 0 rather than null for a customer with no branch row yet: they owe
 * this branch nothing, which is a real answer and not a missing one. Returns
 * null only for a walk-in with no customer record at all — there is no book.
 *
 * `customerDoc` is an optimisation with teeth. Every checkout for a known
 * customer takes this snapshot, not just the ones that settle something, and
 * `createSale` has already loaded the document — so under SHARED books an
 * extra `findOne` here would be one more round trip on the hottest path in
 * the app for a figure sitting in memory. Under separate books the branch row
 * is a different document and must still be read.
 *
 * Passing a doc whose `totalDue` has already been moved by the caller would
 * quietly raise the ceiling, so callers must hand over the pre-rollup document
 * — which is exactly the order `createSale` is pinned to by test.
 */
async function readCollectableDue(
  { shopId, customerId, branchId, branchScoped, customerDoc = null },
  session = null
) {
  if (!customerId) return null;

  if (branchScoped) {
    const row = await CustomerBalance.findOne(
      { shop: shopId, customer: customerId, branch: branchId },
      'totalDue',
      session ? { session } : {}
    ).lean();
    return quantizeMoney(row?.totalDue || 0);
  }

  if (customerDoc) return quantizeMoney(customerDoc.totalDue || 0);

  const doc = await Customer.findOne({ _id: customerId, shop: shopId }, 'totalDue')
    .session(session || null)
    .lean();
  return quantizeMoney(doc?.totalDue || 0);
}

module.exports = { settleCustomerDue, readCollectableDue, reallocateCustomerInvoices };

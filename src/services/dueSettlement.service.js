const mongoose = require('mongoose');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const Sale = require('../models/Sale.model');
const { AppError } = require('../middleware/error.middleware');
const paymentAccountService = require('./paymentAccount.service');
const { toMoney, settlementFor, statusFor } = require('../utils/invoiceMath.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { buildPaymentReceiptNo } = require('../utils/receiptNo.util');

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
 * Check the invoices a shopkeeper picked before any of them is recorded.
 *
 * Returns `[]` for the default case — no picks — which is what keeps an
 * ordinary বাকি আদায় byte-identical to what it always posted.
 *
 * Every rule here exists because breaking it writes a wrong number rather than
 * throwing: an invoice belonging to someone else, to another branch's book, or
 * one already settled would all be accepted by the recompute and would move
 * money the collection has no claim on.
 */
async function validateTargets({
  shopId, customerId, branchId, branchScoped, amount, appliedTo, session,
}) {
  if (!Array.isArray(appliedTo) || appliedTo.length === 0) return [];

  // Order is preserved: the picker lists invoices oldest-first, so an
  // amount-less pick fills them in that order.
  const wanted = [];
  const seen = new Set();
  for (const row of appliedTo) {
    const saleId = row && (row.sale || row.saleId || row._id);
    if (!saleId || !mongoose.Types.ObjectId.isValid(String(saleId))) {
      throw new AppError('Invalid invoice in allocation', 'ইনভয়েস সঠিক নয়', 400);
    }
    const id = String(saleId);
    // Naming the same invoice twice is a client bug, not a shopkeeper's intent.
    // Ignored rather than rejected: it has one correct reading.
    if (seen.has(id)) continue;
    seen.add(id);
    wanted.push({ id, amount: quantizeMoney(Number(row && row.amount) || 0) });
  }
  if (wanted.length === 0) return [];

  const sales = await Sale.find(
    {
      _id: { $in: wanted.map((w) => new mongoose.Types.ObjectId(w.id)) },
      shop: shopId,
      customer: customerId,
      status: { $ne: 'cancelled' },
    },
    'invoiceNo branch total paid returnedAdjustment',
    { session: session || null, lean: true }
  );

  if (sales.length !== wanted.length) {
    throw new AppError(
      'Invoice not found for this customer',
      'এই কাস্টমারের এমন কোনো ইনভয়েস পাওয়া যায়নি',
      404
    );
  }

  const byId = new Map(sales.map((sale) => [String(sale._id), sale]));

  /**
   * ── An amount-less pick means "as much of this bill as this money covers" ──
   *
   * The client sends invoice ids, not figures. That is deliberate: a client
   * that computes money computes it from a list it fetched some seconds ago,
   * and by the time the request lands the invoice may have been paid down at
   * the counter or returned against. The capacity is therefore read here, from
   * the same stored fields the recompute reads, at the moment of the write.
   *
   * Filled in the order the picker listed them — oldest first — so a collection
   * smaller than the ticked bills behaves the way a shopkeeper expects rather
   * than spreading itself thinly across all of them.
   */
  let left = quantizeMoney(amount);
  const out = [];

  for (const w of wanted) {
    const sale = byId.get(w.id);

    if (branchScoped && String(sale.branch || '') !== String(branchId || '')) {
      throw new AppError(
        'Invoice belongs to another branch',
        'এই ইনভয়েসটি অন্য শাখার',
        400
      );
    }

    // Capacity from the STORED figures with `ledgerSettled: 0`, the same way
    // the recompute does it — `sale.due` already carries the previous
    // allocation, so checking against it would refuse a re-allocation that
    // merely moves money from one invoice to another.
    const { due: capacity } = settlementFor({
      total: sale.total || 0,
      paid: sale.paid || 0,
      returnedAdjustment: sale.returnedAdjustment,
      ledgerSettled: 0,
    });

    if (w.amount > quantizeMoney(capacity) + 0.001) {
      throw new AppError(
        `Invoice ${sale.invoiceNo} cannot absorb that much`,
        `${sale.invoiceNo} ইনভয়েসে এত টাকা বসবে না`,
        400
      );
    }

    const take = quantizeMoney(Math.min(w.amount > 0 ? w.amount : capacity, capacity, left));
    if (take <= 0) continue;

    out.push({ sale: new mongoose.Types.ObjectId(w.id), amount: take });
    left = quantizeMoney(left - take);
  }

  if (left < -0.001) {
    throw new AppError(
      'Allocated more than collected',
      'যত টাকা নেওয়া হয়েছে তার বেশি ভাগ করা যাবে না',
      400
    );
  }

  return out;
}

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
 * @param {Array<{sale, amount}>} [p.appliedTo]  invoices the owner picked; omit
 *   for the default oldest-first spread. Validated here and stored on the
 *   Payment — see `Payment.appliedTo` for why it is stored rather than applied.
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
    appliedTo = null,
    transactionId,
    notes,
    /**
     * Permit money beyond the debt to be held as অগ্রিম জমা.
     *
     * `false` for every caller that existed before advances did, so the ceiling
     * those callers have always had is preserved BY CONSTRUCTION rather than by
     * everyone remembering to keep it. Only the doors built for it — the
     * standalone deposit, the surplus collection, and the till's
     * change-to-hand-back toggle — pass it.
     */
    allowAdvance = false,
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
    if (amount > dueBefore && !allowAdvance) {
      throw new AppError(
        'Payment amount exceeds this branch due balance',
        'পেমেন্টের পরিমাণ এই শাখার বাকির চেয়ে বেশি',
        400
      );
    }
  } else {
    dueBefore = customer.totalDue || 0;
    if (amount > dueBefore && !allowAdvance) {
      throw new AppError(
        'Payment amount exceeds due balance',
        'পেমেন্টের পরিমাণ বাকির চেয়ে বেশি',
        400
      );
    }
  }

  /**
   * ── The split, and why it is TWO ROWS ────────────────────────────────────
   *
   * A customer owing ৳2,000 who hands over ৳3,000 has done two things at once:
   * discharged a debt and made a deposit. They are different economic events —
   * one REDUCES A RECEIVABLE the shop had already earned, the other CREATES A
   * LIABILITY it is merely holding — and a single row carrying ৳3,000 would
   * force every report to mislabel one of them forever. The daily summary would
   * report ৳3,000 of "বাকি আদায়", and an owner judging whether their customers
   * are paying up would be reading a number that answers a different question.
   *
   * So each half is its own row, and the pair shares `paidAt`, `method`,
   * `account` and a `receiptGroup` so the UI can present the one event it was.
   * Where the two genuinely belong together — the cash drawer, the reallocation
   * pool — the match is an explicit `$in` naming both.
   */
  const appliedToDue = quantizeMoney(Math.min(amount, dueBefore));
  const advancePart = quantizeMoney(amount - appliedToDue);

  // Which fund account the money came into. Named by the caller, or resolved
  // from the method's default so an older client posting a bare
  // `method: 'bkash'` still books the money somewhere real. Null throughout for
  // a shop without `features.fundAccounts`, which makes the delta below a
  // no-op (I-1).
  const account = rawAccount
    ? (await paymentAccountService.assertUsableAccount(shopId, rawAccount, req, method))._id
    : await paymentAccountService.resolveAccountForMethod(
        req?.shop || { _id: shopId },
        method || 'cash',
        req
      );

  // `branch` is required: `cashRegister._calculateCashFlows` matches due
  // collections by branch, so an untagged payment is invisible to every
  // branch's till and understates expected closing (FEATURE_AUDIT.md H-6).
  // The row's identity is minted HERE rather than left to `Payment.create`,
  // because the receipt number is derived from it (see receiptNo.util.js) and
  // it has to be on the document the customer is handed, not patched in by a
  // second write that could fail on its own.
  const paymentId = new mongoose.Types.ObjectId();
  // What the customer still owes AFTER this collection. Measured on the part
  // that actually settled debt — a deposit does not reduce a receivable, and a
  // receipt claiming otherwise would tell the customer their খাতা is smaller
  // than it is.
  const dueAfter = quantizeMoney(dueBefore - appliedToDue);
  // Ties the pair together when a payment straddles the boundary. Absent on the
  // single-row case, which is every collection ever written before advances
  // existed (I-1).
  const receiptGroup = advancePart > 0 && appliedToDue > 0
    ? new mongoose.Types.ObjectId()
    : undefined;

  // Validated BEFORE the row is written, not filtered afterwards. A target that
  // names another customer's invoice, or another branch's under separate books,
  // is a request to write down a receivable this collection has no claim on —
  // the same cross-branch write-down the amount check above already refuses.
  // Silently dropping it would settle the money somewhere the owner did not
  // choose, and tell them it worked.
  const targets = await validateTargets({
    shopId, customerId: customer._id, branchId, branchScoped, amount, appliedTo, session,
  });

  const advanceId = advancePart > 0 ? new mongoose.Types.ObjectId() : null;

  const [payment] = await Payment.create(
    [
      {
        _id: paymentId,
        shop: shopId,
        ...(receiptGroup ? { receiptGroup } : {}),
        branch: branchId,
        customer: customer._id,
        // NOT `sale`. See the note on `viaSale` in Payment.model.js — this money
        // settles older invoices, not the one it was handed over at.
        viaSale,
        // The DEBT half only. `amount` is what crossed the counter; this row
        // is what it settled.
        amount: appliedToDue,
        method: method || 'cash',
        account,
        transactionId,
        type: 'due_collection',
        // Empty for an ordinary collection, which is the overwhelming majority
        // and behaves exactly as it always did: oldest invoice first.
        appliedTo: targets,
        paidAt,
        notes,
        receivedBy: userId,
        // ── What the printed রসিদ and the customer's SMS both quote ──────────
        //
        // Frozen on the row at the moment of collection. Both numbers are from
        // the book this collection was validated against a few lines above —
        // the branch's under separate books, the shop's under shared — so the
        // slip in the customer's hand, the message on their phone and the
        // balance the collecting counter just showed all say the same thing.
        //
        // Snapshotting rather than deriving is what makes a REPRINT honest: the
        // customer's balance will have moved by next week, and a receipt that
        // silently updates itself is not a receipt.
        receiptNo: buildPaymentReceiptNo(paymentId, paidAt),
        dueBefore: quantizeMoney(dueBefore),
        dueAfter,
      },
    ],
    sessionOpt
  );

  /**
   * The deposit half — its own row, its own type.
   *
   * Written only when money went past the debt, so an ordinary collection
   * creates exactly the one row it always did. `dueBefore`/`dueAfter` are
   * deliberately NOT set on it: those describe a receivable, and this row did
   * not touch one.
   */
  let advanceRow = null;
  if (advancePart > 0) {
    [advanceRow] = await Payment.create(
      [
        {
          _id: advanceId,
          shop: shopId,
          branch: branchId,
          customer: customer._id,
          viaSale,
          ...(receiptGroup ? { receiptGroup } : {}),
          amount: advancePart,
          method: method || 'cash',
          account,
          transactionId,
          type: 'advance',
          paidAt,
          notes,
          receivedBy: userId,
          receiptNo: buildPaymentReceiptNo(advanceId, paidAt),
        },
      ],
      sessionOpt
    );
  }

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
  //
  // `totalPaid` takes the WHOLE amount — deposit included, because the customer
  // really handed it over — and both money halves are then DERIVED from the
  // three components. Subtracting `amount` from `totalDue` directly, as this
  // did, cannot express the other half: a customer who overpays would simply
  // clamp at zero and the deposit would stop existing.
  customer.totalPaid = quantizeMoney((customer.totalPaid || 0) + amount);
  Customer.applyBalances(customer);
  await customer.save(sessionOpt);

  // A collection is not tied to an invoice, so it is allocated to the branches
  // that actually hold the debt — collecting branch first, then oldest. Under
  // separate books the check above guarantees it all lands on the collecting
  // branch, so one code path serves both modes.
  // The return value is kept, not discarded: it is the only record of WHICH
  // branches' books this money reduced, and a cancellation has to put it back
  // exactly there. See `Payment.branchAllocation`.
  // Only the DEBT half is allocated across branches: `settleDue` exists to
  // decide whose receivable this money reduces, and a deposit reduces none.
  const branchAllocation = appliedToDue > 0
    ? await CustomerBalance.settleDue(
      {
        shop: shopId,
        customer: customer._id,
        preferBranch: branchId,
        amount: appliedToDue,
      },
      session
    )
    : [];

  /**
   * The deposit lands on the branch that took it, and nowhere else.
   *
   * There is no allocation question to answer — no branch holds a receivable
   * for it — and spreading it would credit branches that never saw the money.
   * `recomputeBalances` afterwards because `applyDelta` can only `$inc`, and an
   * `$inc` cannot tell a payable from a deposit.
   *
   * A no-op for single-branch shops, where `branchId` is null (I-1).
   */
  if (advancePart > 0 && branchId) {
    await CustomerBalance.applyDelta(
      { shop: shopId, customer: customer._id, branch: branchId, paid: advancePart },
      session
    );
    await CustomerBalance.recomputeBalances(
      { shop: shopId, customer: customer._id, branch: branchId },
      session
    );
  }

  if (branchAllocation.length > 0) {
    await Payment.updateOne(
      { _id: paymentId },
      { $set: { branchAllocation } },
      sessionOpt
    );
    payment.branchAllocation = branchAllocation;
  }

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
    // The deposit half, when there was one. Callers show it: a cashier who has
    // just taken ৳700 of someone's money needs to say so out loud, and the
    // customer's receipt has to name it or they will believe it was pocketed.
    advancePayment: advanceRow,
    amount,
    appliedToDue,
    advancePart,
    dueBefore: quantizeMoney(dueBefore),
    dueAfter,
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
      {
        $match: {
          shop: shopOid,
          customer: customerOid,
          type: { $in: ['due_collection', 'advance'] },
          // A voided collection is not money the shop is holding, so it must
          // not settle an invoice. `$ne` rather than `status: 'active'`: every
          // row written before the field existed has no `status` at all, and an
          // equality test would exclude all of them — emptying the pool and
          // silently un-allocating every khata payment ever taken.
          status: { $ne: 'cancelled' },
        },
      },
      {
        $group: {
          _id: '$branch',
          total: { $sum: '$amount' },
          // Every invoice the shopkeeper named, flattened across this branch's
          // collections. Carried out of the same indexed aggregate the pool
          // total already costs, rather than fetched in a second query.
          targets: { $push: '$appliedTo' },
        },
      },
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
   * ── The shopkeeper's own instructions ───────────────────────────────────
   *
   * `Payment.appliedTo` is where "put this ৳5,000 on HFG-403" is recorded. It
   * is read here as an INPUT to the recompute, never as a substitute for it —
   * see the field's note on why a direct write onto the invoice would be undone
   * by the next pass.
   *
   * Summed per invoice, because several collections may name the same one:
   * ৳2,000 last week and ৳3,000 today is ৳5,000 against that invoice, not the
   * later figure replacing the earlier.
   *
   * Targeted money is RESERVED out of the general pool immediately below, which
   * is what stops the পুরোনো খাতা step and the oldest-first loop from spending
   * it on something the owner did not choose.
   */
  const targetedBySale = new Map();
  const targetedByBucket = new Map();
  for (const row of pools) {
    const bucket = branchScoped ? key(row._id) : '~';
    for (const list of row.targets || []) {
      for (const t of list || []) {
        if (!t || !t.sale) continue;
        const amt = quantizeMoney(Number(t.amount) || 0);
        if (amt <= 0) continue;
        const id = String(t.sale);
        targetedBySale.set(id, quantizeMoney((targetedBySale.get(id) || 0) + amt));
        targetedByBucket.set(bucket, quantizeMoney((targetedByBucket.get(bucket) || 0) + amt));
      }
    }
  }

  for (const [bucket, reserved] of targetedByBucket) {
    const pool = remaining.get(bucket) || 0;
    // Floored at zero: a target can only ever have been validated against money
    // that was actually collected, but a voided collection removes its amount
    // from the pool while its `appliedTo` row goes with it, and clamping here
    // costs nothing and cannot go negative in any order of events.
    remaining.set(bucket, quantizeMoney(Math.max(0, pool - reserved)));
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

  /**
   * ── Pass one: what the owner asked for ──────────────────────────────────
   *
   * Run BEFORE the oldest-first loop, and separately from it, because a target
   * may name a NEWER invoice than one the loop would otherwise fill — the whole
   * point of letting the owner choose. Capping each target at what its invoice
   * can still absorb happens here so the loop below sees a settled picture.
   *
   * What cannot be honoured goes back into the general pool rather than being
   * dropped. An invoice can shrink or vanish between the collection and this
   * recompute — cancelled, revised, returned against, or paid down at the
   * counter — and money the customer really handed over has to land somewhere.
   * Silently discarding it would put `Sale.due` and `Customer.totalDue` back
   * out of step, which is the exact drift this whole file exists to close.
   */
  const targetedApplied = new Map();
  if (targetedBySale.size > 0) {
    for (const sale of sales) {
      const wanted = targetedBySale.get(String(sale._id)) || 0;
      if (wanted <= 0) continue;

      const { due: capacity } = settlementFor({
        total: sale.total || 0,
        paid: sale.paid || 0,
        returnedAdjustment: sale.returnedAdjustment,
        ledgerSettled: 0,
      });

      const usable = quantizeMoney(Math.min(wanted, capacity));
      targetedApplied.set(String(sale._id), usable);

      const orphaned = quantizeMoney(wanted - usable);
      if (orphaned > 0) {
        const bucket = branchScoped ? key(sale.branch) : '~';
        remaining.set(bucket, quantizeMoney((remaining.get(bucket) || 0) + orphaned));
      }
    }

    // A target naming an invoice that is no longer in the queue at all — the
    // sale was cancelled, so `sales` never loaded it. Same rule: the money is
    // real, so it returns to the pool. Bucketed by the branch that collected
    // it, since the invoice it pointed at is gone and cannot say.
    const seen = new Set(sales.map((sale) => String(sale._id)));
    for (const [id, wanted] of targetedBySale) {
      if (seen.has(id)) continue;
      for (const [bucket, reserved] of targetedByBucket) {
        if (reserved <= 0) continue;
        remaining.set(bucket, quantizeMoney((remaining.get(bucket) || 0) + wanted));
        break;
      }
    }
  }

  const changed = [];

  for (const sale of sales) {
    const bucket = branchScoped ? key(sale.branch) : '~';
    const pool = remaining.get(bucket) || 0;
    // What this invoice was promised, already capped at what it can hold.
    const promised = targetedApplied.get(String(sale._id)) || 0;

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

    // Targeted money is already reserved out of `pool`, so it is added rather
    // than competed for; the general pool then fills whatever room is left.
    const fromPool = quantizeMoney(Math.min(pool, Math.max(0, capacity - promised)));
    const take = quantizeMoney(promised + fromPool);
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

    // Only the untargeted part comes off the pool — `promised` was withheld
    // from it before the loop began.
    remaining.set(bucket, quantizeMoney(pool - fromPool));
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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * VOID A বাকি আদায় THAT SHOULD NEVER HAVE BEEN TAKEN
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `immutableGuard` has refused to delete a Payment since it was written, and
 * the error it raises tells the caller to "use void/cancel instead". Nothing
 * ever built that. So a collection keyed against the wrong customer, or for
 * ৳20,000 instead of ৳2,000, was permanent — the customer's খাতা, the shop's
 * cash and every report were wrong together and no operation in the system
 * could put them right. A shopkeeper's only recourse was to invent a
 * compensating entry somewhere else, which is how a book stops reconciling.
 *
 * ── This undoes exactly what `settleCustomerDue` did, in reverse ─────────────
 *
 * Five writes, and they have to be all five or none. Reading them beside
 * `settleCustomerDue` is the intended way to check this stays correct:
 *
 *   1. the Payment row is marked `cancelled` (never deleted — the receipt is
 *      already in the customer's hand and its number must keep resolving);
 *   2. the fund account gives the money back;
 *   3. `Customer.totalPaid` / `totalDue` move back;
 *   4. each branch row that was reduced is put back by the amount IT took,
 *      from the snapshot taken at collection time;
 *   5. the invoices are re-derived — which needs no reversal logic at all,
 *      because `reallocateCustomerInvoices` recomputes from scratch and the
 *      pool it reads now excludes cancelled rows.
 *
 * ── What it deliberately refuses ─────────────────────────────────────────────
 *
 * Anything that is not a `due_collection`. A checkout leg belongs to its sale
 * and is undone by cancelling the sale; an invoice payment moves `Sale.paid`
 * and `Sale.status` as well, which is a different reversal that this one would
 * get wrong. Refusing loudly is worth more than a void that half works.
 *
 * ── On cancelling an OLD collection ──────────────────────────────────────────
 *
 * Allowed, and deliberately so. A wrong entry is not always caught the same
 * day, and a shopkeeper who cannot fix last week's mistake will fix it by
 * inventing an entry this week instead. Reports key on `paidAt`, so they
 * re-derive correctly; a CLOSED cash register keeps its frozen figures, which
 * is what a settled record is for. The UI warns when the day has passed, and
 * the reason is stored so the difference has an explanation attached.
 *
 * @param {Object} p
 * @param {ObjectId} p.shopId
 * @param {ObjectId} p.userId    who is cancelling
 * @param {ObjectId} p.paymentId
 * @param {string} p.reason      required, and kept
 * @param {Object|null} p.req
 * @param {Object|null} session
 */
async function cancelDueCollection(
  { shopId, userId, paymentId, reason, req = null },
  session = null
) {
  const sessionOpt = session ? { session } : {};

  const note = String(reason || '').trim();
  if (!note) {
    throw new AppError(
      'A reason is required to cancel a collection',
      'বাতিলের কারণ লিখুন',
      400
    );
  }

  // cancelled-inclusive: this read is what REFUSES a second cancellation, so it
  // has to be able to see the first one. Filtering here would make a
  // double-tapped বাতিল look like an unknown payment and reverse the money
  // twice — the exact failure the status check below exists to prevent.
  const payment = await Payment.findOne(
    { _id: paymentId, shop: shopId },
    null,
    sessionOpt
  );
  if (!payment) {
    throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
  }

  if (payment.type !== 'due_collection') {
    throw new AppError(
      'Only due collections can be cancelled here',
      'শুধু বাকি আদায় এখান থেকে বাতিল করা যায়',
      400
    );
  }

  /**
   * Idempotent by refusal rather than by silence.
   *
   * A double-tapped বাতিল button on a slow connection must not reverse the
   * money twice — and a caller who is told "already cancelled" learns something
   * true, whereas a silent success would suggest a second reversal happened.
   */
  if (payment.status === 'cancelled') {
    throw new AppError(
      'This collection is already cancelled',
      'এই আদায়টি আগেই বাতিল করা হয়েছে',
      400
    );
  }

  const customer = await Customer.findOne(
    { _id: payment.customer, shop: shopId },
    null,
    sessionOpt
  );
  if (!customer) {
    throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
  }

  const amount = quantizeMoney(payment.amount || 0);

  // 1 — the row itself. Marked BEFORE the rollups move, so that if anything
  // below throws, the transaction rolls the mark back with it rather than
  // leaving money reversed against a row that still reads as live.
  payment.status = 'cancelled';
  payment.cancelledAt = new Date();
  payment.cancelledBy = userId;
  payment.cancelReason = note;
  await payment.save(sessionOpt);

  // 2 — the money leaves the account it landed in. A no-op for a shop without
  // `features.fundAccounts`, whose rows carry a null account (I-1).
  await paymentAccountService.applyAccountDelta({
    shop: shopId,
    account: payment.account,
    amount: -amount,
    session: session || null,
  });

  // 3 — the shop-wide rollup. Quantized per write, like every other mutation of
  // these two fields, so a customer settled in instalments does not end on a
  // 1e-13 residue that keeps them on the বাকি list forever.
  customer.totalPaid = quantizeMoney((customer.totalPaid || 0) - amount);
  customer.totalDue = quantizeMoney((customer.totalDue || 0) + amount);
  await customer.save(sessionOpt);

  // 4 — each branch row gets back exactly what it gave.
  //
  // From the snapshot, not re-derived: the balances have moved since, and
  // spreading the reversal by today's figures would credit branches that never
  // held this debt while leaving the ones that did permanently overstated.
  const allocation = (payment.branchAllocation || []).filter((a) => a?.branch);
  const toRestore = allocation.length > 0
    ? allocation
    // Legacy rows, and single-branch shops, have no snapshot. The payment's own
    // branch is where the money was taken and — under separate books, which is
    // the only mode where this matters — where `settleCustomerDue` guarantees
    // all of it landed.
    : (payment.branch ? [{ branch: payment.branch, amount }] : []);

  for (const entry of toRestore) {
    const share = quantizeMoney(Number(entry.amount) || 0);
    if (share <= 0) continue;
    await CustomerBalance.applyDelta(
      {
        shop: shopId,
        customer: customer._id,
        branch: entry.branch,
        paid: -share,
        due: share,
      },
      session
    );
  }

  // 5 — the invoices. No reversal logic: this recomputes the whole allocation
  // from a pool that no longer contains the cancelled row, so the invoices this
  // money was holding open simply go back to being open.
  const allocations = await reallocateCustomerInvoices(
    { shopId, customerId: customer._id },
    session
  );

  return { payment, customer, amount, allocations };
}

module.exports = {
  settleCustomerDue,
  readCollectableDue,
  reallocateCustomerInvoices,
  cancelDueCollection,
};

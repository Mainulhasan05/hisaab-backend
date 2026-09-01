/**
 * THE ONE PLACE MONEY REDUCES A SUPPLIER'S PAYABLE.
 *
 * The mirror of `dueSettlement.service` on the buying side, and it exists for
 * the same reason: four screens will eventually want to pay a vendor, and four
 * implementations of "which bills did this settle" is how two books drift apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until now a supplier payment could only be recorded against a PURCHASE
 * document (`purchase.service.recordPayment`). Two consequences, both live:
 *
 *   · **A paper-খাতা payable could never be paid.** `Supplier.openingDue` is
 *     debt with no bill behind it, so there was no document to open and no
 *     amount to type into. The only way the figure ever came down was
 *     `setOpeningDue`, an owner-only CORRECTION that writes no `Payment`, moves
 *     no fund account and touches no till — so a shop that paid ৳50,000 in cash
 *     against old debt either kept a payable it no longer owed, or recorded the
 *     correction and lost the ৳50,000 from its books entirely.
 *
 *   · **A lump sum had to be attributed to one bill.** Handing a vendor ৳50,000
 *     covering six challans meant opening one of them and relying on the
 *     over-payment overflow to find the rest.
 *
 * (SUPPLIER_DUE_ADVANCE_PLAN.md S-2 and S-5.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ALLOCATION RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Oldest debt first, and the oldest debt a shop has is the খাতা it arrived
 * with:
 *
 *     1. `openingDue`      — the carried-in payable
 *     2. open bills        — oldest `date` first, each up to its own `due`
 *
 * Same order the customer pool uses (`reallocateCustomerInvoices` consumes
 * `openingDue` before it walks invoices), and for the same reason: a shop
 * paying down a vendor means the oldest thing outstanding, and carried-in debt
 * predates every bill in the system by definition.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ROWS WHEN IT STRADDLES — the detail everything else depends on
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Money that lands ON a bill is already inside `purchase.paid`, because this
 * service increments it exactly as `recordPayment` does. Money that settles
 * `openingDue` lands on no bill at all.
 *
 * `scripts/recalc-supplier-balances.js` tells the two apart by ONE field: a
 * `Payment` row counts toward `totalPaid` only when it carries no `purchase`.
 * So a payment that straddles the boundary is written as **two rows**:
 *
 *     openingPart -> Payment{ supplier, purchase: null }        counted here
 *     billsPart   -> Payment{ supplier, purchase: <first bill>,
 *                             allocations: [...] }              counted via
 *                                                               purchase.paid
 *
 * One row carrying the whole amount would be counted twice or not at all,
 * depending on which way it was written — reviving the double count fixed on
 * 2026-08-31 one release after it was removed. The contract note lives at
 * `BILL_LESS_SUPPLIER_TYPES` in that script; this is the code it constrains.
 *
 * The pair shares `paidAt`, `method`, `account` and a `receiptGroup`, so the UI
 * can present them as the one event they were.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PAYING PAST THE PAYABLE — অগ্রিম
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Refused unless the caller passes `allowAdvance: true`, and every legacy
 * caller does not — so the ceiling that has always been there is preserved by
 * construction, and only the door built for it (`POST /suppliers/:id/advance`)
 * can create a prepayment.
 *
 * With the flag, the surplus becomes a `supplier_advance` row. The split is the
 * same two-row rule as above, one level out:
 *
 *     amount = settled against debt   -> purchase_payment row(s)
 *            + surplus                -> supplier_advance row
 *
 * A single mixed row would force every report to choose between mislabelling
 * debt settlement or prepayment, forever. Two rows are self-describing and each
 * sums into its own bucket — the same call the customer side made, for the same
 * reason.
 */

const mongoose = require('mongoose');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const paymentAccountService = require('./paymentAccount.service');
const { quantizeMoney } = require('../utils/quantity.util');
const { resolvePaidAt } = require('../utils/paymentDate.util');
const { buildPaymentReceiptNo } = require('../utils/receiptNo.util');
const { PAYMENT_TYPES } = require('../config/constants');

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? quantizeMoney(n) : NaN;
};

/**
 * What this branch's book says is owed to this vendor.
 *
 * Branch-scoped, because that is the figure the screen showed. A multi-branch
 * shop always has one branch active on a write (`requireBranch`), and paying
 * down another branch's payable from here would be the cross-branch write-down
 * `settleCustomerDue` refuses on the customer side.
 */
async function readPayable({ shopId, supplier, branchId }, session = null) {
  if (!branchId) {
    return {
      totalDue: quantizeMoney(supplier.totalDue || 0),
      openingDue: quantizeMoney(supplier.openingDue || 0),
    };
  }

  const row = await SupplierBalance.findOne(
    { shop: shopId, supplier: supplier._id, branch: branchId },
    null,
    session ? { session } : {}
  ).lean();

  return {
    totalDue: quantizeMoney(row?.totalDue || 0),
    openingDue: quantizeMoney(row?.openingDue || 0),
  };
}

/**
 * Pay a supplier, allocating across the carried-in খাতা and then the open bills.
 *
 * @returns {{payments, allocations, openingApplied, billsApplied, supplier}}
 */
async function settleSupplierDue(
  {
    shopId,
    userId,
    supplierId,
    amount: rawAmount,
    branchId = null,
    method = 'cash',
    rawAccount = null,
    paidAt: rawPaidAt = null,
    reference,
    transactionId,
    notes,
    /**
     * Permit the surplus to become a prepayment.
     *
     * `false` for every caller that existed before advances did, so their
     * ceiling is preserved BY CONSTRUCTION rather than by everyone remembering
     * — the same guarantee `settleCustomerDue`'s flag gives on the other side.
     */
    allowAdvance = false,
    req = null,
  },
  session = null
) {
  const sessionOpt = session ? { session } : {};

  const amount = toMoney(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('Payment amount must be greater than 0', 'পরিমাণ ০ এর বেশি হতে হবে', 400);
  }

  const supplier = await Supplier.findOne({ _id: supplierId, shop: shopId }).session(session || null);
  if (!supplier) {
    throw new AppError('Supplier not found', 'সরবরাহকারী পাওয়া যায়নি', 404);
  }

  // Money must not be recorded against a vendor no screen will show. The mirror
  // of the guard `_applyOpeningDue` already carries.
  if (supplier.isActive === false) {
    throw new AppError(
      'Cannot pay a deleted supplier — restore them first',
      'ডিলিট করা সরবরাহকারীকে টাকা দেওয়া যাবে না — আগে ফিরিয়ে আনুন',
      400
    );
  }

  Supplier.backfillTotalPaid(supplier);

  // Backdatable, permission-gated, and refused inside a locked period — the
  // same three rules বাকি আদায় follows, from the same helper.
  const paidAt = resolvePaidAt({
    raw: rawPaidAt, req, shop: req?.shop, label: 'পরিশোধের তারিখ',
  });

  const { totalDue, openingDue } = await readPayable({ shopId, supplier, branchId }, session);

  if (amount > totalDue && !allowAdvance) {
    throw new AppError(
      `Payment exceeds this supplier's outstanding of ৳${totalDue}`,
      totalDue > 0
        ? `সরবরাহকারীর মোট বাকি ৳${totalDue} — এর বেশি দেওয়া যাবে না`
        : 'এই সরবরাহকারীর কোনো বাকি নেই',
      400
    );
  }

  // ── 1. Allocate: debt first, and only what is left becomes অগ্রিম ──────────
  //
  // Debt before prepayment, always. Handing a vendor money while owing them and
  // booking it as a prepayment would leave the shop owing AND in credit with
  // the same party — the one state the exclusivity invariant forbids.
  const againstDebt = quantizeMoney(Math.min(amount, totalDue));
  const advancePart = quantizeMoney(amount - againstDebt);

  const openingApplied = quantizeMoney(Math.min(againstDebt, openingDue));
  let remaining = quantizeMoney(againstDebt - openingApplied);

  const billAllocations = [];
  if (remaining > 0) {
    const bills = await Purchase.find({
      shop: shopId,
      supplier: supplier._id,
      branch: branchId || null,
      status: { $ne: 'cancelled' },
      due: { $gt: 0 },
    })
      .sort({ date: 1, createdAt: 1 })
      .session(session || null);

    for (const bill of bills) {
      if (remaining <= 0) break;
      const take = quantizeMoney(Math.min(remaining, bill.due));
      if (take <= 0) continue;
      billAllocations.push({ doc: bill, amount: take });
      remaining = quantizeMoney(remaining - take);
    }
  }

  // The payable read and the documents disagree. Rather than silently keeping
  // the difference — which is how money goes missing — refuse and say so; the
  // reconciler is the tool for finding out why.
  //
  // Measured against the DEBT portion only: a deliberate prepayment has no bill
  // to land on by definition and must not be mistaken for unallocatable money.
  if (remaining > 0) {
    throw new AppError(
      `Only ৳${quantizeMoney(againstDebt - remaining)} could be allocated — the books disagree with the bills`,
      `৳${quantizeMoney(againstDebt - remaining)} পর্যন্ত বসানো গেল — হিসাব মেলাতে সমস্যা হয়েছে`,
      409
    );
  }

  const account = rawAccount
    ? (await paymentAccountService.assertUsableAccount(shopId, rawAccount, req, method))._id
    : await paymentAccountService.resolveAccountForMethod(req?.shop || { _id: shopId }, method, req);

  // ── 2. Apply the bill slices ───────────────────────────────────────────────
  //
  // `purchase.paid` carries them, exactly as `recordPayment` does, so the
  // pre-save hook re-derives each bill's `due` and status from one place.
  for (const alloc of billAllocations) {
    alloc.doc.paid = quantizeMoney(alloc.doc.paid + alloc.amount);
    await alloc.doc.save(sessionOpt);
  }

  // ── 3. The rows ────────────────────────────────────────────────────────────
  //
  // Grouped so the UI can show one event; split so each half is counted exactly
  // once by the reconciler. See the header.
  const receiptGroup = new mongoose.Types.ObjectId();
  const common = {
    shop: shopId,
    branch: branchId || null,
    supplier: supplier._id,
    method,
    account,
    reference,
    transactionId,
    type: PAYMENT_TYPES.PURCHASE_PAYMENT,
    paidAt,
    receiptGroup,
    notes,
    receivedBy: userId,
  };

  // Ids generated up front so `receiptNo` — which is derived from the row's own
  // `_id` — can be stamped in the same write rather than in a second save. The
  // customer collection does exactly this, for the same reason.
  const rows = [];
  if (openingApplied > 0) {
    // NO `purchase`, deliberately: this is the half the reconciler counts.
    const _id = new mongoose.Types.ObjectId();
    rows.push({
      ...common, _id, amount: openingApplied,
      receiptNo: buildPaymentReceiptNo(_id, paidAt),
    });
  }
  if (billAllocations.length > 0) {
    const _id = new mongoose.Types.ObjectId();
    rows.push({
      ...common,
      _id,
      amount: quantizeMoney(againstDebt - openingApplied),
      purchase: billAllocations[0].doc._id,
      allocations: billAllocations.map((a) => ({ purchase: a.doc._id, amount: a.amount })),
      receiptNo: buildPaymentReceiptNo(_id, paidAt),
    });
  }
  if (advancePart > 0) {
    // Its OWN type, not `purchase_payment`. The two are different economic
    // events — one discharges an obligation, the other creates a claim — and a
    // shopkeeper reading a পরিশোধ figure that silently included prepayments
    // would be told something false about how much debt they had cleared.
    const _id = new mongoose.Types.ObjectId();
    rows.push({
      ...common,
      _id,
      type: PAYMENT_TYPES.SUPPLIER_ADVANCE,
      amount: advancePart,
      receiptNo: buildPaymentReceiptNo(_id, paidAt),
    });
  }

  const payments = await Payment.create(rows, sessionOpt);

  // ── 4. The money, once, for the whole event ────────────────────────────────
  await paymentAccountService.applyAccountDelta({
    shop: shopId,
    account,
    amount: -amount,
    session: session || null,
  });

  // ── 5. Both books ─────────────────────────────────────────────────────────
  supplier.totalPaid = quantizeMoney(supplier.totalPaid + amount);
  Supplier.applyBalances(supplier);
  await supplier.save(sessionOpt);

  await SupplierBalance.applyDelta({
    shop: shopId, supplier: supplier._id, branch: branchId,
    paid: amount, due: -amount,
  }, session);
  await SupplierBalance.recomputeBalances({
    shop: shopId, supplier: supplier._id, branch: branchId,
  }, session);

  /**
   * No `reallocateSupplierAdvance` here, deliberately — the other four money
   * paths call it and this one does not need to.
   *
   * The walk above pays each bill exactly `bill.due`, which is already NET of
   * whatever অগ্রিম that bill is carrying. So a bill's
   * `outstandingBeforeAdvance` falls by precisely what was paid and lands back
   * on its existing `advanceApplied`: the allocation this function would
   * recompute is the allocation that is already there. Adding the call would
   * put a pool aggregate and a full bill scan on the busiest supplier path in
   * the app to discover, every single time, that there was nothing to do.
   *
   * `openingApplied` does not disturb it either — it settles debt that has no
   * bill behind it, so no bill's capacity moves.
   */

  await AuditLog.create([{
    shop: shopId,
    branch: branchId || null,
    user: userId,
    action: 'supplier_payment',
    actionBn: 'সরবরাহকারীকে পরিশোধ',
    description: `Paid ৳${amount} to ${supplier.name}`
      + (openingApplied > 0 ? ` (৳${openingApplied} against carried-in due)` : '')
      + (billAllocations.length > 0 ? ` (${billAllocations.length} bill${billAllocations.length > 1 ? 's' : ''})` : ''),
    descriptionBn: `${supplier.name} কে ৳${amount} পরিশোধ`
      + (openingApplied > 0 ? ` (পূর্বের বাকিতে ৳${openingApplied})` : ''),
    entity: { type: 'supplier', id: supplier._id, name: supplier.name },
    changes: {
      before: { totalDue },
      after: { totalDue: supplier.totalDue, advanceBalance: supplier.advanceBalance },
    },
  }], sessionOpt);

  return {
    supplier,
    payments,
    openingApplied,
    billsApplied: quantizeMoney(againstDebt - openingApplied),
    advanceApplied: advancePart,
    // Invoice numbers included so the UI can say "PUR… এ ৳X বসেছে" with no
    // second fetch — the same shape `recordPayment` returns.
    allocations: billAllocations.map((a) => ({
      purchase: a.doc._id, invoiceNo: a.doc.invoiceNo, amount: a.amount,
    })),
  };
}

/**
 * Void a supplier payment, putting every book back exactly as it was.
 *
 * ── Why this had to ship beside the door, not after it ──────────────────────
 *
 * `cancelPurchase` voids the payments attached to a bill, but there was no way
 * to reverse a payment on its own — `PURCHASE_PLAN` Phase 7 noted the gap and
 * left it. A standalone payment has no bill to cancel, so without this a
 * mis-keyed ৳50,000 would be permanent: the only correction available would be
 * an owner-only `setOpeningDue` adjustment, which moves the debt while leaving
 * the cash gone. That is the very failure this whole phase exists to end.
 */
async function voidSupplierPayment(
  { shopId, userId, paymentId, reason, req = null },
  session = null
) {
  const sessionOpt = session ? { session } : {};

  const note = String(reason || '').trim();
  if (!note) {
    throw new AppError('A reason is required to void a payment', 'বাতিলের কারণ লিখুন', 400);
  }

  // cancelled-inclusive: this read is what REFUSES a second void, so it has to
  // be able to see the first one.
  const payment = await Payment.findOne({ _id: paymentId, shop: shopId }, null, sessionOpt);
  if (!payment) {
    throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
  }
  // Both kinds of money going out to a vendor. An advance especially needs
  // this door: `deleteSupplier` refuses to remove a vendor holding our money,
  // so without a way to reverse a mis-keyed one the account could never be
  // closed at all.
  const VOIDABLE = [PAYMENT_TYPES.PURCHASE_PAYMENT, PAYMENT_TYPES.SUPPLIER_ADVANCE];
  if (!VOIDABLE.includes(payment.type)) {
    throw new AppError(
      'Only supplier payments can be voided here',
      'শুধু সরবরাহকারীর পেমেন্ট এখান থেকে বাতিল করা যায়',
      400
    );
  }
  if (payment.status === 'cancelled') {
    throw new AppError(
      'This payment is already voided',
      'এই পেমেন্টটি আগেই বাতিল করা হয়েছে',
      400
    );
  }

  const amount = quantizeMoney(payment.amount || 0);
  // Which challans the vendor's remaining অগ্রিম re-spread onto once this row
  // stopped counting. Empty for every vendor nobody has prepaid.
  let reallocated = [];

  /**
   * Which bills this money landed on, and how much each took.
   *
   * `allocations` is the authority when present. A plain single-bill payment
   * carries none — legacy rows are byte-identical to what they always were —
   * so the primary `purchase` takes the whole amount. A row with neither
   * settled the carried-in খাতা and touches no bill at all.
   */
  const slices = (payment.allocations || []).length > 0
    ? payment.allocations.map((a) => ({ purchase: a.purchase, amount: quantizeMoney(a.amount || 0) }))
    : (payment.purchase ? [{ purchase: payment.purchase, amount }] : []);

  for (const slice of slices) {
    const bill = await Purchase.findOne({ _id: slice.purchase, shop: shopId }, null, sessionOpt);
    if (!bill) continue;
    // A cancelled bill already unwound its own payments; taking the money off
    // again would double-reverse it.
    if (bill.status === 'cancelled') {
      throw new AppError(
        'This payment belongs to a cancelled purchase and was already reversed',
        'এই পেমেন্টের ক্রয়টি বাতিল করা হয়েছে — টাকা আগেই ফেরত হয়েছে',
        400
      );
    }
    bill.paid = Math.max(0, quantizeMoney(bill.paid - slice.amount));
    await bill.save(sessionOpt);
  }

  // Marked before the rollups move, so a throw below rolls the mark back with
  // it rather than leaving money reversed against a row that still reads live.
  payment.status = 'cancelled';
  payment.cancelledAt = new Date();
  payment.cancelledBy = userId;
  payment.cancelReason = note;
  await payment.save(sessionOpt);

  await paymentAccountService.applyAccountDelta({
    shop: shopId,
    account: payment.account,
    amount,
    session: session || null,
  });

  const supplierId = payment.supplier
    || (slices.length > 0
      ? (await Purchase.findOne({ _id: slices[0].purchase, shop: shopId }, 'supplier', sessionOpt).lean())?.supplier
      : null);

  if (supplierId) {
    const supplier = await Supplier.findOne({ _id: supplierId, shop: shopId }).session(session || null);
    if (supplier) {
      Supplier.backfillTotalPaid(supplier);
      supplier.totalPaid = Math.max(0, quantizeMoney(supplier.totalPaid - amount));
      Supplier.applyBalances(supplier);
      await supplier.save(sessionOpt);
    }

    await SupplierBalance.applyDelta({
      shop: shopId, supplier: supplierId, branch: payment.branch,
      paid: -amount, due: amount,
    }, session);
    await SupplierBalance.recomputeBalances({
      shop: shopId, supplier: supplierId, branch: payment.branch,
    }, session);

    /**
     * ── And the bills the voided money was covering ─────────────────────────
     *
     * The three writes above put the VENDOR position back. They cannot put the
     * bills back, and for an advance there is nothing above that even tries:
     * the `slices` loop is the only thing that touches a challan, and an
     * advance row carries neither `allocations` nor a `purchase`, so it walks
     * zero bills.
     *
     * Left there, voiding a ৳1,00,000 prepayment re-raised the vendor's payable
     * to ৳55,200 while the two challans holding that debt stayed at `due: 0,
     * status: 'completed'` — money owed that no screen would ever show and that
     * nobody could pay without editing the database. See
     * `reallocateSupplierAdvance`'s header.
     *
     * Run for a voided PURCHASE_PAYMENT too, not only an advance. That path
     * does put its own slices back, and it needs this as well: returning
     * ৳20,000 of room to a bill means the vendor's remaining prepayment can now
     * sit on it, and the recompute is what discovers that. Idempotent, so on
     * the overwhelming majority of voids — a vendor who has never been paid
     * ahead — it is one indexed aggregate that finds an empty pool and returns.
     */
    reallocated = await reallocateSupplierAdvance(
      { shopId, supplierId, branchId: payment.branch || null },
      session
    );
  }

  await AuditLog.create([{
    shop: shopId,
    branch: payment.branch || null,
    user: userId,
    action: 'supplier_payment_void',
    actionBn: 'সরবরাহকারীর পেমেন্ট বাতিল',
    description: `Voided supplier payment of ৳${amount}: ${note}`,
    descriptionBn: `সরবরাহকারীর ৳${amount} পেমেন্ট বাতিল: ${note}`,
    entity: { type: 'payment', id: payment._id, name: payment.receiptNo || String(payment._id) },
  }], sessionOpt);

  return { payment, reversed: amount, bills: slices.length, reallocated };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SPREAD অগ্রিম BACK OVER THE BILLS IT IS SUPPOSED TO BE PAYING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Purchase.advanceApplied` is the fourth term in a bill's `due`. Until this
 * function existed it was written in exactly ONE place — `createPurchase`, at
 * the moment the bill was raised — and never looked at again. That is the same
 * mistake `reallocateCustomerInvoices` was written to avoid, and its header
 * says why in one line: an ALLOCATION IS NOT AN EVENT. Both sides of it keep
 * moving afterwards.
 *
 * ── What it cost ────────────────────────────────────────────────────────────
 *
 * A vendor holding ৳1,00,000 of the shop's money delivers ৳35,200 and then
 * ৳20,000 of goods. Both bills are covered by the prepayment, so both read
 * `due: 0, status: 'completed'`. The owner then discovers the advance was keyed
 * against the wrong vendor and voids it. `voidSupplierPayment` correctly
 * re-raises `Supplier.totalDue` to ৳55,200 — and touches no bill, because an
 * advance row carries neither `allocations` nor a `purchase`. So the vendor
 * position says ৳55,200 is owed while `Σ Purchase.due` says ৳0, and the two
 * bills that hold the debt are marked COMPLETED, which is the part that makes
 * it unrecoverable by hand: nobody will ever open them to pay.
 *
 * Cancelling a bill that consumed অগ্রিম frees the same money and strands it
 * the same way. SUPPLIER_DUE_ADVANCE_PLAN.md P5 predicted both — "Phase G owes
 * the other half: an advance must be CONSUMED against open bills, or ageing
 * will show bills as due while the vendor position says nothing is owed".
 *
 * ── Why a recompute and not a delta ─────────────────────────────────────────
 *
 * Four things move the pool or the bills after an allocation is made: the
 * advance is voided, a bill is cancelled, a কেনা ফেরত shrinks what a bill can
 * absorb, a payment settles part of one directly. Four reversals would each
 * need to get their own arithmetic right, they would drift, and the drift would
 * be invisible — the exact shape of the bug being fixed. So this derives the
 * whole allocation from scratch every time and discards whatever was there.
 * Idempotent, safe to call from anywhere, and self-healing: a bill stranded by
 * a void before this shipped repairs itself the next time anything touches the
 * vendor.
 *
 * ── The pool is the GROSS advance, not `Supplier.advanceBalance` ────────────
 *
 * `advanceBalance` is `max(0, totalPaid − totalAmount − openingDue)` — what is
 * LEFT after the bills consumed their share. Spreading that over the bills
 * again would credit them twice. The pool is every live `supplier_advance` row,
 * and what the bills cannot absorb is precisely what `advanceBalance` reports.
 * The two then agree by construction rather than by maintenance, which is the
 * relationship the customer pool already has with `Customer.advanceBalance`.
 *
 * ── Branch ──────────────────────────────────────────────────────────────────
 *
 * Both halves scoped to one branch, matching `settleSupplierDue`, which already
 * walks only `branch: branchId || null` bills. Supplier money is partitioned
 * that way throughout — a payment made at Dhaka may not write down
 * Chittagong's payable — and an advance is a payment made early.
 * `createPurchase` used to read the SHOP-WIDE `supplier.advanceBalance` to
 * decide what a branch's bill could consume; that is the inconsistency, not the
 * rule. A no-op distinction for single-branch shops, where every row carries
 * `branch: null` (I-1).
 *
 * ── What is deliberately NOT allocated ──────────────────────────────────────
 *
 * `openingDue` — the pre-software খাতা figure — has no bill behind it, so
 * anything the open bills cannot absorb simply stays unallocated and goes on
 * reporting as `advanceBalance`. The same call `reallocateCustomerInvoices`
 * makes, for the same reason: `Supplier.deriveDue` already carries the opening
 * term, and inventing a bill to hang it on would be worse than leaving it be.
 *
 * @param {Object} p
 * @param {ObjectId} p.shopId
 * @param {ObjectId} p.supplierId
 * @param {ObjectId|null} [p.branchId]
 * @param {Object|null} session
 * @returns {Promise<Array<{purchase, invoiceNo, applied, dueBefore, dueAfter, cleared}>>}
 *   only the bills whose allocation CHANGED — the list a caller can show as
 *   "এই অগ্রিম কোন চালানে বসেছে".
 */
async function reallocateSupplierAdvance(
  { shopId, supplierId, branchId = null },
  session = null
) {
  if (!supplierId) return [];

  const sessionOpt = session ? { session } : {};
  const branchMatch = branchId ? new mongoose.Types.ObjectId(String(branchId)) : null;

  /**
   * The pool, FIRST and deliberately.
   *
   * This runs on every purchase, every cancellation, every void and every কেনা
   * ফেরত, and for the overwhelming majority of vendors — anyone who has never
   * been paid ahead — the answer is "nothing to allocate". Served straight off
   * `{shop, supplier}`, so the common case costs one indexed aggregate and
   * stops: no bill scan and no writes.
   */
  const [pool] = await Payment.aggregate(
    [
      {
        $match: {
          shop: new mongoose.Types.ObjectId(String(shopId)),
          supplier: new mongoose.Types.ObjectId(String(supplierId)),
          branch: branchMatch,
          type: PAYMENT_TYPES.SUPPLIER_ADVANCE,
          // A voided advance is not money the vendor is holding, so it must not
          // pay down a bill. `$ne` rather than `status: 'active'`: rows written
          // before the field existed carry no `status` at all, and an equality
          // test would exclude every one of them — emptying the pool and
          // un-allocating every prepayment ever made.
          status: { $ne: 'cancelled' },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ],
    sessionOpt
  );

  let remaining = quantizeMoney(pool?.total || 0);

  /**
   * Every live bill, INCLUDING the ones with nothing left to absorb.
   *
   * Not `due: { $gt: 0 }`, which is what the debt-first walk in
   * `settleSupplierDue` filters on — and reusing that filter here is the whole
   * trap. A bill that a now-voided advance had driven to `due: 0` is exactly
   * the bill that has to be found and reset; skipping it would leave the stale
   * `advanceApplied` sitting on the one document this function exists to
   * correct.
   *
   * Oldest first, on `date` then `createdAt` — the order `settleSupplierDue`
   * uses, and what a shopkeeper means by "পুরোনো বাকি আগে শোধ". `date` is the
   * backdatable business date every purchase reader filters on, so a bill
   * entered late still queues on the day it happened.
   */
  const bills = await Purchase.find({
    shop: shopId,
    supplier: supplierId,
    branch: branchId || null,
    status: { $ne: 'cancelled' },
  })
    .sort({ date: 1, createdAt: 1 })
    .session(session || null);

  // Nothing in the pool and no bill carrying a stale share: the common path
  // leaves without a single write.
  if (remaining <= 0 && !bills.some((b) => (b.advanceApplied || 0) > 0)) return [];

  const changed = [];

  for (const bill of bills) {
    // The SAME ceiling the `due` hook clamps to — see that static's note.
    // Asking it here rather than repeating the arithmetic is what guarantees
    // the amount this function decides is the amount the bill actually credits.
    const capacity = Purchase.outstandingBeforeAdvance(bill);
    const take = quantizeMoney(Math.min(Math.max(0, remaining), capacity));
    const before = quantizeMoney(bill.advanceApplied || 0);

    remaining = quantizeMoney(remaining - take);
    if (take === before) continue;

    const dueBefore = quantizeMoney(bill.due || 0);
    bill.advanceApplied = take;
    // `save()`, not `updateOne`: `due` and `status` are derived by the pre-save
    // hook from this field among four, and patching them here by hand is how
    // the two would come to disagree. Same reason `recordPayment` re-reads and
    // saves rather than writing `due` itself.
    await bill.save(sessionOpt);

    changed.push({
      purchase: bill._id,
      invoiceNo: bill.invoiceNo,
      applied: take,
      dueBefore,
      dueAfter: quantizeMoney(bill.due || 0),
      cleared: (bill.due || 0) <= 0,
    });
  }

  return changed;
}

module.exports = {
  settleSupplierDue,
  voidSupplierPayment,
  readPayable,
  reallocateSupplierAdvance,
};

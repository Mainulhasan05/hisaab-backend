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
 * NO ADVANCE YET
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Paying past the supplier's total payable is refused, naming the maximum.
 * `Supplier.advanceBalance` exists and every surface is wired for it (Phase D),
 * but the DOOR is Phase G — and opening it here by accident would create a
 * prepayment with no screen to see it on and no way to refund it.
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

  if (amount > totalDue) {
    throw new AppError(
      `Payment exceeds this supplier's outstanding of ৳${totalDue}`,
      totalDue > 0
        ? `সরবরাহকারীর মোট বাকি ৳${totalDue} — এর বেশি দেওয়া যাবে না`
        : 'এই সরবরাহকারীর কোনো বাকি নেই',
      400
    );
  }

  // ── 1. Allocate: carried-in খাতা first, then the bills oldest first ────────
  const openingApplied = quantizeMoney(Math.min(amount, openingDue));
  let remaining = quantizeMoney(amount - openingApplied);

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
  if (remaining > 0) {
    throw new AppError(
      `Only ৳${quantizeMoney(amount - remaining)} could be allocated — the books disagree with the bills`,
      `৳${quantizeMoney(amount - remaining)} পর্যন্ত বসানো গেল — হিসাব মেলাতে সমস্যা হয়েছে`,
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
      amount: quantizeMoney(amount - openingApplied),
      purchase: billAllocations[0].doc._id,
      allocations: billAllocations.map((a) => ({ purchase: a.doc._id, amount: a.amount })),
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
    billsApplied: quantizeMoney(amount - openingApplied),
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
  if (payment.type !== PAYMENT_TYPES.PURCHASE_PAYMENT) {
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

  return { payment, reversed: amount, bills: slices.length };
}

module.exports = { settleSupplierDue, voidSupplierPayment, readPayable };

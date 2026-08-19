const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const { AppError } = require('../middleware/error.middleware');
const paymentAccountService = require('./paymentAccount.service');
const { toMoney } = require('../utils/invoiceMath.util');
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

  return {
    payment,
    amount,
    dueBefore: quantizeMoney(dueBefore),
    dueAfter: quantizeMoney(dueBefore - amount),
  };
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

module.exports = { settleCustomerDue, readCollectableDue };

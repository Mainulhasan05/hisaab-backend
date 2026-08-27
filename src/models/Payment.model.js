const mongoose = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_TYPES } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { getBangladeshDayRange, toBangladeshDateStr } = require('../utils/bdTime.util');
const { paidAtMatch } = require('../utils/paymentDate.util');

const paymentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  /**
   * The invoice this collection was taken DURING — not the one it settles.
   *
   * ── Why this is not `sale` ────────────────────────────────────────────────
   *
   * A customer carrying ৳2,200 on the খাতা buys ৳500 of goods and hands over
   * ৳2,700. That is two money events in one visit: a ৳500 sale, and a ৳2,200
   * collection against invoices that are already closed. `sale` means "this
   * money settles THIS invoice", and this money does not — it settles older
   * ones, allocated oldest-first by `CustomerBalance.settleDue` exactly as a
   * walk-in বাকি আদায় is.
   *
   * Writing the checkout invoice into `sale` instead would be wrong in three
   * places at once, and only one of them is cosmetic:
   *
   *   1. `reviseBlockedReason` refuses to revise any invoice carrying a
   *      `Payment{sale, atCheckout: false}` — its definition of "money arrived
   *      after checkout". Every settle-at-checkout invoice would become
   *      unrevisable seconds after it was rung up.
   *   2. `cancelSale`'s guards read `Payment{sale}` to decide what a
   *      cancellation is allowed to touch.
   *   3. The invoice's own payment history would show ৳2,700 against a ৳500
   *      bill.
   *
   * `atCheckout` deliberately stays FALSE on these rows. That flag means
   * "already counted inside `Sale.payments[]`", and this money is not in there
   * — the legs carry the ৳500 only. False is what makes the cash register
   * count the ৳2,200 into the drawer, which is where it physically is.
   *
   * Null on every ordinary collection and on every row written before this
   * field existed, so nothing may read it without falling back.
   */
  viaSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    default: null
  },
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase'
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  amount: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.01, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  method: {
    type: String,
    enum: {
      values: Object.values(PAYMENT_METHODS),
      message: 'অবৈধ পেমেন্ট পদ্ধতি'
    },
    default: PAYMENT_METHODS.CASH
  },
  type: {
    type: String,
    enum: {
      values: Object.values(PAYMENT_TYPES),
      message: 'অবৈধ পেমেন্ট ধরন'
    },
    default: PAYMENT_TYPES.SALE_PAYMENT
  },
  /**
   * Was this row written by `createSale` as the checkout leg?
   *
   * ── Why a flag and not an inference ────────────────────────────────────────
   *
   * Checkout money is recorded TWICE by design: once inside `Sale.payments[]`
   * (which is what makes split payments legible) and once as a `Payment` row
   * (which is what makes the invoice's payment history complete). Both are
   * wanted. What was missing was any way to tell the two apart afterwards —
   * `type` is `sale_payment` either way and `sale` is set either way.
   *
   * `cashRegister._calculateCashFlows` reads both: it sums the cash legs of
   * every sale, AND sums every cash `Payment{type:'sale_payment'}`. So every
   * cash checkout was counted twice and the till's expected closing ran over by
   * the day's takings — the drawer appeared short by exactly the money in it.
   * The comment there asserted the two streams were disjoint; they never were.
   *
   * With the flag they are: `true` means "already counted in `Sale.payments[]`",
   * `false` means money that arrived later (`recordPayment`, `collectDuePayment`)
   * and is counted only here.
   *
   * Rows written before this field existed read `false` and would be
   * double-counted, so `scripts/backfill-payment-at-checkout.js` stamps them.
   * Only OPEN registers recalculate, so in practice that is same-day rows —
   * closed registers are settled records and are deliberately left alone.
   */
  atCheckout: {
    type: Boolean,
    default: false
  },
  /**
   * When the money actually changed hands.
   *
   * `createdAt` answers "when was this typed in", which is an audit question
   * and stays exactly that. This answers "which day's books does it belong
   * to", which is the reporting question — and until this field existed the
   * two were forced to be the same answer.
   *
   * They routinely are not. A customer pays at the counter on Saturday; the
   * entry gets made on Monday when someone next has the phone. Saturday's
   * collection total read short, Monday's read over, and there was no way to
   * record what really happened. `Expense.date` and `Purchase.date` have
   * always allowed this; `Payment` was the odd one out.
   *
   * Defaulted, so nothing that does not care has to pass it. Every date-ranged
   * reader goes through `paymentDate.util` — rows written before this field
   * existed have no value here and must still be found by their `createdAt`,
   * which for them is the same day anyway.
   */
  paidAt: {
    type: Date,
    default: Date.now
  },
  /**
   * Which PaymentAccount this money moved through.
   *
   * `method` says HOW (`bkash`); this says WHERE (which bKash number). The two
   * are not redundant — a shop can hold three accounts answering to one method,
   * which is the entire reason fund accounts exist.
   *
   * Null for every row written before this field existed and for every shop
   * without `features.fundAccounts`. `applyAccountDelta` treats a null account
   * as a no-op, so those rows cost nothing and break nothing.
   */
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    default: null
  },
  transactionId: {
    type: String,
    trim: true
  },
  reference: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  /**
   * ── The receipt the customer walks away with ───────────────────────────────
   *
   * রসিদ নং, set only on rows that produce a printable money receipt — today
   * that is `due_collection` (বাকি আদায়) and `sale_payment` collected after
   * the fact. A checkout leg (`atCheckout: true`) gets none: the INVOICE is
   * already that customer's receipt, and handing them a second numbered slip
   * for the same money is how a khata ends up counted twice.
   *
   * Empty on every row written before this field existed. That is not a gap to
   * backfill — a receipt number is only meaningful if a piece of paper carrying
   * it exists, and for historical rows none does. `receiptNoFor()` in
   * `dueSettlement.service` is where new ones are minted; see
   * `utils/receiptNo.util.js` for why it is derived rather than counted.
   */
  receiptNo: {
    type: String,
    trim: true
    // NO `default`. The unique index below is sparse, and sparse skips MISSING
    // values — not empty ones. A `default: ''` would index every receipt-less
    // row under the same key and the second one written would fail E11000.
  },
  /**
   * ── What the customer owed, immediately before and immediately after ───────
   *
   * A snapshot, deliberately, and the reason is the same one `Sale.previousDue`
   * documents: a receipt describes ONE transaction at ONE moment. Recomputing
   * "current due" when the receipt is re-printed next week would put a figure
   * on the reprint that the original slip never said, and the customer holding
   * both would be right to think the shop's books move on their own.
   *
   * It is also what the SMS quotes. Reading the balance live for that message
   * was a race the app lost regularly — the send is dispatched from inside the
   * settlement transaction, so a live read could land before the commit and
   * text the customer the balance they had BEFORE paying. See
   * `sendPaymentReceiptAsync`.
   *
   * ── Which book these figures are from ──────────────────────────────────────
   *
   * Whichever one the collection was validated against. Under separate branch
   * books that is the BRANCH balance, because a branch may only collect against
   * its own receivable (`settleCustomerDue` refuses anything larger) and the
   * customer standing at that counter is being handed that branch's account.
   * Under shared books there is one balance and this is it.
   *
   * `null` — not 0 — on rows written before this existed and on any path that
   * did not compute them, so a reader can tell "cleared" from "unknown".
   */
  dueBefore: {
    type: Number,
    default: null
  },
  dueAfter: {
    type: Number,
    default: null
  },
  /**
   * ── Which branches' books this collection actually reduced ────────────────
   *
   * `CustomerBalance.settleDue` spreads a khata collection across the branches
   * that hold the debt — collecting branch first, then oldest — and returns
   * exactly what it applied. That return value used to be discarded.
   *
   * It is kept now because CANCELLING a collection has to put the money back
   * where it came from, and there is no way to work that out afterwards: the
   * balances have moved on, other collections have landed, and re-deriving the
   * split would reverse a different allocation from the one that happened. A
   * reversal that guesses is how one branch ends up permanently overstated and
   * another permanently short.
   *
   * Empty on rows written before this existed, and on shops with no branch
   * rows at all. `cancelDueCollection` falls back to the payment's own branch
   * there, which is where a single-branch shop's money was always going.
   */
  branchAllocation: {
    type: [
      {
        _id: false,
        branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
        amount: { type: Number, default: 0 },
      },
    ],
    default: () => [],
  },
  /**
   * ── Which purchases this supplier payment actually settled ────────────────
   *
   * The purchase-side mirror of `branchAllocation` above, and kept for the same
   * reason: an allocation cannot be reconstructed afterwards, because every
   * bill's `paid` keeps moving on its own.
   *
   * A supplier payment may exceed the bill it was recorded against (F-4): the
   * `purchase` this row names absorbs up to its own due, and the excess settles
   * the same shop+supplier+branch's older bills, oldest first. Each entry is one
   * bill's slice; Σ amount === this row's `amount`.
   *
   * Populated ONLY when the money reached beyond the named purchase. A plain
   * one-bill payment stores `[]` and reads exactly as every row before this
   * field existed. `cancelPurchase` reads it to refuse cancelling a bill whose
   * money is entangled with other bills' — see the multi-bill note there.
   */
  allocations: {
    type: [
      {
        _id: false,
        purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
        amount: { type: Number, default: 0 },
      },
    ],
    default: () => [],
  },
  /**
   * ═════════════════════════════════════════════════════════════════════════
   * VOIDING A ROW THAT SHOULD NEVER HAVE EXISTED
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `immutableGuard` has refused to delete a Payment since the day it was
   * written, and the error it raises says "Use void/cancel instead." Nothing
   * ever built the void. So a বাকি আদায় keyed against the wrong customer, or
   * for ৳20,000 instead of ৳2,000, was permanent: the shop's books, the
   * customer's খাতা and the day's cash were all wrong and there was no
   * operation in the system that could put them right.
   *
   * ── Why a status and not a deletion, and not a negative row ───────────────
   *
   * Not a deletion, because the receipt is already in the customer's hand. A
   * number they can read has to keep resolving to something, and what it must
   * resolve to is "বাতিল" — not "not found", which is indistinguishable from
   * the shop losing the record.
   *
   * Not a reversing row with a negative amount either, tempting as it is: it
   * would make every `$sum: '$amount'` net out for free. But `amount` carries
   * `min: 0.01` precisely because a negative payment runs the whole ledger
   * backwards (see `settleCustomerDue`), and every reader that COUNTS rows
   * rather than summing them would report two collections where there was one.
   * `PlatformPayment.reversalOf` takes that shape and can afford to — it has a
   * handful of readers. This model has fourteen.
   *
   * ── The one thing to get right when adding a reader ───────────────────────
   *
   * Filter `status: { $ne: 'cancelled' }`, NEVER `status: 'active'`. Every row
   * written before this field existed has no `status` at all, and `$ne` matches
   * a missing field while an equality test does not — so the equality version
   * silently reports every shop's historical takings as zero. That is also why
   * there is no migration to run: the absence of the field IS "active".
   *
   * `src/tests/paymentCancellation.test.js` scans the services for a reader
   * that forgot.
   */
  status: {
    type: String,
    enum: {
      values: ['active', 'cancelled'],
      message: 'অবৈধ পেমেন্ট স্ট্যাটাস'
    },
    default: 'active'
  },
  cancelledAt: {
    type: Date,
    default: null
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  /**
   * Required by the service, not by the schema.
   *
   * A void moves real money back and manufactures debt against a customer who
   * believes they have paid. "Why?" is the first question anyone auditing this
   * will ask, and the answer has to have been captured at the moment it was
   * still known. The schema stays permissive so a legacy row is not made
   * invalid retroactively; `cancelDueCollection` refuses an empty one.
   */
  cancelReason: {
    type: String,
    trim: true,
    maxlength: [300, 'কারণ ৩০০ অক্ষরের বেশি হতে পারবে না'],
    default: ''
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
paymentSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch
paymentSchema.index({ shop: 1, branch: 1, paidAt: -1 }); // Date-ranged reads (cash register, reports) on the effective date
paymentSchema.index({ shop: 1, customer: 1, createdAt: -1 }); // Customer payment history
paymentSchema.index({ shop: 1, sale: 1 }); // Sale payments lookup
// "Was a due settled at this checkout?" — asked one sale at a time by the sale
// detail page and the invoice footer. Sparse: null on every row but the few
// that actually rode along with a sale.
paymentSchema.index({ shop: 1, viaSale: 1 }, { sparse: true });
paymentSchema.index({ shop: 1, purchase: 1 }, { sparse: true }); // Purchase payments
paymentSchema.index({ type: 1, createdAt: -1 }); // Admin subscription-payment queries (no shop predicate)
// Looking a receipt up by the number printed on it — the counter's "এই রসিদটা
// কোনটা?" question. Unique so a derived number that somehow repeated is caught
// here rather than discovered by two customers holding the same slip.
//
// PARTIAL, not sparse. `sparse` skips a document only when EVERY indexed field
// is missing, and `shop` is always present — so on this compound key a sparse
// index still enrols every receipt-less payment under `receiptNo: null`, and
// the second one in a shop fails E11000. That is exactly why this index could
// not be built against real data until 2026-08-27. The partial filter indexes
// only the rows that actually carry a number, which is what "sparse" was
// reaching for.
paymentSchema.index(
  { shop: 1, receiptNo: 1 },
  { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } }
);
// The রসিদ register: "every collection this shop has taken, newest first",
// with the cancelled ones filtered out or called out. Compound on status so the
// common listing is served straight from the index rather than by fetching
// cancelled rows and discarding them.
paymentSchema.index({ shop: 1, type: 1, status: 1, paidAt: -1 });

// Virtual: Is refund
paymentSchema.virtual('isRefund').get(function() {
  return this.type === PAYMENT_TYPES.REFUND;
});

// Static: Get payments summary
paymentSchema.statics.getPaymentsSummary = async function(shopId, startDate, endDate) {
  // Bucketed on the effective date, so a backdated বাকি আদায় lands in the
  // period it was actually collected in rather than the one it was typed in.
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    ...paidAtMatch({ $gte: startDate, $lte: endDate })
  };

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$method',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  // Also get by type
  const byType = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return {
    byMethod: summary,
    byType: byType,
    grandTotal: summary.reduce((sum, s) => sum + s.total, 0)
  };
};

// Static: Get customer payments
paymentSchema.statics.getCustomerPayments = function(shopId, customerId, options = {}) {
  const { page = 1, limit = 20 } = options;

  return this.find({
    shop: shopId,
    customer: customerId
  })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sale', 'invoiceNo total')
    .populate('receivedBy', 'name');
};

// Static: Get daily collection
paymentSchema.statics.getDailyCollection = async function(shopId, date) {
  // The Bangladesh calendar day containing `date`. Server-local `setHours`
  // made "daily collection" a UTC day, six hours out of step with every other
  // daily figure in the app.
  const { startOfDay, endOfDay } = getBangladeshDayRange(toBangladeshDateStr(date));

  const collection = await this.aggregate([
    {
      $match: {
        shop: new mongoose.Types.ObjectId(shopId),
        ...paidAtMatch({ $gte: startOfDay, $lte: endOfDay })
      }
    },
    {
      $group: {
        _id: '$method',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  const total = collection.reduce((sum, c) => sum + c.total, 0);

  return {
    date: startOfDay,
    byMethod: collection,
    total
  };
};

// Apply immutable ledger guard
paymentSchema.plugin(immutableGuard, { modelName: 'Payment' });

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;

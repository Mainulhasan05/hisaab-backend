const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { PAYMENT_METHODS } = require('../config/constants');

/**
 * কেনা ফেরত — goods going BACK to the supplier (RTV).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MIRROR OF `SalesReturn`, POINTED THE OTHER WAY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read `SalesReturn.model.js` first — the shape, the numbering, the
 * `refundStatus` machinery and the immutability argument are all the same and
 * are written up there. What follows is only where the purchase side differs.
 *
 * ── Two prices per line, and they mean different things (D-1) ────────────────
 *
 *     unitPrice        what the supplier BILLED. The refund is computed from
 *                      this, because the supplier credits the paper.
 *     landedUnitPrice  what the goods COST once this delivery's ভাড়া and
 *                      discount were folded in. The STOCK LEDGER is written
 *                      from this, because that is what the shelf loses.
 *
 * The freight slice of returned goods is accepted as sunk cost — the truck
 * really did drive. Substituting either number for the other is the single
 * easiest way to make this feature wrong, which is why both are snapshotted on
 * the line rather than either being re-derived.
 *
 * ── No `taxRefund`, no combos ────────────────────────────────────────────────
 *
 * Purchases carry no VAT in this app (`Purchase` has no tax field at all), so
 * there is no tax leg to give back — `totalAmount` IS the whole supplier
 * credit, unlike `SalesReturn` where it is merchandise only. And a combo is
 * never bought (`assertNotCombo` refuses it at entry), so no component
 * scaffolding is needed here.
 *
 * ── No cancel, by design ─────────────────────────────────────────────────────
 *
 * Same call the sale side makes: a return is a ledger row, not a draft. It has
 * already decremented stock, moved batches and moved the supplier's খাতা, none
 * of it re-derivable from this document alone. `immutableGuard` at the foot,
 * and no route offers a void.
 */

const purchaseReturnItemSchema = new mongoose.Schema({
  // Anchored to a purchase LINE, not merely to a product. Two lines of the same
  // product in one delivery can carry different rates, different batches and
  // different expiry dates, and "which of the two came back" is not a question
  // the product id can answer.
  purchaseItemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  productCode: {
    type: String
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId
  },
  variantLabel: {
    type: String
  },
  // 0-exclusive rather than `min: 1` — fractional units (kg / litre / yard).
  // The flag-and-unit-aware refusal lives in `parseQuantity`; schema bounds are
  // the floor, not the policy. See AGENT_WORKFLOW.md I-6.
  quantity: {
    type: Number,
    required: [true, 'ফেরতের পরিমাণ দিন'],
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  // Snapshots off the purchase line, for display. `quantity` above is always in
  // the BASE unit — the pack is a record of how the delivery was written down,
  // never a second quantity to reconcile (AGENT_WORKFLOW.md §13.1).
  unit: {
    type: String
  },
  packSize: {
    type: Number,
    min: [0.001, 'প্রতি মোড়কে পরিমাণ ০ এর বেশি হতে হবে']
  },
  // BILLED, per base unit — what the supplier's paper says. See the header.
  unitPrice: {
    type: Number,
    required: true
  },
  // This return's proportional slice of the line's own concession and of the
  // invoice-level discount, largest-remainder settled by `purchaseMath._prorate`
  // so a FULL return gives back exactly what the bill knocked off — not a
  // rounded approximation of it.
  lineDiscountShare: {
    type: Number,
    default: 0
  },
  discountShare: {
    type: Number,
    default: 0
  },
  // What the stock ledger loses per unit — landed, never refunded (D-1).
  landedUnitPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // The billed net credit for this line: quantity × unitPrice − the two shares.
  total: {
    type: Number,
    required: true
  },
  // What went back, batch-wise. Snapshotted off the purchase line the same way
  // `Purchase.items[].batchNumber` is: editing the product's batches later must
  // not rewrite what this return said left the shop.
  batchNumber: {
    type: String,
    trim: true
  },
  expiryDate: {
    type: Date
  },
  reason: {
    type: String,
    trim: true
  }
}, { _id: true });

const purchaseReturnSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  // Copied from the purchase, never from the caller: the goods came into a
  // branch and they leave from that branch. An owner in All Branches has no
  // active branch and must still be able to record the return.
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  returnNo: {
    type: String,
    required: [true, 'রিটার্ন নম্বর দিন']
  },
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
    required: [true, 'ক্রয় নির্বাচন করুন']
  },
  invoiceNo: {
    type: String,
    required: true
  },
  // Null for a `সরাসরি কেনা` purchase — which is exactly why `adjustment` is
  // refused on those: there is no ledger for the credit to land in.
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  supplierName: {
    type: String,
    trim: true,
    default: 'সরাসরি কেনা'
  },
  items: {
    type: [purchaseReturnItemSchema],
    required: [true, 'ফেরতের পণ্য যোগ করুন'],
    validate: [arr => arr.length > 0, 'অন্তত একটি পণ্য ফেরত দিতে হবে']
  },
  /**
   * The supplier credit — Σ `items.total`, billed net.
   *
   * Unlike `SalesReturn.totalAmount` this is the WHOLE figure, not a
   * merchandise sub-total: a purchase carries no VAT and no delivery charge, so
   * there is nothing sitting outside it. Every money path moves exactly this.
   */
  totalAmount: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না']
  },
  /**
   * How the shop gets the value back.
   *
   *   adjustment  বাকি থেকে কাটা — the credit reduces what the shop owes, this
   *               bill first and then the same supplier+branch's older open
   *               bills, oldest first (D-3).
   *   cash        টাকা ফেরত — the supplier handed money back on the spot.
   *   pending     পরে নেবো — goods went back, settlement did not happen yet.
   *
   * `pending` is the name `SalesReturn` spells `store_credit`, and it is a
   * better one here: the shop is not extending anybody credit, it is waiting to
   * be paid.
   */
  refundMethod: {
    type: String,
    enum: ['adjustment', 'cash', 'pending'],
    required: [true, 'ফেরতের পদ্ধতি নির্বাচন করুন']
  },
  // `pending` is born pending; the other two settle on arrival. Same default as
  // the sale side, for the same reason — see SalesReturn.model.js.
  refundStatus: {
    type: String,
    enum: ['settled', 'pending'],
    default: 'settled'
  },
  settledAt: {
    type: Date
  },
  settledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // How the money finally arrived, when a `pending` return is settled later.
  settlementMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS)
  },
  // How the money arrived on the spot, for a same-day `cash` return.
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS)
  },
  /**
   * Which PaymentAccount the refund was received INTO.
   *
   * Covers both moments this document can take money in — the same-day cash
   * refund and the later settlement of a pending one — because an account can
   * only be credited once per return. Null for an `adjustment` (no cash moves)
   * and for every shop without `features.fundAccounts`.
   */
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    default: null
  },
  /**
   * Every bill an `adjustment` credit landed on, this one first (D-3).
   *
   * The mirror of `Payment.allocations` on the purchase-payment path, and it
   * exists for the same reason: without it there is no record of WHICH older
   * bills a spilled credit settled, and the toast that says "পুরোনো বিল PUR…
   * এ ৳X বসেছে" would be un-reconstructable a minute later.
   *
   * Empty for `cash` and `pending`, which touch no bill at all.
   */
  allocations: [{
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Purchase',
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: [0, 'পরিমাণ ০ এর কম হতে পারবে না']
    }
  }],
  // Required at the SERVICE layer, not here — see the same field on
  // SalesReturn.model.js for why a schema-level `required` would strand any row
  // written before the rule existed.
  reason: {
    type: String,
    trim: true,
    maxlength: [500, 'কারণ ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
purchaseReturnSchema.index({ shop: 1, returnNo: 1 }, { unique: true, sparse: true });
purchaseReturnSchema.index({ shop: 1, purchase: 1 });
purchaseReturnSchema.index({ shop: 1, supplier: 1, createdAt: -1 });
purchaseReturnSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing
// "Which refunds is the supplier still sitting on?" — the one query
// `refundStatus` exists to answer, and the one the amber banner reads.
purchaseReturnSchema.index({ shop: 1, branch: 1, refundStatus: 1, createdAt: -1 });

purchaseReturnSchema.virtual('itemCount').get(function() {
  return (this.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
});

/**
 * Generate a return number, `PRET<YYYYMMDD><seq4>`.
 *
 * ── Why `InvoiceCounter` and not `ReturnCounter` (D-6) ──────────────────────
 *
 * The plan preferred a `kind` key on `ReturnCounter` and allowed
 * `InvoiceCounter` as a fallback "if it already carries a type key". It does,
 * and it has carried one since purchases started using it: `InvoiceCounter.date`
 * is documented as an OPAQUE PERIOD KEY, and `Purchase.generateInvoiceNo`
 * already coexists with sales in that collection by keying on `PUR:YYYY-MM`,
 * which no bare date string can equal.
 *
 * So this keys on `PRET:YYYY-MM-DD` — which can equal neither a sale's bare
 * `YYYY-MM-DD` nor a purchase's `PUR:YYYY-MM` — and the whole feature ships
 * with ZERO index changes. Adding a `kind` field to `ReturnCounter` would have
 * meant dropping and rebuilding its unique `{shop, date}` key in production,
 * where `autoIndex` is off: a migration, a `sync-indexes` window, and a race
 * against every sales return taken in between. The fallback is strictly
 * cheaper and gives up nothing.
 *
 * `branch` is null because purchase numbering is shop-wide (the prefix carries
 * no branch code) — the same call `Purchase.generateInvoiceNo` documents.
 *
 * The day is the BANGLADESH calendar day. `padStart(4)` is a minimum width, not
 * a cap: past 9,999 the number grows to five digits and stays unique.
 */
purchaseReturnSchema.statics.generateReturnNo = async function(shopId) {
  // Required here rather than at module top to keep model load order free of
  // cycles — the same reason `Purchase.generateInvoiceNo` does it.
  const InvoiceCounter = require('./InvoiceCounter.model');
  const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

  const dateStr = getBangladeshTodayStr();
  const prefix = `PRET${dateStr.replace(/-/g, '')}`;

  // Consulted only the first time this shop returns anything to a supplier on a
  // given day, so a shop switching over mid-day continues its sequence rather
  // than restarting at 0001.
  const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);
  const countExisting = () => this.countDocuments({
    shop: shopId,
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  const seq = await InvoiceCounter.nextSeq(shopId, null, `PRET:${dateStr}`, countExisting);

  return `${prefix}${String(seq).padStart(4, '0')}`;
};

/**
 * Summary for the stat tiles and the pending banner.
 *
 * `branchId` is not decoration — it is what keeps these totals over the same
 * rows `getReturns` lists. Cast, never passed through: `req.branchId` arrives
 * as a STRING off the Redis auth payload and `$match` does not cast (I-3), so
 * an uncast id matches zero documents and silently reports zeros.
 *
 * An absent bound means unbounded, exactly as it does for the list.
 */
purchaseReturnSchema.statics.getReturnsSummary = async function(shopId, startDate, endDate, branchId = null) {
  const match = { shop: new mongoose.Types.ObjectId(shopId) };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }

  const summary = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalReturns: { $sum: '$totalAmount' },
        count: { $sum: 1 },
        // What the supplier has taken goods for and not yet paid for. The whole
        // point of `refundStatus` — this is the ONLY place in the app that
        // receivable appears.
        pendingRefundAmount: {
          $sum: { $cond: [{ $eq: ['$refundStatus', 'pending'] }, '$totalAmount', 0] }
        },
        pendingRefundCount: {
          $sum: { $cond: [{ $eq: ['$refundStatus', 'pending'] }, 1, 0] }
        },
        // How much of the credit was taken off the খাতা rather than in cash —
        // the figure the supplier statement's `return` rows add up to.
        adjustedAmount: {
          $sum: { $cond: [{ $eq: ['$refundMethod', 'adjustment'] }, '$totalAmount', 0] }
        }
      }
    }
  ]);

  return summary[0] || {
    totalReturns: 0,
    count: 0,
    pendingRefundAmount: 0,
    pendingRefundCount: 0,
    adjustedAmount: 0,
  };
};

/**
 * A return is a ledger row, not a draft — the same argument `SalesReturn`
 * carries. It has decremented stock, drained batches, reduced `Purchase.due`
 * and moved both supplier books. Deleting it leaves every one of those standing
 * with nothing left to explain them.
 */
purchaseReturnSchema.plugin(immutableGuard, { modelName: 'PurchaseReturn' });

const PurchaseReturn = mongoose.model('PurchaseReturn', purchaseReturnSchema);

module.exports = PurchaseReturn;

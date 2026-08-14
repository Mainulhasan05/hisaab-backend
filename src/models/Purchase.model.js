const mongoose = require('mongoose');
const { immutableGuard } = require('../utils/immutableGuard.util');

const purchaseItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'পণ্য নির্বাচন করুন']
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
  // ── What this line brought in, expiry-wise ─────────────────────────────────
  //
  // `purchase.service` has always read `item.batchNumber` and `item.expiryDate`
  // off the incoming request to build the product's batch — but the fields were
  // never declared here, so Mongoose's strict mode dropped them and the
  // PURCHASE itself kept no record of what it delivered. The consequences were
  // small until they were not: a supplier bill could not be reconciled against
  // the dates entered, and cancelling a purchase had no way to identify which
  // batch to reverse.
  //
  // Snapshots, like `unit` and `packSize` above: editing the product's batch
  // later must not rewrite what this delivery said.
  batchNumber: {
    type: String,
    trim: true
  },
  expiryDate: {
    type: Date
  },
  // 0-exclusive rather than `min: 1` — fractional units (kg / litre / yard).
  // The flag-and-unit-aware refusal lives in `parseQuantity`; schema bounds are
  // the floor, not the policy. See AGENT_WORKFLOW.md I-6.
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  // ── The unit snapshot ──────────────────────────────────────────────────────
  //
  // Mirrors `Sale.items` exactly; see the long note there. The purchase form
  // has always multiplied "৫ বস্তা × ২০ কেজি" on the client and posted 100,
  // throwing the pack away. That made the purchase record unreadable back:
  // a shopkeeper checking a supplier bill against Hisaab saw "১০০ কেজি" where
  // the bill said "৫ বস্তা", and had to redo the division in their head.
  //
  // Storing it changes no arithmetic — `quantity` is still the base-unit number
  // stock is incremented by. It only makes the record say what happened.
  //
  // Absent on every purchase written before this field existed; fall back.
  unit: {
    type: String
  },
  purchaseUnit: {
    type: String,
    enum: ['base', 'pack'],
    default: 'base'
  },
  packUnit: {
    type: String
  },
  packSize: {
    type: Number,
    min: [0.001, 'প্রতি মোড়কে পরিমাণ ০ এর বেশি হতে হবে']
  },
  packQuantity: {
    type: Number,
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  // Per-BASE-unit cost, always — on a pack line it is `packUnitPrice / packSize`.
  // One meaning for this field is what keeps every existing cost/profit report
  // working without learning what a pack is.
  unitPrice: {
    type: Number,
    required: [true, 'একক দাম দিন'],
    min: [0, 'দাম ০ এর কম হতে পারবে না']
  },
  // What the supplier charged for one whole pack. Display-only.
  packUnitPrice: {
    type: Number,
    min: [0, 'দাম ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true
  },
  // ── What this line did to the shelf's cost basis ───────────────────────────
  //
  // Receiving goods re-blends `Product.buyingPrice` as a moving weighted average
  // (see costing.util.js). These two record the before and after so a
  // cancellation can tell whether it is still the owner of that number: if the
  // product's cost has moved on since — a later delivery, a manual edit —
  // reversing to `costBefore` would throw away a figure this purchase did not
  // set. `cancelPurchase` restores only when `costAfter` still stands.
  //
  // Absent on every purchase written before costing existed, and on any line
  // received at zero cost (which deliberately does not move the average).
  costBefore: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  costAfter: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  }
}, { _id: true });

const purchaseSchema = new mongoose.Schema({
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
  invoiceNo: {
    type: String,
    trim: true
  },
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
    type: [purchaseItemSchema],
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'কমপক্ষে একটি পণ্য যোগ করুন'
    }
  },
  totalAmount: {
    type: Number,
    required: true,
    min: [0, 'মোট পরিমাণ ০ এর কম হতে পারবে না']
  },
  paid: {
    type: Number,
    default: 0,
    min: [0, 'পরিশোধ ০ এর কম হতে পারবে না']
  },
  due: {
    type: Number,
    default: 0,
    min: [0, 'বাকি ০ এর কম হতে পারবে না']
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bkash', 'nagad', 'card', 'bank', 'credit'],
    default: 'cash'
  },
  date: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  status: {
    type: String,
    enum: ['completed', 'partial', 'unpaid', 'cancelled'],
    default: 'completed'
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

// Indexes - Optimized for scalability
purchaseSchema.index({ shop: 1, branch: 1, date: -1 }); // Date-based listing with branch
purchaseSchema.index({ shop: 1, supplier: 1, date: -1 }); // Supplier purchase history
purchaseSchema.index({ shop: 1, invoiceNo: 1 }, { unique: true, sparse: true }); // Invoice lookup
purchaseSchema.index({ shop: 1, status: 1, date: -1 }); // Status-filtered listing
purchaseSchema.index({ shop: 1, createdAt: -1 }); // Invoice-number day count, unbranched listing

// Pre-save: calculate due and status with numeric boundary checks
purchaseSchema.pre('save', function(next) {
  if (!Number.isFinite(this.totalAmount) || this.totalAmount > 1e11) {
    this.totalAmount = Math.min(Math.max(0, this.totalAmount || 0), 1e11);
  }
  if (!Number.isFinite(this.paid) || this.paid > this.totalAmount) {
    this.paid = Math.min(Math.max(0, this.paid || 0), this.totalAmount);
  }
  this.due = Math.max(0, this.totalAmount - this.paid);

  // Payment status is derived — EXCEPT for a cancelled purchase, which is a
  // lifecycle state and not a payment state.
  //
  // Without this guard `cancelPurchase` was a no-op on the field it exists to
  // set: it assigns `status = 'cancelled'` and saves, and this hook immediately
  // recomputed 'completed' from `due === 0`. Everything else about the
  // cancellation happened — stock reversed, batches removed, supplier balance
  // unwound — and the purchase stayed in every list and summary as an active
  // one.
  //
  // Worse than the wrong label: `cancelPurchase`'s own "already cancelled"
  // guard could never fire, so the whole reversal was repeatable. Each replay
  // `$inc`-ed SupplierBalance down again while the Supplier rollup clamped at
  // zero — the exact two-books drift that code comments there say it exists to
  // prevent.
  //
  // Sale.model.js has carried this guard since it was written; this is the same
  // rule, and the two must not diverge again.
  if (this.status !== 'cancelled') {
    if (this.due === 0) {
      this.status = 'completed';
    } else if (this.paid > 0) {
      this.status = 'partial';
    } else {
      this.status = 'unpaid';
    }
  }
  next();
});

/**
 * Static: generate a purchase invoice number, `PUR<YYYY><MM><NNNN>`.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * `countDocuments() + 1` — the exact pattern `Sale` abandoned, for the exact
 * reasons written up in InvoiceCounter.model.js. Two purchases entered at once
 * both read the same count, both built the same number, and the unique index on
 * `{shop, invoiceNo}` turned the second one into a raw E11000 in the user's
 * face. The sale path at least had a retry loop; `createPurchase` never did.
 *
 * The month window was also bounded with `new Date(year, month, 1)` — SERVER
 * local midnight. On a UTC host that is 06:00 Dhaka, so a purchase entered in
 * the first six hours of the month was counted into the previous month and
 * collided with a number already issued.
 *
 * Both go away by handing the number out atomically, keyed on the Bangladesh
 * calendar month.
 *
 * ── Sharing InvoiceCounter with sales ───────────────────────────────────────
 *
 * The counter's `date` field is an opaque period key, so the two sequences
 * coexist in one collection as long as they can never collide. A sale's key is
 * a bare `YYYY-MM-DD`; this one is prefixed `PUR:YYYY-MM`, which no date string
 * can equal. `branch` is null here because purchase numbers are shop-wide —
 * unlike sales, the prefix carries no branch code, so a per-branch sequence
 * would make the numbering gappy for no visible reason.
 */
purchaseSchema.statics.generateInvoiceNo = async function(shopId) {
  // Required here rather than at module top only to keep model load order
  // irrelevant; neither module requires this one, so there is no cycle.
  const InvoiceCounter = require('./InvoiceCounter.model');
  const { toBangladeshMonthStr, getBangladeshMonthRange } = require('../utils/bdTime.util');

  const monthStr = toBangladeshMonthStr(new Date());
  const { startOfMonth, startOfNext } = getBangladeshMonthRange(monthStr);

  // Consulted only the first time this shop records a purchase in this month —
  // the counter seeds itself from what is already there, so a shop switching
  // over mid-month continues its sequence rather than restarting at 0001.
  const countExisting = () => this.countDocuments({
    shop: shopId,
    createdAt: { $gte: startOfMonth, $lt: startOfNext },
  });

  const seq = await InvoiceCounter.nextSeq(shopId, null, `PUR:${monthStr}`, countExisting);
  return `PUR${monthStr.replace('-', '')}${String(seq).padStart(4, '0')}`;
};

// Static: Get purchase summary
purchaseSchema.statics.getSummary = async function(shopId, startDate, endDate, branchId = null) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    status: { $ne: 'cancelled' }
  };
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);

  if (startDate && endDate) {
    match.date = { $gte: startDate, $lte: endDate };
  }

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$totalAmount' },
        totalPaid: { $sum: '$paid' },
        totalDue: { $sum: '$due' },
        count: { $sum: 1 },
        totalItems: { $sum: { $size: '$items' } }
      }
    }
  ]);

  return result[0] || {
    totalAmount: 0,
    totalPaid: 0,
    totalDue: 0,
    count: 0,
    totalItems: 0
  };
};

// Apply immutable ledger guard — prevents hard deletion of purchase records
purchaseSchema.plugin(immutableGuard, { modelName: 'Purchase' });

const Purchase = mongoose.model('Purchase', purchaseSchema);

module.exports = Purchase;

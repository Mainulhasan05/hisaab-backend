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
  // ── What the supplier knocked off THIS line ────────────────────────────────
  //
  // Taka, never a percentage. The bill says "৳200 less on the rice"; a
  // percentage is typed in the form and resolved to taka before it is sent,
  // the same way `Sale.items[].discount` works.
  //
  // Clamped to the line it sits on by `purchaseMath` — a ৳200 concession on a
  // ৳150 line is a typo, and letting it through drives the line negative and
  // inverts the allocation weight beside it.
  lineDiscount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  // ── This line's share of the invoice-level figures ─────────────────────────
  //
  // The invoice discount and the charges (ভাড়া + অন্যান্য) are stated once at
  // the foot of the bill and spread back over the lines pro-rata by value —
  // see `purchaseMath.util.js` for why by value, and why the rounding
  // remainder is load-bearing.
  //
  // STORED rather than re-derived on read. The allocation depends on every
  // OTHER line in the delivery, so re-deriving it later against a changed
  // catalogue would restate what this delivery cost. Same reasoning as the
  // `unit` and `packSize` snapshots above.
  //
  // Both are 0 for every purchase written before these fields existed, and for
  // every delivery with no discount and no ভাড়া — which is every purchase on
  // the platform today.
  discountShare: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  chargeShare: {
    type: Number,
    default: 0,
    min: [0, 'খরচ ০ এর কম হতে পারবে না']
  },
  // ── What the goods on this line actually COST ──────────────────────────────
  //
  // Per base unit, like `unitPrice` beside it — and deliberately NOT the same
  // number:
  //
  //     unitPrice        what the supplier BILLED
  //     landedUnitPrice  what it cost, once this line's share of the discount
  //                      and the ভাড়া is folded in
  //
  // `costing.util` blends `Product.buyingPrice` from THIS field, and
  // `Sale.profit` is computed from that. Before it existed the blend read
  // `unitPrice`, so a shop that paid ৳1,80,000 for goods plus ৳6,000 of truck
  // hire recorded a cost basis 3.3% below what the consignment actually cost
  // it — and every margin report on the platform agreed that this was fine.
  //
  // Keeping BOTH is what lets a stored purchase still reconcile line-for-line
  // against the paper in the shopkeeper's hand. Collapsing them into one field
  // looks like tidiness and destroys that.
  //
  // Absent on every purchase written before this existed; fall back to
  // `unitPrice`, which is what it would have equalled anyway.
  landedUnitPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // ── What this line did to the shelf's WHOLESALE price ──────────────────────
  //
  // The third price a delivery can set, and the exact mirror of `sellingPrice`
  // below — read that note first; everything it says applies here.
  //
  // `features.wholesale` ONLY (I-7). A shop without the capability never sends
  // the key, the server refuses it through `normalizeWholesalePrice`, and this
  // field stays absent on every line — which is what keeps a flag-off shop
  // pixel- and byte-identical.
  //
  // Per BASE unit, and `0` means ABSENT, not free: a cleared money box posts 0,
  // and billing ৳0 for a carton because someone emptied a field is not a
  // discount. Same rule `packSellingPrice` and `Product.wholesalePrice`
  // already follow.
  wholesalePrice: {
    type: Number,
    min: [0, 'পাইকারি মূল্য ০ এর কম হতে পারবে না']
  },
  // What the product's wholesale rate was immediately before this line changed
  // it, so `cancelPurchase` can tell whether the number it would restore is
  // still the one this delivery wrote. Set only when `wholesalePrice` above
  // actually wrote something.
  wholesalePriceBefore: {
    type: Number,
    min: [0, 'পাইকারি মূল্য ০ এর কম হতে পারবে না']
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
  },
  // ── What this line did to the shelf's RETAIL price ─────────────────────────
  //
  // A delivery at a new cost is the moment the retail price gets reconsidered —
  // the supplier's rate went up, so the shelf price goes up with it. Until now
  // the two were separate errands: record the purchase here, then go find each
  // product and edit its price. In practice the second errand did not happen,
  // and shops sold new stock at last season's price against a cost basis that
  // `costing.util` had already moved. The margin was wrong and nothing said so.
  //
  // Optional, and absent on most lines. Empty means "leave the price alone",
  // which is the old behaviour exactly and what a top-up delivery at the same
  // rate wants. Only a positive figure writes.
  //
  // Per BASE unit, like `unitPrice` beside it — one meaning per column is what
  // lets every existing margin report read this without learning what a pack is.
  sellingPrice: {
    type: Number,
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  // What the product's price was immediately before this line changed it.
  //
  // The same guard `costBefore` provides, for the same reason: a cancellation
  // must be able to tell whether the price it would be putting back is still
  // the one this delivery set. If a later delivery — or the product form — has
  // moved it on, that change owns the number and reversing past it would
  // silently discard a price the shopkeeper deliberately chose.
  //
  // Set only when `sellingPrice` above actually wrote something.
  sellingPriceBefore: {
    type: Number,
    min: [0, 'বিক্রয় মূল্য ০ এর কম হতে পারবে না']
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
  /**
   * The SUPPLIER'S own bill number — the challan printed on the paper that
   * arrived with the goods.
   *
   * `invoiceNo` above is OURS (`PUR2026080012`) and always has been. It is
   * useless for the one job a purchase record has to do at month end:
   * reconciling against the vendor's statement, which lists their numbers and
   * has never heard of ours. Without this field that reconciliation was manual,
   * and the printed goods-received note had nothing to tie back to.
   *
   * Free text, and deliberately NOT unique: suppliers reuse and duplicate their
   * own numbering, two suppliers may both issue "1024", and a shop copying it
   * off a smudged carbon must never be blocked from recording the delivery.
   * Empty on every purchase written before this existed.
   */
  supplierInvoiceNo: {
    type: String,
    trim: true,
    maxlength: [60, 'চালান নম্বর ৬০ অক্ষরের বেশি হতে পারবে না']
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
  /**
   * ── The foot of the supplier's bill ─────────────────────────────────────
   *
   * `totalAmount` used to BE the subtotal: nothing existed between the sum of
   * the lines and the amount owed. It is now derived, and these are the terms:
   *
   *     totalAmount = subtotal − itemDiscount − discountAmount
   *                              + freightCharge + otherCharge
   *
   * Every field here defaults to 0, so a purchase with no concessions and no
   * ভাড়া stores `subtotal === totalAmount` and is byte-identical in every
   * field that existed before (I-1). That is the acceptance test for this
   * change, not a hope about it.
   *
   * The arithmetic lives in `purchaseMath.util.js` and nowhere else — the
   * service calls it, this schema only stores what came back. Recomputing any
   * of it in a second place is how the invoice and the supplier ledger drifted
   * apart on the sale side; see the header of `invoiceMath.util.js`.
   */
  /** Σ (quantity × unitPrice) — the list column, before any concession. */
  subtotal: {
    type: Number,
    default: 0,
    min: [0, 'উপমোট ০ এর কম হতে পারবে না']
  },
  /** Σ items[].lineDiscount — the per-line concessions, already struck off. */
  itemDiscount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  /**
   * The trade discount at the foot of the bill, RAW — this holds `10` on a
   * percentage bill, which is why it is not bounded to a money ceiling and why
   * nothing may sum it. `discountAmount` below is the figure to read.
   */
  discount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed'
  },
  /**
   * The trade discount in TAKA, resolved from the two fields above.
   *
   * Stored resolved for the reason written up on `Sale.discountAmount`:
   * reports sum the raw column, so a month of 10% discounts each contributed
   * ৳10 to "total discount received" regardless of the bill size, and the
   * figure was meaningless for any shop that discounts by percentage.
   *
   * Resolved against MERCHANDISE (subtotal less the line concessions), NOT
   * against subtotal — deliberately unlike `Sale`. On a supplier's bill the
   * per-line concessions are struck off before the trade discount is applied
   * to the foot, so 10% means 10% of what is left.
   */
  discountAmount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  /**
   * ভাড়া — what it cost to get the consignment here.
   *
   * This is NOT a memo line. It is spread over the lines by
   * `purchaseMath.computePurchaseTotals` and reaches `Product.buyingPrice`
   * through `landedUnitPrice`, because it is part of what the stock cost.
   * Recording it here and booking it as a transport `Expense` as well would
   * double-count it.
   */
  freightCharge: {
    type: Number,
    default: 0,
    min: [0, 'ভাড়া ০ এর কম হতে পারবে না']
  },
  /** Labour, unloading, weighing. Allocated exactly as `freightCharge` is. */
  otherCharge: {
    type: Number,
    default: 0,
    min: [0, 'খরচ ০ এর কম হতে পারবে না']
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
  /**
   * ── Supplier credit taken off this bill by a কেনা ফেরত ────────────────────
   *
   * The third term in the `due` derivation below, and the ONLY sanctioned way
   * to reduce what a purchase owes without pretending it was paid.
   *
   * ── Why a stored accumulator and not a lower `due` ────────────────────────
   *
   * `due` is DERIVED in `pre('save')` from `totalAmount − paid`. So a return
   * that simply wrote a smaller `due` would survive exactly until the next
   * `save()` of the document — `recordPayment` does one on every payment — at
   * which point the hook would recompute the old figure from `paid` alone and
   * the credit would silently vanish. That is not hypothetical: it is precisely
   * the bug `Sale.returnedAmount` was introduced to end on the sale side (see
   * the accumulator note in `salesReturn.service`), and this is the same fix.
   *
   * ── Why not just increase `paid` ──────────────────────────────────────────
   *
   * Because the shop did not pay. `paid` is money that left the drawer, and
   * every reader treats it as such: the supplier statement prints
   * `paid − Σ later payments` as "ক্রয়ের সময় পরিশোধ", the cash register sums
   * the cash legs, and `recalc-supplier-balances` reconciles against it. Adding
   * a return to `paid` would report cash the shop never handed over, on the
   * statement the shop reconciles against the supplier's own paper.
   *
   * ── Why `updateOne` was rejected ──────────────────────────────────────────
   *
   * An `updateOne` writing `due` and `status` directly would bypass the hook —
   * and then live exactly one `save()` from being overwritten, the same way the
   * naive version above does. Feeding the hook a new input keeps ONE
   * derivation, and makes it idempotent: any later `save()` from any path lands
   * on the same answer instead of a different one.
   *
   * ── Byte-identity (I-1) ───────────────────────────────────────────────────
   *
   * NO `default`, deliberately. A default of 0 would stamp the field onto every
   * purchase every shop has ever recorded the next time it was saved. Absent
   * means zero, every reader falls back, and a shop that never returns anything
   * stores documents identical to today's.
   */
  returnedAmount: {
    type: Number,
    min: [0, 'ফেরত ০ এর কম হতে পারবে না']
  },
  /**
   * What the shop owed this supplier BEFORE this delivery.
   *
   * ── Why a snapshot and not a live read ────────────────────────────────────
   *
   * A challan describes ONE transaction at ONE moment. Deriving the supplier's
   * balance when the slip is printed would make a reprint of last month's bill
   * show TODAY's figure — a different document every time it comes off the
   * printer, and useless for the one thing it is for: reconciling against the
   * vendor's own paper. `Sale.previousDue` exists for exactly this reason and
   * its header says the same (PURCHASE_PLAN F-3).
   *
   * Read server-side inside the transaction, before the bill is written, so it
   * cannot include the bill it sits on. The figure the shopkeeper saw on screen
   * is never trusted for it.
   *
   * ── ABSENT is a third answer ──────────────────────────────────────────────
   *
   * No `default`, deliberately. A purchase with no supplier, and every purchase
   * written before this field existed, carries nothing here — and readers must
   * be able to tell "no snapshot was taken" from "they were owed ৳0". A default
   * of 0 would make every reprint of an older bill assert the second, which is
   * a claim the document cannot support. Absent also keeps those documents
   * byte-identical (I-1).
   */
  /**
   * অগ্রিম consumed by this bill.
   *
   * ── Why a fourth term and not a bigger `paid` ─────────────────────────────
   *
   * The money left the drawer WEEKS AGO, as a `supplier_advance` row. Adding it
   * to `paid` would claim the shop handed cash over on the day the goods
   * arrived, which the cash register and the supplier statement both read
   * literally — and, worse, `scripts/recalc-supplier-balances.js` would then
   * count it twice: once inside `Σ purchase.paid` and once as the bill-less
   * advance row it already counts. That is the S-11 double count, rebuilt.
   *
   * ── Why an accumulator and not a smaller `due` ────────────────────────────
   *
   * `due` is DERIVED in `pre('save')`. A smaller `due` written directly would
   * survive exactly until the next `save()` of this document, at which point
   * the hook would recompute the old figure and the credit would vanish. That
   * is precisely the bug `returnedAmount` was introduced to end on this same
   * model, and this is the same fix in the same shape.
   *
   * ── What it makes true ────────────────────────────────────────────────────
   *
   * `Supplier.advanceBalance` falls on its own the moment a bill is booked,
   * because it is derived from `totalAmount`. Without this field the SUPPLIER
   * would read as owing nothing while the BILL still read as fully due — and
   * the payables ageing, which sums `Purchase.due`, would age debt the vendor
   * position says does not exist.
   *
   * No `default`, like `returnedAmount` and for the same reason: absent on
   * every purchase ever written, absent reads as 0, and nothing changes shape.
   */
  advanceApplied: {
    type: Number,
    min: [0, 'অগ্রিম ০ এর কম হতে পারবে না']
  },
  previousDue: {
    type: Number
  },
  /**
   * Old debt cleared at the same counter, with this delivery.
   *
   * "আজ ৯,০০০ টাকার মাল নিলাম, আর পুরোনো বাকির ৫০,০০০ দিলাম" — one visit, two
   * money events. This is the SECOND one, and it is emphatically not `paid`:
   * `paid` is money against this bill and is clamped to its total, because the
   * P&L, the supplier statement and `cancelPurchase`'s reversal all read it
   * that way. The money itself lives in its own `Payment` rows, written by
   * `supplierSettlement`; this field is the slip's copy of the figure.
   *
   * Stored beside `previousDue` so the printed মোট বাকি can be computed as
   * `previousDue − dueSettled + due` without a second read — and so a reprint
   * shows what the paper showed on the day.
   */
  dueSettled: {
    type: Number
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bkash', 'nagad', 'card', 'bank', 'credit'],
    default: 'cash'
  },
  /**
   * Split payment on a PURCHASE — one leg per method, each naming where the
   * money left from and what reference it left behind.
   *
   * ── Why buying was not the mirror of selling, and had to become one ────────
   *
   * A sale has been settleable ৳400 cash + ৳600 bKash since split payments
   * shipped. A purchase could not: `paymentMethod` above is ONE string covering
   * the whole of `paid`, so "৳1,50,000 went by bank transfer and I handed over
   * ৳50,000 in cash" — an ordinary way to pay a supplier — had no shape to be
   * recorded in. The shopkeeper picked whichever was bigger and the other half
   * was simply mislabelled.
   *
   * `reference` is the second half of the problem and the sharper one. A
   * ৳2,00,000 bank transfer was recorded as the word `bank`: no cheque number,
   * no transfer reference, nothing to match against the bank statement when the
   * supplier says they never received it. `Payment` has carried `reference` and
   * `transactionId` fields all along — `purchase.service.recordPayment` simply
   * never accepted them.
   *
   * ── What stays the same, deliberately ─────────────────────────────────────
   *
   * `paymentMethod` remains, and remains the LARGEST leg, derived exactly the
   * way `createSale` derives `Sale.paymentMethod`. Every existing reader — the
   * purchase list filter, the cash register's `paymentMethod: 'cash'` query,
   * the reports — keeps working untouched. `paid` remains the sum of the legs,
   * so the pre-save hook that recalculates `due` and `status` is not involved
   * in any of this.
   *
   * Empty for every purchase written before this field existed, and for every
   * shop without `features.fundAccounts` — which is why nothing may read it
   * without falling back to `paymentMethod` + `paid`.
   */
  payments: [{
    method: {
      type: String,
      enum: ['cash', 'bkash', 'nagad', 'card', 'bank'],
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: [0, 'পেমেন্ট ০ এর কম হতে পারবে না']
    },
    // Which PaymentAccount the money left. Null for a shop without the
    // capability — the leg still records the method, which is what the shop
    // had before and loses nothing.
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentAccount',
      default: null
    },
    // Cheque number · bank transfer reference · bKash TrxID. Free text on
    // purpose: it is copied off whatever the other party gave, and validating
    // it would reject the real thing.
    reference: {
      type: String,
      trim: true,
      maxlength: [100, 'রেফারেন্স ১০০ অক্ষরের বেশি হতে পারবে না']
    }
  }],
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
  // ── The cancellation record (F-6) ──────────────────────────────────────────
  //
  // `status: 'cancelled'` said THAT a bill was voided; nothing said when, by
  // whom, or why — and the list hid the row anyway, so a voided purchase left
  // no trace on any screen a finance person would look at. All three are null
  // on every live purchase and on every one cancelled before this existed.
  cancelledAt: {
    type: Date,
    default: null
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  cancelReason: {
    type: String,
    trim: true,
    maxlength: [200, 'কারণ ২০০ অক্ষরের বেশি হতে পারবে না'],
    default: null
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
/**
 * How much of this bill is still unsettled BEFORE any অগ্রিম is credited.
 *
 * The ceiling on what the vendor's prepayment pool may put against this one
 * bill, and the same quantity the `due` hook clamps `advanceApplied` to. It
 * lives here, as one function, because two callers need it and they must agree
 * exactly — see the note beside `advanceCredit` in the hook.
 *
 * `returnedAmount` is netted off for the reason the hook gives: a কেনা ফেরত
 * shrinks the obligation, so it shrinks what a prepayment can be spent on. A
 * bill that has been paid and returned down to nothing reports 0 and the
 * allocator skips it, leaving that money for the next open bill instead of
 * parking it where it would be clamped away.
 *
 * Takes a plain object as well as a document, so the allocator can ask the
 * question of a `.lean()` row without hydrating it.
 */
purchaseSchema.statics.outstandingBeforeAdvance = function (doc) {
  if (!doc) return 0;
  const totalAmount = Number(doc.totalAmount) || 0;
  const paid = Number(doc.paid) || 0;
  const returned = Number.isFinite(doc.returnedAmount)
    ? Math.min(Math.max(0, doc.returnedAmount), Math.max(0, totalAmount - paid))
    : 0;
  return Math.max(0, totalAmount - paid - returned);
};

purchaseSchema.pre('save', function(next) {
  if (!Number.isFinite(this.totalAmount) || this.totalAmount > 1e11) {
    this.totalAmount = Math.min(Math.max(0, this.totalAmount || 0), 1e11);
  }
  if (!Number.isFinite(this.paid) || this.paid > this.totalAmount) {
    this.paid = Math.min(Math.max(0, this.paid || 0), this.totalAmount);
  }

  /**
   * Credit the supplier gave back on goods that went to them (কেনা ফেরত).
   *
   * Read through a fallback and clamped to what the bill can still absorb, for
   * two separate reasons:
   *
   *   · absent on every purchase written before returns existed, and on every
   *     purchase that has never had one — which is nearly all of them. Absent
   *     reads as 0 and the arithmetic below is byte-identical to what it was
   *     (I-1).
   *   · capped at `totalAmount − paid`, so a credit can only ever wipe an
   *     OUTSTANDING obligation. It can never drive `due` below zero, and it can
   *     never be mistaken for money owed BACK to the shop — a supplier advance
   *     is deliberately still not tracked anywhere (see `recordPayment`'s F-4
   *     refusal, which makes the same call).
   */
  const returnedCredit = Number.isFinite(this.returnedAmount)
    ? Math.min(Math.max(0, this.returnedAmount), Math.max(0, this.totalAmount - this.paid))
    : 0;

  /**
   * অগ্রিম this bill consumed, clamped to the room it actually has left.
   *
   * Through `outstandingBeforeAdvance` rather than the arithmetic inline,
   * because `reallocateSupplierAdvance` has to decide how much of the pool this
   * bill can absorb and must reach the SAME number. Written out twice they
   * drift, and the drift is silent: the allocator would hand the bill ৳9,000,
   * this hook would clamp it to ৳7,000, and ৳2,000 of the vendor's money would
   * stop existing with no book reporting an error.
   *
   * It can never drive `due` below zero and can never be mistaken for money
   * owed BACK to the shop — that half lives on `Supplier.advanceBalance`,
   * where it belongs.
   */
  const advanceCredit = Number.isFinite(this.advanceApplied)
    ? Math.min(
        Math.max(0, this.advanceApplied),
        this.constructor.outstandingBeforeAdvance(this)
      )
    : 0;

  this.due = Math.max(0, this.totalAmount - this.paid - returnedCredit - advanceCredit);

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
  //
  // ── What a return does to the label ──────────────────────────────────────
  //
  // `status` is derived from `due`, and `due` is now net of `returnedAmount`.
  // So a bill whose whole remaining obligation was cancelled out by a কেনা
  // ফেরত reads 'completed' — which is what this field has ALWAYS meant here:
  // nothing outstanding. It is deliberately not given a fourth value.
  //
  // The alternative (a 'returned' status) would be read by `getPurchases`'s
  // default `status: { $ne: 'cancelled' }` filter as an ordinary live bill and
  // by nothing else, so it would buy a label and cost a migration of every
  // status-filtered query, every report `$match` and the list's own filter
  // chips. The return document is where "this bill had goods sent back" is
  // recorded, and the detail page reads it from there.
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

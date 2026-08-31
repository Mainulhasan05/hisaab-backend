const mongoose = require('mongoose');
const { quantizeMoney } = require('../utils/quantity.util');

const supplierSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  name: {
    type: String,
    required: [true, 'সরবরাহকারীর নাম দিন'],
    trim: true,
    maxlength: [200, 'নাম ২০০ অক্ষরের বেশি হতে পারবে না']
  },
  /**
   * The firm behind the person, when there is one.
   *
   * Deliberately its own field rather than being folded into `name`. The shop
   * deals with a HUMAN ("করিম ভাই") who represents a COMPANY ("মেসার্স রহমান
   * ট্রেডার্স"), and both are how a supplier gets found — the phone call goes to
   * the person, the bill arrives under the firm. Folding them together would
   * also collide with the `{shop, name}` unique index: two reps of the same firm
   * are two suppliers, and one firm with a renamed rep is not a new supplier.
   *
   * Optional and NOT part of the uniqueness rule: several suppliers may share a
   * company, and a shop that only ever knows a name should never be blocked.
   */
  companyName: {
    type: String,
    trim: true,
    maxlength: [200, 'কোম্পানির নাম ২০০ অক্ষরের বেশি হতে পারবে না']
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true,
    maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
  },
  /**
   * Everything ever handed to this supplier — at the counter and afterwards.
   *
   * ── Why this had to exist ─────────────────────────────────────────────────
   *
   * `totalDue` used to be a pure `$inc` accumulator, and the header below still
   * described the shop-wide rollup as never re-deriving. That was workable
   * while a payable could only ever be a payable. It stops working the moment
   * the shop can be IN CREDIT with a vendor, because a credit is the negative
   * half of one number and `$inc` has no way to tell the two halves apart.
   *
   * The customer side solves this by deriving both halves from three stored
   * components. `Supplier` had only two of them — hence this field, and hence
   * SUPPLIER_DUE_ADVANCE_PLAN.md S-9's warning that the customer design is NOT
   * copy-pasteable here.
   *
   * ── What counts ───────────────────────────────────────────────────────────
   *
   * The same quantity `SupplierBalance.totalPaid` has always carried, and the
   * same one `scripts/recalc-supplier-balances.js` rebuilds:
   *
   *     Σ purchase.paid  +  Σ live supplier payments carrying no purchase
   *
   * `purchase.paid` is the WHOLE of what a bill has been paid — `recordPayment`
   * folds later settlements into it — so the `Payment` rows behind those
   * settlements must never be added on top. That double count is exactly the
   * defect the reconciler carried until 2026-08-31.
   *
   * ── NO `default`, and that is what makes the deploy safe ──────────────────
   *
   * Every supplier that existed before this field did has no value for it. With
   * a `default: 0` mongoose would hand those documents a confident zero on
   * hydration, `deriveDue` would compute `totalAmount + openingDue − 0`, and
   * the first purchase entered against a vendor the shop had been paying for
   * months would restate their payable as EVERYTHING EVER BILLED. On a real
   * shop that is lakhs of taka, written silently, on an ordinary Tuesday.
   *
   * Absent instead means "not yet known", which `backfillTotalPaid` detects and
   * seeds from the invariant that already held. So the correct figure arrives
   * on first touch whether or not anyone remembered to run the backfill script
   * first — the ordering stops being load-bearing, which is the only safe way
   * to ship a derived column onto live rollups.
   *
   * Same reasoning as `Purchase.returnedAmount`, and the same rule follows:
   * every reader falls back, and a shop that never touches a supplier keeps
   * documents identical to today's.
   */
  totalPaid: {
    type: Number
  },
  /**
   * Money the shop has handed over that this supplier has not yet delivered
   * against — the other half of `totalDue`.
   *
   * Derived, never incremented: `max(0, totalPaid − totalAmount − openingDue)`.
   * `totalDue` is `max(0, +net)` and this is `max(0, −net)`, so exactly one of
   * the two is ever non-zero. That exclusivity is what makes it impossible for
   * any aggregation to net one vendor's prepayment against another's debt, and
   * it is why all twelve `{ totalDue: { $gt: 0 } }` queries keep returning the
   * right rows with no edits.
   *
   * ── This is an ASSET, and the mirror of the customer's liability ──────────
   *
   * `Customer.advanceBalance` is money the shop HOLDS and has not earned — a
   * liability. This is money the shop has PAID and not yet consumed — a claim
   * on the vendor. Neither is revenue or expense, and neither may be netted
   * against the due it sits beside: a shop owing ৳2,00,000 that has prepaid
   * ৳50,000 to a different vendor owes ৳2,00,000 and owns a ৳50,000 claim.
   *
   * Booking a prepayment as an `Expense` instead — which is what a shopkeeper
   * does today, because it is the only door open — overstates cost of goods in
   * the month the money left and double-counts it when the bills arrive.
   */
  advanceBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  /**
   * What the shop already owed this supplier before the software existed.
   *
   * The mirror image of `Customer.openingDue`, and it exists for the same
   * reason: a shop that traded on a paper খাতা for years arrives owing its
   * vendors real money that no `Purchase` of ours produced. That debt has to
   * appear in every payable figure and every future purchase has to stack on
   * top of it — see DueAdjustment.model.js for why a fake purchase would have
   * been the wrong way to carry it (here the equivalent trap is `Purchase`,
   * which feeds the purchase reports, cost-of-goods and the cash register).
   *
   * `totalDue` ALREADY INCLUDES this. `supplier.service._applyOpeningDue` is
   * the single writer, and the per-branch halves live on `SupplierBalance`.
   *
   * **Every path now RE-DERIVES rather than `$inc`-ing**, through
   * `Supplier.applyBalances`:
   *
   *     net      = totalAmount + openingDue − totalPaid
   *     totalDue = max(0, net)      advanceBalance = max(0, −net)
   *
   * That is a change from how this rollup used to work — it was `$inc`-only,
   * and the comment here said so. See `totalPaid` for why it had to stop.
   *
   * Note the vocabulary difference from `Customer`: on a supplier the money
   * bought is `totalAmount` and `totalPurchases` is a COUNT.
   */
  openingDue: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes - Optimized for scalability
supplierSchema.index({ shop: 1, name: 1 }, { unique: true }); // Name lookup
supplierSchema.index({ shop: 1, createdAt: -1 }); // Listing by date
// "Which vendors are holding our money" — a short list by construction, so the
// index is partial and costs nothing on the shops that never prepay anyone.
supplierSchema.index(
  { shop: 1, advanceBalance: -1 },
  { partialFilterExpression: { advanceBalance: { $gt: 0 } } }
);

/**
 * Seed `totalPaid` for a supplier that predates the column.
 *
 * **Call this immediately after loading the document and BEFORE moving any
 * component.** Seeding afterwards would fold the new purchase or payment into
 * the historical figure and count it twice.
 *
 * The seed inverts the invariant that has always held on this rollup:
 *
 *     totalDue = totalAmount + openingDue − totalPaid
 *       =>  totalPaid = totalAmount + openingDue − totalDue
 *
 * so any supplier whose books were consistent gets exactly the right figure,
 * and any whose books were not keeps its drift visible to the reconciler
 * instead of having it silently rewritten. Floored at zero: a rollup that was
 * already overstated must not seed a negative payment history.
 *
 * Idempotent — a document that has the field is left alone, so this costs one
 * `undefined` check forever after the first touch.
 */
supplierSchema.statics.backfillTotalPaid = function (doc) {
  if (doc && (doc.totalPaid === undefined || doc.totalPaid === null)) {
    doc.totalPaid = quantizeMoney(Math.max(
      0,
      (doc.totalAmount || 0) + (doc.openingDue || 0) - (doc.totalDue || 0)
    ));
  }
  return doc;
};

/**
 * The payable half: what the shop owes, floored at zero.
 *
 * Mirrors `Customer.deriveDue`, with this model's vocabulary — `totalAmount` is
 * money bought, `totalPurchases` is a COUNT.
 */
supplierSchema.statics.deriveDue = function (doc) {
  return quantizeMoney(Math.max(
    0,
    (doc?.totalAmount || 0) + (doc?.openingDue || 0) - (doc?.totalPaid || 0)
  ));
};

/** The prepayment half: what the vendor is holding for us, floored at zero. */
supplierSchema.statics.deriveAdvance = function (doc) {
  return quantizeMoney(Math.max(
    0,
    (doc?.totalPaid || 0) - (doc?.totalAmount || 0) - (doc?.openingDue || 0)
  ));
};

/**
 * Set BOTH halves from the three components. The only sanctioned way to move
 * either figure.
 *
 * ── Why derive rather than `$inc` ─────────────────────────────────────────
 *
 * Five paths move a supplier's book: `createPurchase`, `recordPayment`,
 * `cancelPurchase`, `purchaseReturn`'s adjustment leg and `_applyOpeningDue`.
 * A stored `advanceBalance` maintained by `$inc` would need a matching reversal
 * in every one of them, each able to drift silently and none of them checked by
 * anything until a reconciler ran. Derived from the same three components,
 * there are zero reversals to get wrong.
 *
 * `advanceBalance` is still STORED — for the same reason `totalDue` is, despite
 * being equally derivable: a computed value cannot be indexed or `$match`ed.
 * But it is recomputed, never incremented, on every write.
 */
supplierSchema.statics.applyBalances = function (doc) {
  doc.totalDue = this.deriveDue(doc);
  doc.advanceBalance = this.deriveAdvance(doc);
  return doc;
};

// Static: Search suppliers
supplierSchema.statics.searchSuppliers = function(shopId, query, options = {}) {
  const { page = 1, limit = 20 } = options;

  const filter = {
    shop: shopId,
    isActive: true,
    $or: [
      { name: { $regex: query, $options: 'i' } },
      // Searchable for the same reason it is stored: half the time the shop
      // remembers the firm on the bill, not the rep who delivered it.
      { companyName: { $regex: query, $options: 'i' } },
      { phone: { $regex: query, $options: 'i' } }
    ]
  };

  return this.find(filter)
    .sort({ name: 1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

const Supplier = mongoose.model('Supplier', supplierSchema);

module.exports = Supplier;

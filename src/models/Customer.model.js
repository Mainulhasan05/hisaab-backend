const mongoose = require('mongoose');
const { normalizePhone } = require('../utils/phone.util');
const { quantizeMoney } = require('../utils/quantity.util');

const customerSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  phone: {
    type: String,
    required: [true, 'ফোন নম্বর দিন'],
    trim: true
  },
  name: {
    type: String,
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  address: {
    type: String,
    trim: true,
    maxlength: [500, 'ঠিকানা ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  // Financial summary
  totalPurchases: {
    type: Number,
    default: 0
  },
  totalPaid: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
  },
  // Due that no invoice of ours produced — the balance carried over from the
  // shop's paper খাতা at onboarding, plus any later owner correction. Kept as
  // its own term rather than folded into `totalPurchases` so that "মোট কেনাকাটা"
  // stays honest: it means goods actually bought here, and nothing else.
  //
  // `totalDue` already includes this. The two are maintained together — see
  // DueAdjustment.model.js for the formula every recompute path must use.
  openingDue: {
    type: Number,
    default: 0
  },
  /**
   * Money the shop is HOLDING for this customer — the other half of `totalDue`.
   *
   * ── It is the same number, on the other side of zero ───────────────────────
   *
   * `deriveDue` is `max(0, totalPurchases + openingDue − totalPaid)`. Call that
   * inner expression the NET POSITION. When it is positive the customer owes
   * us; when it is negative we are holding their money. `deriveDue` has always
   * thrown the negative half away at the `max(0, …)`, which is exactly why an
   * advance could not be represented — not because the data was missing, but
   * because the clamp discarded it.
   *
   * So this is not a second ledger. It is `max(0, −net)`, and the pair of them
   * carries the whole truth:
   *
   *     totalDue       = max(0,  net)
   *     advanceBalance = max(0, −net)
   *
   * ── Derived, NEVER `$inc`-ed ───────────────────────────────────────────────
   *
   * Both halves are recomputed from the three components on every write, via
   * `applyBalances`. That is the same discipline `cancelSale` and the returns
   * paths already adopted for `totalDue` after a `$inc` reversal drove a
   * customer negative — see sale.service.js's note at the cancellation rollup.
   *
   * Maintaining this by increment would need a reversal in `cancelSale`, three
   * in `salesReturn`, one in `reviseSale`, one in `recordPayment` and one in
   * `_applyDueAdjustment`. Seven places to drift, each silently. Derived from
   * the components there are none: every one of those paths already `$inc`s
   * the components and re-derives, so they get this for free.
   *
   * Stored rather than computed on read for the same reason `totalDue` is
   * stored despite being derivable — you cannot `$match` or index an
   * expression, and "which customers hold credit" has to be a query.
   *
   * ── The invariant this exists to guarantee ─────────────────────────────────
   *
   *     totalDue > 0        ⟹  advanceBalance === 0
   *     advanceBalance > 0  ⟹  totalDue === 0
   *
   * Exactly one is ever non-zero. That is what makes it structurally impossible
   * for any aggregation to net one customer's credit against another's debt: a
   * shop owed ৳50,000 by forty customers while holding ৳3,000 from two others
   * is owed ৳50,000, not ৳47,000. Every `{ totalDue: { $gt: 0 } }` query in the
   * codebase — there are twelve — keeps returning exactly the right rows with
   * no change, because an advance customer's `totalDue` is genuinely zero.
   *
   * ── It is a LIABILITY ──────────────────────────────────────────────────────
   *
   * Not revenue, and not a negative receivable. The shop is holding money it
   * has not earned. `getProfitLoss` reads Sale/Expense/SalesReturn/Purchase and
   * never `Payment`, so this cannot leak into profit — that is not luck, it is
   * the accrual boundary, and it must stay that way.
   *
   * See ADVANCE_PAYMENT_PLAN.md §1.
   */
  advanceBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  purchaseCount: {
    type: Number,
    default: 0
  },
  /**
   * Does this customer buy at the wholesale rate?
   *
   * SHOP-WIDE, deliberately — not per branch. A wholesale buyer is one under
   * every branch's roof, and this sits on the identity document for the same
   * reason `phone` does (I-4): `Customer` is one document per human, and a
   * per-branch tier would mean the same person is quoted two prices depending
   * on which till they walk up to.
   *
   * Inert unless `shop.features.wholesale` is on. Never read this field
   * directly — go through `pricing.util.priceTierFor(req, customer)`, which is
   * what keeps the flag check and the tier decision in one place.
   *
   * OWNER-ONLY to write. It reduces what the shop charges, so a cashier who
   * could set it could hand a friend wholesale rates forever with one tap.
   * Enforced in `customer.service`, not on the route — the route is open to
   * anyone with `customers.update`, only this FIELD is restricted, exactly as
   * `openingDue` is.
   */
  isWholesale: {
    type: Boolean,
    default: false
  },
  lastPurchase: {
    type: Date
  },
  notes: {
    type: String,
    maxlength: [1000, 'নোট ১০০০ অক্ষরের বেশি হতে পারবে না']
  },
  tags: [{
    type: String,
    trim: true
  }],
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
customerSchema.index({ shop: 1, phone: 1 }, { unique: true }); // Phone lookup
customerSchema.index({ shop: 1, totalDue: -1 }); // Due customers list
// The customers we are HOLDING money for. Partial because that set is tiny
// beside the shop's whole book — most customers never leave a deposit — and a
// full index on a field that is 0 for 99% of rows is all cost and no selectivity.
customerSchema.index(
  { shop: 1, advanceBalance: -1 },
  { partialFilterExpression: { advanceBalance: { $gt: 0 } } }
);
customerSchema.index({ shop: 1, createdAt: -1 }); // Listing by date
// Note: Text search removed - use regex for name search or implement Elasticsearch

// Normalize phone before saving
customerSchema.pre('save', function(next) {
  if (this.isModified('phone')) {
    this.phone = normalizePhone(this.phone);
  }
  next();
});

// Virtual: Display name (returns phone if name is empty)
customerSchema.virtual('displayName').get(function() {
  return this.name || this.phone;
});

// Virtual: Has due
customerSchema.virtual('hasDue').get(function() {
  return this.totalDue > 0;
});

/**
 * The one formula. Every path that RE-DERIVES due (rather than `$inc`-ing it)
 * must go through here, so the `openingDue` term can never be dropped on one
 * side and kept on the other — which is exactly how two books silently drift.
 *
 * Mirrored by `CustomerBalance.recomputeBalances` for the per-branch rows and by
 * `scripts/recalc-customer-balances.js`, which checks both against source
 * documents. See DueAdjustment.model.js for why the term exists at all.
 *
 * ── Why the result is quantized ─────────────────────────────────────────────
 *
 * `totalPurchases` and `totalPaid` are running sums of paisa-exact figures, but
 * they accumulate DIFFERENT sequences — a customer buys once and pays in three
 * instalments — so the two doubles drift apart even though every input was
 * exact. Their difference then lands on 1e-13 rather than 0, and it GROWS: a
 * simulated 100k credit transactions ended at 1.1e-6.
 *
 * That residue is not cosmetic. `totalDue: { $gt: 0 }` is the বাকি list
 * (`getCustomersWithDue`, `customer.service.getCustomers`, the branch due
 * summary), so a customer who owes nothing sits on it permanently and no
 * payment can ever clear them — there is nothing left to pay.
 *
 * `invoiceMath.computeInvoiceTotals` quantizes the INVOICE's due for exactly
 * this reason (see that file's header). This is the ledger half of the same
 * fix; the two must round identically or the invoice and the customer's book
 * disagree by a paisa, which is the drift both files exist to prevent.
 */
customerSchema.statics.deriveDue = function(doc) {
  return quantizeMoney(Math.max(
    0,
    (doc?.totalPurchases || 0) + (doc?.openingDue || 0) - (doc?.totalPaid || 0)
  ));
};

/**
 * The other half of `deriveDue` — money the shop is holding for the customer.
 *
 * `max(0, −net)` where `deriveDue` is `max(0, +net)`. Quantized for the same
 * reason and by the same function, because the two must round identically: if
 * one rounded up and the other down, a squared-off customer could show a paisa
 * of due AND a paisa of credit at the same time, breaking the one invariant
 * this whole design rests on (see the field's note).
 *
 * Never call this alone — use `applyBalances`, which sets both.
 */
customerSchema.statics.deriveAdvance = function(doc) {
  return quantizeMoney(Math.max(
    0,
    (doc?.totalPaid || 0) - (doc?.totalPurchases || 0) - (doc?.openingDue || 0)
  ));
};

/**
 * Set BOTH halves of the balance from the three components. The only sanctioned
 * way to move either figure on a re-derivation path.
 *
 * Every `doc.totalDue = Customer.deriveDue(doc)` in this codebase became a call
 * to this. That is not tidying: setting one half and leaving the other stale is
 * precisely how the two would come to disagree, and a stale `advanceBalance`
 * says the shop is holding money it has already given back in goods. There is
 * no legitimate reason to derive one without the other, so the API does not
 * offer it.
 *
 * Mutates and returns the document; the caller still saves.
 */
customerSchema.statics.applyBalances = function(doc) {
  if (!doc) return doc;
  doc.totalDue = this.deriveDue(doc);
  doc.advanceBalance = this.deriveAdvance(doc);
  return doc;
};

// The running sums are quantized on every write for the same reason `deriveDue`
// quantizes its result: clamping the error per operation keeps it from
// accumulating across a million of them. Same rule `quantity.util` applies to
// stock — this is the money half.

// Method: Add purchase
customerSchema.methods.addPurchase = async function(amount, paid) {
  this.totalPurchases = quantizeMoney(this.totalPurchases + amount);
  this.totalPaid = quantizeMoney(this.totalPaid + paid);
  this.constructor.applyBalances(this);
  this.purchaseCount += 1;
  this.lastPurchase = new Date();
  await this.save();
};

// Method: Add payment
customerSchema.methods.addPayment = async function(amount) {
  this.totalPaid = quantizeMoney(this.totalPaid + amount);
  this.constructor.applyBalances(this);
  await this.save();
};

// Method: Refund
customerSchema.methods.refund = async function(amount) {
  this.totalPurchases = quantizeMoney(this.totalPurchases - amount);
  this.constructor.applyBalances(this);
  this.purchaseCount = Math.max(0, this.purchaseCount - 1);
  await this.save();
};

// Static: Find by phone in shop
customerSchema.statics.findByPhoneInShop = function(phone, shopId) {
  const normalizedPhone = normalizePhone(phone);
  return this.findOne({ phone: normalizedPhone, shop: shopId, isActive: true });
};

// Static: Get customers with due
customerSchema.statics.getCustomersWithDue = function(shopId, options = {}) {
  const { page = 1, limit = 20, sortBy = 'totalDue', sortOrder = -1 } = options;

  return this.find({ shop: shopId, totalDue: { $gt: 0 }, isActive: true })
    .sort({ [sortBy]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);
};

// Static: Get top customers
customerSchema.statics.getTopCustomers = function(shopId, limit = 10) {
  return this.find({ shop: shopId, isActive: true })
    .sort({ totalPurchases: -1 })
    .limit(limit);
};

// Static: Search customers
customerSchema.statics.searchCustomers = function(shopId, query, options = {}) {
  const { page = 1, limit = 20 } = options;
  const normalizedQuery = normalizePhone(query) || query;

  return this.find({
    shop: shopId,
    isActive: true,
    $or: [
      { phone: { $regex: normalizedQuery, $options: 'i' } },
      { name: { $regex: query, $options: 'i' } }
    ]
  })
    .sort({ name: 1 })
    .skip((page - 1) * limit)
    .limit(limit);
};

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;

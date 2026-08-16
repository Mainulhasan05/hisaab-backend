const mongoose = require('mongoose');

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
   * `totalDue` ALREADY INCLUDES this. The two are maintained together by
   * `supplier.service._applyOpeningDue`, the single writer, and the per-branch
   * halves live on `SupplierBalance`. The formula every path that RE-DERIVES
   * due must use — as opposed to `$inc`-ing it — is:
   *
   *     totalDue = max(0, totalAmount + openingDue − totalPaid)
   *
   * Only `SupplierBalance.recomputeDue` (the purchase-cancel path) and
   * `scripts/recalc-supplier-balances.js` re-derive. `Supplier` itself only
   * ever increments, which is why it carries no `totalPaid` column.
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

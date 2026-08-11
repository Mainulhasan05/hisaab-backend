const mongoose = require('mongoose');

/**
 * A brand the shop maintains itself.
 *
 * Shop-scoped and nothing else. Unlike `Category`, there are no platform-wide
 * defaults (`shop: null`): a brand list is the shop's own — a pharmacy and a
 * cloth shop share no brands, and seeding either one's into the other is noise
 * on a form the shopkeeper uses forty times a day.
 *
 * Not branch-scoped either. A brand is catalogue vocabulary, like a category,
 * and products themselves are shop-scoped with per-branch stock — so scoping
 * the vocabulary per branch would mean the same brand typed twice for one shop.
 */
const brandSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  name: {
    type: String,
    required: [true, 'ব্র্যান্ডের নাম দিন'],
    trim: true,
    maxlength: [100, 'ব্র্যান্ডের নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  // Free text, and Bengali is fine here. A brand name is a display string that
  // never reaches a barcode — unlike `Product.code` and `variants.sku`, which
  // are CODE128 payloads and are ASCII-only for that reason.
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  order: {
    type: Number,
    default: 0
  },
  // Soft delete, matching Category. A brand with products on it is refused
  // outright by the service; this covers the rest.
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// The listing query: a shop's active brands in display order.
brandSchema.index({ shop: 1, isActive: 1, order: 1, name: 1 });

/**
 * One name per shop, case-insensitively.
 *
 * `Category`'s equivalent index is case-SENSITIVE, which lets "Square" and
 * "square" both exist and read as two brands on the picker. A collation makes
 * the uniqueness match how a person reads the list.
 *
 * Partial rather than sparse: the predicate keeps deactivated brands out of the
 * constraint, so a shop can re-create a brand it deleted earlier without
 * colliding with the soft-deleted row.
 */
brandSchema.index(
  { shop: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    collation: { locale: 'en', strength: 2 },
  }
);

const Brand = mongoose.model('Brand', brandSchema);

module.exports = Brand;

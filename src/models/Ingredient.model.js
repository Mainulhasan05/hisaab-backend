const mongoose = require('mongoose');
const { ALL_UNITS, DEFAULT_UNIT } = require('../config/units');

/**
 * কাঁচামাল — what a restaurant buys and cooks with (চাল, মাছ, তেল).
 *
 * ── Why this is NOT a Product ───────────────────────────────────────────────
 *
 * A Product is something the shop SELLS. Every screen that lists products — the
 * POS grid, the online shop, the product list, the stock and product reports,
 * combos, barcode lookup — assumes that. Putting চাল in the same collection
 * behind a flag would mean a "not this one" filter in every one of them, and
 * the first one missed puts raw rice on the till. A separate collection needs
 * no filter anywhere, because none of those screens ever reads it.
 *
 * The BILL is deliberately not separate: ingredients are bought on an ordinary
 * `Purchase`, whose line points here instead of at a Product (`items[].ingredient`).
 * Supplier dues, payments, the cash drawer and fund accounts are all bill-level
 * and read `Purchase` / `Payment` — a parallel purchase model would be money
 * none of them could see.
 *
 * Stock moves ONLY through `ingredient.service`, which writes an
 * `IngredientMovement` for every change. See CLAUDE.md §18.
 *
 * Branch-scoped like Product: each branch has its own store room.
 */
const ingredientSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  name: {
    type: String,
    required: [true, 'কাঁচামালের নাম দিন'],
    trim: true,
    maxlength: 120
  },
  /** A units.js key — কেজি, লিটার, পিস… Fractions follow the unit's decimals. */
  unit: {
    type: String,
    enum: ALL_UNITS,
    default: DEFAULT_UNIT
  },
  /** Quantity on hand, in `unit`. Re-rounded on every write (quantity.util). */
  stock: {
    type: Number,
    default: 0,
    min: [0, 'স্টক ০ এর কম হতে পারবে না']
  },
  /**
   * Weighted-average cost per `unit`, blended on every purchase — the same
   * rule costing.util applies to Product.buyingPrice. What a kitchen issue is
   * costed at, and therefore what reaches the P&L.
   */
  avgCost: {
    type: Number,
    default: 0,
    min: 0
  },
  /** Warn below this. */
  minStock: {
    type: Number,
    default: 0,
    min: 0
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
  timestamps: true
});

ingredientSchema.index({ shop: 1, branch: 1, isActive: 1, name: 1 });

module.exports = mongoose.model('Ingredient', ingredientSchema);

const mongoose = require('mongoose');

/**
 * The কাঁচামাল ledger — one row for every change to `Ingredient.stock`.
 *
 * The ledger, not the running figure, is the record: the stock screen can be
 * re-derived from it, and every number on the P&L's "কাঁচামাল খরচ" line is a
 * sum of `totalCost` over rows here.
 *
 *   opening          stock the owner typed in when adding the ingredient
 *   purchase         received on a Purchase bill            (+)
 *   purchase_cancel  that bill cancelled                    (−)
 *   consumption      রান্নাঘরে দেওয়া — costs the P&L         (−)
 *   waste            নষ্ট / পচে গেছে — costs the P&L          (−)
 *   adjustment       a correction of a data-entry mistake   (±) — NOT a cost
 *
 * Only `consumption` and `waste` reach the P&L (`COST_TYPES`). An adjustment
 * fixes a typo; charging it as food cost would make a mistyped opening stock
 * read as a day's cooking.
 */
const MOVEMENT_TYPES = Object.freeze([
  'opening', 'purchase', 'purchase_cancel', 'consumption', 'waste', 'adjustment',
]);
const COST_TYPES = Object.freeze(['consumption', 'waste']);

const ingredientMovementSchema = new mongoose.Schema({
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
  ingredient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ingredient',
    required: true
  },
  // Snapshots, like Sale.items[].productName: renaming চাল must not rewrite
  // what last month's ledger says was cooked.
  ingredientName: { type: String, required: true },
  unit: { type: String },
  type: {
    type: String,
    enum: MOVEMENT_TYPES,
    required: true
  },
  /** Signed: + in, − out. */
  quantity: { type: Number, required: true },
  previousStock: { type: Number },
  newStock: { type: Number },
  /** Per unit, at the moment of the movement (avgCost for an issue). */
  unitCost: { type: Number, default: 0 },
  /** Always ≥ 0 — the size of the money, not its direction. */
  totalCost: { type: Number, default: 0 },
  /**
   * The BUSINESS date — what day the rice was cooked, which the P&L keys on.
   * Separate from `createdAt` for the same reason Purchase.date is: a sheet
   * filled in the next morning belongs to yesterday.
   */
  date: { type: Date, required: true, default: Date.now },
  /** Groups the lines of one রান্নাঘরে দেওয়া sheet. */
  sheet: { type: mongoose.Schema.Types.ObjectId },
  reference: {
    type: { type: String, enum: ['purchase', null], default: null },
    id: { type: mongoose.Schema.Types.ObjectId },
    no: { type: String }
  },
  notes: { type: String, trim: true, maxlength: 300 },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

ingredientMovementSchema.index({ shop: 1, branch: 1, date: -1 });
ingredientMovementSchema.index({ shop: 1, ingredient: 1, createdAt: -1 });
ingredientMovementSchema.index({ shop: 1, branch: 1, type: 1, date: -1 });
ingredientMovementSchema.index({ shop: 1, 'reference.id': 1 });

const IngredientMovement = mongoose.model('IngredientMovement', ingredientMovementSchema);
IngredientMovement.MOVEMENT_TYPES = MOVEMENT_TYPES;
IngredientMovement.COST_TYPES = COST_TYPES;

module.exports = IngredientMovement;

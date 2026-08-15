const mongoose = require('mongoose');

const heldCartItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  productName: { type: String, required: true },
  productCode: { type: String },
  variantId: { type: mongoose.Schema.Types.ObjectId },
  variantSku: { type: String },
  variantAttributes: { type: mongoose.Schema.Types.Mixed },
  // ── Combo lines ─────────────────────────────────────────────────────────────
  //
  // A combo whose components leave the variant to the till carries the
  // cashier's picks. They MUST be stored: this schema is strict, so without
  // these fields a parked combo line would come back with its picks silently
  // gone — and the cashier who parked "লাল জামা" would be handed a cart that
  // either refuses to check out or, worse, is no longer the cart they parked.
  //
  // Nothing else about a held line changes: it is still one row, and the
  // expansion into component stock still happens server-side at sale time.
  itemType: { type: String, enum: ['standard', 'combo'], default: 'standard' },
  comboSelections: {
    type: [{
      comboItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
      variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
      // Display only, so a resumed cart renders without re-reading the product.
      variantSku: { type: String },
      variantAttributes: { type: mongoose.Schema.Types.Mixed },
    }],
    default: undefined
  },
  // 0-exclusive, not `min: 1` — a held cart may contain 0.25 kg. Held carts
  // store the quantity in the PRODUCT'S OWN UNIT, never a pack count, so a
  // resumed cart cannot be misread if anything about packaging changed while it
  // was parked. See AGENT_WORKFLOW.md I-6.
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  // The rate the cashier negotiated before parking the cart
  // (`features.lineDiscount`). Carried so a resumed cart shows the number that
  // was typed rather than one re-derived by division — the same reason
  // `Sale.items[].agreedUnitPrice` is stored; see the field note there.
  //
  // Held carts are a DRAFT: none of the gates run here, because nothing has
  // been sold. `createSale` re-resolves this line rate from scratch at
  // checkout, so a cart parked before the capability was switched off simply
  // fails to check out at the negotiated price — it does not sneak past.
  agreedUnitPrice: { type: Number, min: 0 }
}, { _id: true });

const heldCartSchema = new mongoose.Schema({
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
  items: {
    type: [heldCartItemSchema],
    required: true,
    validate: [arr => arr.length > 0, 'কমপক্ষে একটি পণ্য থাকতে হবে']
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: { type: String },
  customerPhone: { type: String },
  discount: { type: Number, default: 0 },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage'],
    default: 'fixed'
  },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  notes: { type: String, maxlength: 500 },
  label: { type: String, maxlength: 100 }, // Quick identifier like "Table 3" or customer name
  heldBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['held', 'converted', 'expired', 'discarded'],
    default: 'held'
  },
  convertedSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
heldCartSchema.index({ shop: 1, branch: 1, status: 1, createdAt: -1 });
heldCartSchema.index({ shop: 1, expiresAt: 1, status: 1 });

// Virtual: item count
heldCartSchema.virtual('itemCount').get(function() {
  return this.items ? this.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
});

// Virtual: estimated total
heldCartSchema.virtual('estimatedTotal').get(function() {
  if (!this.items) return 0;
  const subtotal = this.items.reduce((sum, item) => sum + (item.unitPrice * item.quantity - item.discount), 0);
  let discountAmount = this.discount || 0;
  if (this.discountType === 'percentage') {
    discountAmount = (subtotal * this.discount) / 100;
  }
  const delivery = this.deliveryCharge || 0;
  return Math.max(0, subtotal - discountAmount + delivery);
});

const HeldCart = mongoose.model('HeldCart', heldCartSchema);

module.exports = HeldCart;

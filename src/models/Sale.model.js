const mongoose = require('mongoose');
const { PAYMENT_METHODS, SALE_STATUS } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { quantizeMoney } = require('../utils/quantity.util');

const saleItemSchema = new mongoose.Schema({
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
  variantSku: {
    type: String
  },
  variantAttributes: {
    type: mongoose.Schema.Types.Mixed
  },
  // Lower bound is 0-exclusive rather than 1: a 250-gram sale is `quantity: 0.25`
  // for a kg product. `min: 1` here would reject it AFTER the stock had already
  // been deducted by the bulkWrite above, leaving stock down and no sale
  // recorded.
  //
  // This does NOT let a shop without `features.packaging` book a fraction —
  // `parseQuantity` has already refused it at the service layer, where the flag
  // and the product's unit are both known. Schema bounds are the floor, not the
  // policy. See AGENT_WORKFLOW.md I-6.
  quantity: {
    type: Number,
    required: [true, 'পরিমাণ দিন'],
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  // ── The unit snapshot ──────────────────────────────────────────────────────
  //
  // `unit` is the product's base unit AS IT WAS when the sale was rung up, and
  // it is what `quantity` above is expressed in.
  //
  // The invoice used to read `item.product.unit` live, through the populate.
  // That is a rewriting-history bug: a shopkeeper who corrects a product from
  // পিস to কেজি changes the unit printed on every invoice that product ever
  // appeared on, including ones already handed to a customer. Denormalised for
  // the same reason `productName` and `unitPrice` are.
  //
  // Absent on every sale written before this field existed. Readers must fall
  // back — `item.unit || item.product?.unit || 'piece'` — never assume it.
  unit: {
    type: String
  },
  // How the customer BOUGHT it. 'base' (or absent) = loose, in `unit`.
  // 'pack' = whole packs, and the three fields below say which pack and how
  // many. `quantity` is still in the base unit either way, so every stock
  // guard, report and profit sum downstream is untouched by this.
  saleUnit: {
    type: String,
    enum: ['base', 'pack'],
    default: 'base'
  },
  packUnit: {
    type: String
  },
  // Base units per pack at the time of sale. Snapshotted, not looked up: a
  // supplier moving from 20-per-carton to 24 must not silently restate an old
  // invoice's "৫ কার্টন" as 120 pieces when the customer paid for 100.
  packSize: {
    type: Number,
    min: [0.001, 'প্রতি মোড়কে পরিমাণ ০ এর বেশি হতে হবে']
  },
  packQuantity: {
    type: Number,
    min: [0.001, 'পরিমাণ ০ এর বেশি হতে হবে']
  },
  // Per-BASE-unit price, always — including on a pack line, where it is
  // `packPrice / packSize`. Keeping one meaning for this field is what lets
  // every existing report, CSV export and profit calculation stay unaware that
  // packs exist. The pack's own price is `packUnitPrice` below, for display.
  unitPrice: {
    type: Number,
    required: [true, 'একক মূল্য দিন'],
    min: [0, 'মূল্য ০ এর কম হতে পারবে না']
  },
  // Price of one whole pack, on a pack line. Display-only — nothing sums it.
  packUnitPrice: {
    type: Number,
    min: [0, 'মূল্য ০ এর কম হতে পারবে না']
  },
  buyingPrice: {
    type: Number,
    min: [0, 'ক্রয় মূল্য ০ এর কম হতে পারবে না']
  },
  discount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true
  },
  // ── Combo lines ────────────────────────────────────────────────────────────
  //
  // 'combo' = this line is a bundle whose stock went out of the COMPONENT
  // products, one guarded op each; the combo product itself moved no stock.
  // Absent (i.e. 'standard') on every line written before combos existed.
  itemType: {
    type: String,
    enum: ['standard', 'combo'],
    default: 'standard'
  },
  // The sale-time freeze of what one combo contained — names, variants,
  // quantities and unit costs AS SOLD. This is the array `cancelSale` and the
  // returns path restore stock from, which is exactly why it is a snapshot and
  // not a lookup: editing or deleting the combo (or a component) later must
  // never change what this sale can undo. Same denormalisation rule as
  // `productName` / `unit` / `packSize` above.
  //
  // `unitCost` is per base unit of the COMPONENT at sale time; the line's own
  // `buyingPrice` is the per-combo sum of these, which is what keeps the
  // pre('save') profit arithmetic below untouched.
  comboComponents: {
    type: [{
      product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      // Which slot of the combo definition this row served. Traceability only
      // — nothing restores through it, so a slot deleted from the combo later
      // leaves this sale entirely intact. Absent on lines sold before the
      // cashier could choose a variant.
      comboItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
      productName: { type: String, required: true },
      productCode: { type: String },
      // The variant AS SOLD. Under a 'choose' slot this is what the cashier
      // picked at the till, which is the only record of it — the combo
      // definition never knew.
      variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
      variantSku: { type: String },
      variantAttributes: { type: mongoose.Schema.Types.Mixed },
      unit: { type: String },
      // Base units of this component in ONE combo…
      quantityPerCombo: { type: Number, required: true, min: 0.001 },
      // …and across the whole line (quantityPerCombo × line quantity) — the
      // figure the stock guard deducted and a cancel puts back.
      totalQuantity: { type: Number, required: true, min: 0.001 },
      unitCost: { type: Number, default: 0, min: 0 },
    }],
    default: undefined
  }
}, { _id: true });

const saleSchema = new mongoose.Schema({
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
    required: [true, 'ইনভয়েস নম্বর দিন']
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: {
    type: String,
    default: 'Walk-in Customer'
  },
  customerPhone: {
    type: String
  },
  items: {
    type: [saleItemSchema],
    required: [true, 'পণ্য যোগ করুন'],
    validate: [arr => arr.length > 0, 'অন্তত একটি পণ্য যোগ করুন']
  },
  // Which price list this invoice was rung up against. A snapshot, like
  // `customerName` and `item.unit` — a customer promoted to wholesale next
  // month must not restate the invoices they were charged retail on.
  //
  // 'wholesale' does NOT mean every line got a wholesale rate: a product with
  // no `wholesalePrice` falls back to retail on an otherwise-wholesale invoice.
  // It means "the wholesale list was applied", which is the question the
  // invoice, the sales list filter and the reports actually ask.
  //
  // Absent on every sale written before this field existed; readers fall back
  // to 'retail', which is what those sales were.
  priceTier: {
    type: String,
    enum: ['retail', 'wholesale'],
    default: 'retail'
  },
  subtotal: {
    type: Number,
    required: true,
    min: [0, 'সাবটোটাল ০ এর কম হতে পারবে না']
  },
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
  tax: {
    type: Number,
    default: 0,
    min: [0, 'ট্যাক্স ০ এর কম হতে পারবে না']
  },
  total: {
    type: Number,
    required: true,
    min: [0, 'মোট ০ এর কম হতে পারবে না']
  },
  paid: {
    type: Number,
    default: 0,
    min: [0, 'পরিশোধিত ০ এর কম হতে পারবে না']
  },
  due: {
    type: Number,
    default: 0,
    min: [0, 'বাকি ০ এর কম হতে পারবে না']
  },
  profit: {
    type: Number,
    default: 0
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS),
    default: PAYMENT_METHODS.CASH
  },
  // Split payment support: array of payment method + amount pairs
  payments: [{
    method: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      required: true
    },
    amount: {
      type: Number,
      required: true,
      min: [0, 'পেমেন্ট ০ এর কম হতে পারবে না']
    },
    reference: {
      type: String // MFS transaction ID, card auth code, etc.
    }
  }],
  status: {
    type: String,
    enum: Object.values(SALE_STATUS),
    default: SALE_STATUS.COMPLETED
  },
  notes: {
    type: String,
    maxlength: [500, 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  cancelledAt: {
    type: Date
  },
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelReason: {
    type: String
  },
  // ── Return tracking ────────────────────────────────────────────────────────
  //
  // Three accumulators, all `$inc`-ed by the returns path. They exist as STORED
  // fields rather than as a live join because `pre('save')` below has to derive
  // `due` and `profit` from them, and a hook cannot go to the database.
  //
  // Before they existed, the returns path wrote `due`/`profit` with `updateOne`
  // specifically to bypass this hook — and any OTHER save of the document
  // (recordPayment, cancelSale) silently recomputed both from `items` and threw
  // the return away. Collecting the rest of a due on a partly-returned invoice
  // restored the money the return had just taken off it.
  //
  // The rule now: these three are the only inputs the hook needs, and every
  // figure it derives is a pure function of the document. Saving twice changes
  // nothing.
  returnedAmount: {
    type: Number,
    default: 0,
    min: [0, 'ফেরত ০ এর কম হতে পারবে না']
  },
  // The part of `returnedAmount` that was settled AGAINST THE DUE rather than
  // paid back in cash — i.e. `refundMethod: 'adjustment'`. A cash refund hands
  // money back and leaves the obligation alone, so it must not appear here.
  returnedAdjustment: {
    type: Number,
    default: 0,
    min: [0, 'সমন্বয় ০ এর কম হতে পারবে না']
  },
  // Accumulated `SalesReturn.profitReduction`. Subtracted from the item-derived
  // profit below, so a returned line stops counting as earnings.
  returnedProfit: {
    type: Number,
    default: 0
  },
  // Online sale tracking & logistics
  isOnline: {
    type: Boolean,
    default: false
  },
  channel: {
    type: String,
    enum: ['pos', 'facebook', 'instagram', 'whatsapp', 'website', 'other'],
    default: 'pos'
  },
  deliveryCharge: {
    type: Number,
    default: 0,
    min: [0, 'ডেলিভারি চার্জ ০ এর কম হতে পারবে না']
  },
  /**
   * Money taken UP FRONT on a parcel order, before the goods ship — the MFS
   * transfer a shop asks for to cover delivery on a COD parcel.
   *
   * RESERVED, and currently always 0. It is not `paid` by another name: `paid`
   * is what has been settled against the invoice, and on a COD sale that stays 0
   * until the courier remits. The till used to send `advancePaid = paid` for
   * every online sale, which made it a verbatim duplicate that nothing read —
   * removed, because a populated field that means nothing is worse than an empty
   * one for whoever builds checkout (ECOMMERCE_PLAN.md §13).
   */
  advancePaid: {
    type: Number,
    default: 0,
    min: [0, 'এডভান্স পরিশোধ ০ এর কম হতে পারবে না']
  },
  courierName: {
    type: String
  },
  shippingAddress: {
    type: String
  },
  smsSent: {
    type: Boolean,
    default: false
  },
  smsSentAt: {
    type: Date
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
saleSchema.index({ shop: 1, invoiceNo: 1 }, { unique: true }); // Invoice lookup
saleSchema.index({ shop: 1, customer: 1, createdAt: -1 }); // Customer purchase history
saleSchema.index({ shop: 1, branch: 1, createdAt: -1 }); // Main listing with branch filter
saleSchema.index({ shop: 1, branch: 1, status: 1, createdAt: -1 }); // Due/pending sales with branch
saleSchema.index({ shop: 1, isOnline: 1, createdAt: -1 }); // Online sales filter index
saleSchema.index({ shop: 1, createdAt: -1 }); // Single-branch listing, recent sales, invoice-number day count
saleSchema.index({ shop: 1, due: 1 }); // Dues listing/sort
saleSchema.index({ shop: 1, total: -1 }); // Sort by amount (whitelisted sort field)
saleSchema.index({ shop: 1, createdBy: 1, createdAt: -1 }); // Staff attribution filter + staff sales report
// Cross-shop, admin-only. Every index above is shop-prefixed, which is correct
// for the shop app — but the operator console has no shop predicate by
// definition: the dashboard's recent-sales feed and GET /api/admin/sales both
// sort the whole collection by date. Without this they are a COLLSCAN plus an
// in-memory sort, which is fine at 10k documents and is not at 10M.
// Never used by a shop-scoped query: the planner prefers the compound indexes
// there because they satisfy the equality on `shop` as well as the sort.
saleSchema.index({ createdAt: -1 });

// Calculate totals before saving
saleSchema.pre('save', function(next) {
  // Calculate subtotal from items
  this.subtotal = this.items.reduce((sum, item) => sum + item.total, 0);

  // Calculate total
  let discountAmount = this.discount;
  if (this.discountType === 'percentage') {
    discountAmount = (this.subtotal * this.discount) / 100;
  }

  const delivery = this.deliveryCharge || 0;
  this.total = Math.min(Math.max(0, this.subtotal - discountAmount + this.tax + delivery), 1e11);
  if (!Number.isFinite(this.paid) || this.paid > this.total) {
    this.paid = Math.min(Math.max(0, this.paid || 0), this.total);
  }

  // `due` and `profit` both carry the returns terms, so that saving the document
  // for an unrelated reason cannot undo a return. See the accumulator block on
  // the schema above for why they are stored fields.
  //
  // Only `returnedAdjustment` reduces the due — a return refunded in CASH hands
  // the money back and leaves the obligation exactly where it was. Zeroing the
  // due on any full return (which is what this used to do) wrote off debt with
  // no counterpart on the customer's ledger: a ৳1000 invoice with ৳300 paid,
  // fully refunded in cash, paid out ৳1000, read as settled, and left the
  // customer still owing ৳700 in `Customer.totalDue` with nothing on the
  // invoice to explain it.
  this.due = Math.max(0, this.total - this.paid - (this.returnedAdjustment || 0));

  // Calculate profit, net of anything returned.
  const itemsProfit = this.items.reduce((sum, item) => {
    const itemProfit = (item.unitPrice - (item.buyingPrice || 0)) * item.quantity - item.discount;
    return sum + itemProfit;
  }, 0);
  this.profit = quantizeMoney(itemsProfit - discountAmount - (this.returnedProfit || 0));

  // Set payment status unless the sale has been explicitly cancelled.
  if (this.status !== SALE_STATUS.CANCELLED) {
    if (this.due === 0) {
      this.status = SALE_STATUS.COMPLETED;
    } else if (this.paid > 0) {
      this.status = SALE_STATUS.PARTIAL;
    } else {
      this.status = SALE_STATUS.UNPAID;
    }
  }

  next();
});

// Virtual: Item count
saleSchema.virtual('itemCount').get(function() {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

// Virtual: Is paid
saleSchema.virtual('isPaid').get(function() {
  return this.due === 0;
});

// Virtual: Is cancelled
saleSchema.virtual('isCancelled').get(function() {
  return this.status === SALE_STATUS.CANCELLED;
});

// Virtual: Has returns
saleSchema.virtual('hasReturns').get(function() {
  return (this.returnedAmount || 0) > 0;
});

// Virtual: Net total (after returns)
saleSchema.virtual('netTotal').get(function() {
  return this.total - (this.returnedAmount || 0);
});

/* ───────────────────────────────────────────────────────────────────────────
 * REMOVED: generateInvoiceNo / getSalesSummary / addPayment / cancelSale
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Four dead members, deleted rather than left as reference, because each had
 * drifted into disagreeing with the code that actually runs — and a plausible
 * helper sitting on the model is an invitation to call it.
 *
 *   generateInvoiceNo  Superseded by InvoiceCounter (see that model's header
 *                      for the race it fixes). It had also gone stale: it
 *                      matched `^INV<YYYYMMDD>`, while live invoice numbers are
 *                      `INV-<branch>-<date>-<seq>`, so its "last sale" lookup
 *                      found nothing and it restarted at 0001 every call.
 *
 *   getSalesSummary    Summed raw `$total`, contradicting saleService's summary
 *                      which sums NET of `returnedAmount`. Two "sales totals"
 *                      that disagree by the value of every return.
 *
 *   addPayment         Duplicated saleService.recordPayment minus the Payment
 *                      row, the customer ledger and the audit entry.
 *
 *   cancelSale         Marked a sale cancelled and saved — no stock restored,
 *                      no batches, no customer balance unwound. The service
 *                      method of the same name does all four.
 * ─────────────────────────────────────────────────────────────────────────── */

// Apply immutable ledger guard — prevents hard deletion of sale records
saleSchema.plugin(immutableGuard, { modelName: 'Sale' });

const Sale = mongoose.model('Sale', saleSchema);

module.exports = Sale;

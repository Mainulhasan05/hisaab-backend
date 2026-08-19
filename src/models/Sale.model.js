const mongoose = require('mongoose');
const { PAYMENT_METHODS, SALE_STATUS } = require('../config/constants');
const { immutableGuard } = require('../utils/immutableGuard.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { computeInvoiceTotals, statusFor } = require('../utils/invoiceMath.util');

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
  /**
   * The rate the cashier and the customer AGREED on this line, per base unit,
   * when it is not the list rate. Absent on every ordinary line — and on every
   * line written before `features.lineDiscount` existed.
   *
   * DISPLAY-ONLY. Nothing sums it, nothing prices from it. `unitPrice` above is
   * still the list/tier rate and `discount` below is still the concession in
   * taka, so profit, subtotal, returns, reports and every export stay unaware
   * this field exists. Same rule as `packUnitPrice` — and the same reason: a
   * second meaning for `unitPrice` would need every reader changed at once.
   *
   * Stored rather than re-derived as `unitPrice - discount / quantity` because
   * that division does not round-trip once a paisa rate meets a fractional
   * quantity — ordinary with `features.packaging`. 750 g agreed at ৳৯০.৫০ off a
   * ৳১০০ list is a ৳7.125 concession, quantized to ৳7.13 like every other money
   * figure here, and divided back out that reads ৳৯০.৪৯. Printing a rate the
   * customer never agreed to, on the invoice they are holding, is what this
   * prevents.
   *
   * Derived and gated ONLY by `utils/lineDiscount.util.resolveLineRate`. Never
   * write it from anywhere else — it and `discount` must agree, and one writer
   * is what guarantees they do.
   */
  agreedUnitPrice: {
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
  /**
   * The invoice discount in TAKA, resolved from `discount` + `discountType` and
   * bounded to the subtotal. Derived by `pre('save')`, never sent by a client.
   *
   * ── Why this is stored rather than re-derived ──────────────────────────────
   *
   * `discount` alone is ambiguous: on a percentage invoice it holds "10", and
   * every reader that treated it as money was wrong. `report.service` summed it
   * straight — `$sum: '$discount'` — so a month of 10% discounts contributed ৳10
   * each to "total discount given" regardless of the invoice size, and the
   * figure was meaningless for any shop that discounts by percentage.
   *
   * Re-deriving it per reader is what let the sales-return path and the model
   * drift apart in the first place. One derivation, stored once.
   *
   * Absent on sales written before this field existed; readers that need it for
   * history should fall back through `invoiceMath.discountAmountFor`.
   */
  discountAmount: {
    type: Number,
    default: 0,
    min: [0, 'ছাড় ০ এর কম হতে পারবে না']
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
  // ── The খাতা, as it stood at this checkout ────────────────────────────────
  //
  // Both are SNAPSHOTS, for the same reason `items[].unit` and
  // `items[].productName` are, and the invoice is why they had to exist.
  //
  // The printed A4 invoice has always carried a "পূর্বের বাকি / বর্তমান বাকি /
  // টোটাল বাকি" block, and it derived the first figure LIVE:
  // `customer.totalDue - sale.due`. That is a rewriting-history bug of exactly
  // the kind the unit snapshot exists to prevent — reprint an invoice a month
  // later, after the customer has bought twice more and paid once, and the
  // "পূর্বের বাকি" on the reprint disagrees with the copy in the customer's
  // hand. Nothing was wrong at the moment of printing, so nobody ever caught it.
  //
  // Settling a due at checkout made that bug impossible to live with rather
  // than merely wrong: with the old debt cleared, the live derivation prints
  // পূর্বের বাকি ৳0 and the receipt silently denies the ৳2,200 the customer
  // just handed over.
  //
  // Absent on every sale written before these existed, so readers MUST fall
  // back to the live derivation for history. `previousDue: 0` and
  // `previousDue: undefined` are different answers — the first is a customer
  // who owed nothing, the second is a sale from before we recorded it.

  /** The customer's due immediately BEFORE this sale, in whichever book the
   *  shop keeps (branch figure under separate books, shop-wide under shared).
   *  Null for a walk-in with no customer record. */
  previousDue: {
    type: Number,
    default: undefined,
    min: [0, 'আগের বাকি ০ এর কম হতে পারবে না']
  },
  /** How much of `previousDue` was cleared by surplus tendered at THIS
   *  checkout. The money itself is a `Payment{type:'due_collection'}` row
   *  carrying `viaSale`, never part of `paid` below — see that field's note
   *  on why the two must not be merged. */
  dueSettled: {
    type: Number,
    default: 0,
    min: [0, 'জমা ০ এর কম হতে পারবে না']
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
    },
    /**
     * Which PaymentAccount this leg's money went INTO.
     *
     * Per LEG, not per invoice, and that is the whole point: a ৳400 cash +
     * ৳600 bKash sale puts ৳400 in the drawer and ৳600 in a bKash number, and
     * an invoice-level field could only ever name one of them. `Sale.payments[]`
     * has always been the only place the split truth lives — this is what
     * finally connects it to a balance.
     *
     * Null for every sale written before this field existed and for every shop
     * without `features.fundAccounts`, so nothing may read it without falling
     * back to `method`. I-1: a flag-off shop's POS never sends the key.
     */
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentAccount',
      default: null
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
  // ── Revision chain ─────────────────────────────────────────────────────────
  //
  // A revision does not edit this document. It cancels it and writes a NEW one
  // that inherits its invoice number, because everything downstream of a sale
  // is append-only or delta-based and cannot be rewritten in place:
  // `StockTransaction` stores previousStock/newStock snapshots, FEFO consumed
  // specific expiry batches, `CustomerBalance.applyDelta` is a running delta,
  // and `salesReturn` allocates refunds proportionally against the ORIGINAL
  // line values. See SALE_REVISION_PLAN.md §2.1.
  //
  // `SALE_STATUS` deliberately gains no `superseded` member. A superseded sale
  // IS cancelled — that is exactly what happened to it — and `cancelReason:
  // 'revised'` plus `revisedTo` say why. Adding a status would mean auditing
  // every `status: 'cancelled'` query in the codebase for whether it meant to
  // include supersessions.
  //
  // All three are absent on every ordinary sale and on every sale written
  // before this existed, so there is no migration: readers fall back.

  /** On a SUPERSEDED document: the revision that replaced it and now carries
   *  this document's invoice number. */
  revisedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  /** On a REVISION: the document it replaced. */
  revisedFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  /** Counts from 1, so the third version of an invoice reads 2. */
  revision: {
    type: Number,
    default: 0
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
  /**
   * How much of this invoice's due was cleared by money collected against the
   * customer's খাতা rather than against this invoice by name.
   *
   * ── The bug this field exists to end ──────────────────────────────────────
   *
   * There are two ways a shop takes money off a receivable, and until this
   * field only one of them was honest about it:
   *
   *   - `recordPayment` — "৳2,000 against invoice HFG202600403". Moves
   *     `paid`, re-derives `due` and `status`. Correct, always was.
   *   - `dueSettlement.settleCustomerDue` — বাকি আদায় on the customer page, and
   *     the surplus settled at a later checkout. Moved `Customer.totalDue` and
   *     the `CustomerBalance` rows and wrote a `Payment{due_collection}` row,
   *     and touched NO invoice at all.
   *
   * So the customer's page read ৳0 owed while the invoice that created the
   * debt sat at `due: 4200, status: 'partial'` forever. That is not cosmetic:
   * ten aggregations across `report.service`, `staffReport.service` and
   * `sale.service` sum `$due` as "মোট বাকি", and every one of them kept
   * counting money the shop had already collected and banked.
   *
   * ── Why a separate term and not `paid` ────────────────────────────────────
   *
   * `paid` means "tendered at or against THIS invoice", and `cancelSale`
   * unwinds precisely `-sale.paid` from the customer's ledger. A khata
   * collection folded into `paid` would therefore be clawed back off the
   * customer when the invoice it happened to land on was cancelled — money
   * they really did hand over, with the `due_collection` row still sitting
   * there to prove it. `returnedAdjustment` is a separate term for the same
   * reason and this sits beside it: `due = total − paid − returnedAdjustment
   * − ledgerSettled`.
   *
   * ── Why it is DERIVED, never `$inc`-ed ────────────────────────────────────
   *
   * This is an ALLOCATION, not an event. Both sides of it move on their own:
   * collections arrive, invoices get cancelled, revised, returned against.
   * Incremental deltas across four services would drift exactly the way the
   * two collection paths above drifted. So it is recomputed from scratch —
   * `Σ due_collection` spread over the customer's open invoices oldest-first —
   * by `dueSettlement.reallocateCustomerInvoices`, which is idempotent and
   * therefore self-healing: any invoice it touches ends up right regardless of
   * what it was before. Nothing else may write this field.
   */
  ledgerSettled: {
    type: Number,
    default: 0,
    min: [0, 'খাতা সমন্বয় ০ এর কম হতে পারবে না']
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

// Calculate totals before saving.
//
// Every figure here comes out of `invoiceMath.computeInvoiceTotals`, which
// `sale.service.createSale` also calls before it writes the customer ledger.
// That sharing is the point: this hook and the service used to compute `total`,
// `paid`, `due` and `status` separately and disagree on overpayments, on
// discounts larger than the bill, and on any non-numeric `tax` — so the invoice
// and `Customer.totalDue` drifted apart on ordinary checkouts. See the header of
// invoiceMath.util.js for the three cases.
saleSchema.pre('save', function(next) {
  const totals = computeInvoiceTotals({
    subtotal: this.items.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
    discount: this.discount,
    discountType: this.discountType,
    tax: this.tax,
    deliveryCharge: this.deliveryCharge,
    paid: this.paid,
    // `due` and `profit` both carry the returns terms, so that saving the
    // document for an unrelated reason cannot undo a return. See the
    // accumulator block on the schema above for why they are stored fields.
    //
    // Only `returnedAdjustment` reduces the due — a return refunded in CASH
    // hands the money back and leaves the obligation exactly where it was.
    // Zeroing the due on any full return (which is what this used to do) wrote
    // off debt with no counterpart on the customer's ledger: a ৳1000 invoice
    // with ৳300 paid, fully refunded in cash, paid out ৳1000, read as settled,
    // and left the customer still owing ৳700 in `Customer.totalDue` with
    // nothing on the invoice to explain it.
    returnedAdjustment: this.returnedAdjustment,
    // Money collected against the customer's খাতা and allocated here by
    // `dueSettlement.reallocateCustomerInvoices`. Carried through the hook for
    // the same reason `returnedAdjustment` is: saving this document for an
    // unrelated reason must not silently re-open a due that has been paid.
    ledgerSettled: this.ledgerSettled,
  });

  this.subtotal = totals.subtotal;
  this.discountAmount = totals.discountAmount;
  this.tax = totals.tax;
  this.deliveryCharge = totals.deliveryCharge;
  this.total = totals.total;
  this.paid = totals.paid;
  // Written back from the clamp, not left as sent. If a return has since eaten
  // into what this invoice can absorb, the stored allocation is stale and the
  // reallocator will move the excess to another invoice on its next pass — but
  // until it does, the figure on the document must not exceed what it covers.
  this.ledgerSettled = totals.ledgerSettled;
  this.due = totals.due;

  // Calculate profit, net of anything returned. Quantized per line before
  // summing, for the same reason the invoice figures are: an unrounded product
  // of a fractional quantity and a paisa price propagates into every profit
  // report downstream.
  const itemsProfit = this.items.reduce((sum, item) => {
    const lineProfit = quantizeMoney(
      ((Number(item.unitPrice) || 0) - (Number(item.buyingPrice) || 0)) * (Number(item.quantity) || 0)
        - (Number(item.discount) || 0)
    );
    return quantizeMoney(sum + lineProfit);
  }, 0);
  this.profit = quantizeMoney(itemsProfit - totals.discountAmount - (this.returnedProfit || 0));

  // Set payment status unless the sale has been explicitly cancelled. `settled`
  // carries the two non-tendered reductions, so an invoice brought partway down
  // by বাকি আদায় reads 'partial' rather than 'unpaid'.
  this.status = statusFor({
    due: this.due,
    paid: this.paid,
    settled: quantizeMoney((this.ledgerSettled || 0) + (this.returnedAdjustment || 0)),
    current: this.status,
  });

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

const Joi = require('joi');
const { PAYMENT_METHODS } = require('../config/constants');

/**
 * Sale payload validation — the schema that was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `POST /api/sales` carried no schema at all. Every guard on the way in was
 * whatever `createSale` happened to check for its own reasons, which is how
 * `items[].discount` reached the invoice as a raw client number: uncoerced,
 * uncapped, unauthorised. A cashier with the network tab open could post
 * `discount: 99999` on a ৳500 line, drive the line total negative, and drag
 * `subtotal`, `total`, `profit` and the customer's ledger down with it.
 *
 * `invoiceMath.toMoney` and the line-value clamp in `createSale` are the LAST
 * line of defence and they stay. This is the first one: refuse the payload
 * rather than silently repair it, so a client sending nonsense finds out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRAP: `validate` STRIPS UNKNOWN KEYS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `validate.middleware` runs Joi with `stripUnknown: true` and REPLACES
 * `req.body` with the result. So a field this schema forgets is not merely
 * unvalidated — it is deleted before the service ever sees it, silently, and
 * the feature that depended on it stops working with no error anywhere.
 *
 * Every key below is therefore listed on purpose, including the ones the server
 * deliberately ignores. `unitPrice`, `subtotal`, `total` and `due` are exactly
 * that: the POS sends its own working so the two can be compared in a bug
 * report, and `createSale` re-derives all four from the product catalogue and
 * `invoiceMath`. They are accepted and dropped on the floor, which is not the
 * same as being rejected — rejecting them would break every till in the field.
 *
 * Two payload shapes must both pass:
 *   1. the live POS          (sales/new/page.js, ~line 1113)
 *   2. the offline re-sync   (lib/syncManager.js, ~line 186) — the same body
 *                            minus its IndexedDB bookkeeping keys
 *
 * Before adding a field to either client, add it here first.
 */

/** An id may arrive as a hex string, or as a populated object from a resumed
 *  held cart. `extractProductId` in the service unwraps both; refusing the
 *  object shape here would break cart resume. */
const idLike = Joi.alternatives().try(
  Joi.string().trim().allow('', null),
  Joi.object().unknown(true)
);

/** Ceiling on any money figure, matching `invoiceMath.MAX_INVOICE_AMOUNT`. */
const MAX_MONEY = 1e11;

const money = Joi.number().min(0).max(MAX_MONEY).messages({
  'number.base': 'একটি সংখ্যা হতে হবে',
  'number.min': 'ঋণাত্মক টাকার অঙ্ক দেওয়া যাবে না',
  'number.max': 'টাকার অঙ্কটি অস্বাভাবিক বড়',
});

const comboSelection = Joi.object({
  comboItemId: Joi.string().trim().required().messages({
    'any.required': 'কম্বোর কোন অংশ তা নির্দিষ্ট করুন',
  }),
  variantId: Joi.string().trim().allow('', null),
  variantSku: Joi.string().trim().allow('', null),
  variantAttributes: Joi.any(),
});

const saleItem = Joi.object({
  // One of these two must resolve to a product. The service's `extractProductId`
  // reads `productId || product`; requiring both here would reject the held-cart
  // shape, and requiring neither would let an item with no product reach a
  // `productMap.get(undefined)`.
  productId: idLike,
  product: idLike,
  productName: Joi.string().trim().max(200).allow('', null),

  variantId: Joi.string().trim().allow('', null),
  variantSku: Joi.string().trim().allow('', null),
  variantAttributes: Joi.any(),

  // Lower bound is 0-exclusive, not 1 — a 250-gram line is `quantity: 0.25` for
  // a kg product. Whether a FRACTION is allowed at all is a per-shop question
  // (`features.packaging`) that only `parseQuantity` can answer, because it
  // needs the product's unit. Schema bounds are the floor, not the policy.
  quantity: Joi.number().greater(0).max(1e9).required().messages({
    'number.base': 'পরিমাণ একটি সংখ্যা হতে হবে',
    'number.greater': 'পরিমাণ ০ এর বেশি হতে হবে',
    'any.required': 'পরিমাণ দিন',
  }),

  // Accepted and ignored — the server prices every line from the catalogue.
  // See the header.
  unitPrice: money,
  total: Joi.number().min(-MAX_MONEY).max(MAX_MONEY),

  // Bounded again in `createSale` against the line's own value, which is the
  // check this one cannot make (it does not know the price).
  //
  // Ignored entirely on a line that names an `agreedUnitPrice` — the rate wins,
  // and a payload that could name both would be believed about the wrong one.
  discount: money,

  // The negotiated rate, per base unit (`features.lineDiscount`). Every real
  // gate — the capability, the `sales.discount` permission, the below-cost
  // floor, the shop's cap, the "not above list" rule — lives in
  // `lineDiscount.util.resolveLineRate`, because none of them can be answered
  // without the product's list price and the shop's settings. This is only the
  // shape check.
  agreedUnitPrice: money,

  saleUnit: Joi.string().valid('base', 'pack'),
  packQuantity: Joi.number().greater(0).max(1e9),
  itemType: Joi.string().valid('standard', 'combo'),
  comboSelections: Joi.array().items(comboSelection).max(50),
})
  // "At least one of productId / product is present." `.or()` and not
  // `.xor()`: the POS sends `productId` alone, a resumed held cart can carry
  // both, and refusing that combination would break resume.
  .or('productId', 'product')
  .messages({
    'object.missing': 'পণ্য নির্বাচন করুন',
  });

const payment = Joi.object({
  method: Joi.string().valid(...Object.values(PAYMENT_METHODS)).required().messages({
    'any.only': 'পেমেন্ট পদ্ধতি সঠিক নয়',
    'any.required': 'পেমেন্ট পদ্ধতি নির্বাচন করুন',
  }),
  amount: money.required().messages({ 'any.required': 'পেমেন্টের পরিমাণ দিন' }),
  reference: Joi.string().trim().max(100).allow('', null),
});

const createSale = Joi.object({
  items: Joi.array().items(saleItem).min(1).max(500).required().messages({
    'array.min': 'অন্তত একটি পণ্য যোগ করুন',
    'array.max': 'একটি বিক্রয়ে সর্বোচ্চ ৫০০টি পণ্য দেওয়া যাবে',
    'any.required': 'পণ্য যোগ করুন',
  }),

  // `customerId` and `customer` are the same field under two names — the
  // service reads `customerId || customer`. Both are accepted for the same
  // reason `productId`/`product` are.
  customerId: idLike,
  customer: idLike,
  customerName: Joi.string().trim().max(100).allow('', null),
  customerPhone: Joi.string().trim().max(20).allow('', null),

  // Invoice-level discount. `discount` holds "10" on a percentage invoice, so
  // it is NOT bounded to a money ceiling here — `discountAmountFor` bounds it
  // to 100% or to the subtotal, whichever axis applies.
  discount: Joi.number().min(0).max(MAX_MONEY),
  discountType: Joi.string().valid('fixed', 'percentage'),
  tax: money,

  // Accepted and ignored — recomputed by `computeInvoiceTotals`.
  subtotal: money,
  total: money,
  due: money,

  paid: money,
  paymentMethod: Joi.string().valid(...Object.values(PAYMENT_METHODS)),
  payments: Joi.array().items(payment).max(10),

  notes: Joi.string().trim().max(500).allow('', null).messages({
    'string.max': 'নোট ৫০০ অক্ষরের বেশি হতে পারবে না',
  }),
  sendSms: Joi.boolean(),

  isOnline: Joi.boolean(),
  channel: Joi.string().valid('pos', 'facebook', 'instagram', 'whatsapp', 'website', 'other'),
  deliveryCharge: money,
  advancePaid: money,
  courierName: Joi.string().trim().max(100).allow('', null),
  shippingAddress: Joi.string().trim().max(500).allow('', null),

  /**
   * The day this sale actually happened, when it is not today.
   *
   * MUST be listed here or `stripUnknown` deletes it before `createSale` ever
   * sees it — see the trap documented at the top of this file — and the owner
   * would get today's invoice with no error anywhere.
   *
   * Bounds are NOT enforced here. Whether the caller may backdate at all, how
   * far back a date may reach and what a bare "YYYY-MM-DD" means in Bangladesh
   * time are all decided by `utils/saleDate.util.resolveSaleDate`, which is the
   * one place that knows. Joi only checks the SHAPE — a date, or nothing — so
   * the two cannot disagree about the policy.
   */
  saleDate: Joi.alternatives()
    .try(
      Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/),
      Joi.date().iso()
    )
    .allow('', null)
    .messages({
      'alternatives.match': 'বিক্রির তারিখ ঠিকভাবে দিন',
    }),

  /**
   * The shop's own invoice number, when it numbers its own.
   *
   * MUST be listed here for the same reason `saleDate` must — `stripUnknown`
   * would delete it and the owner would get a generated number with no error
   * anywhere, which is the exact failure `resolveCustomInvoiceNo` refuses
   * loudly to allow.
   *
   * SHAPE ONLY, and the ceiling is the same 40 characters
   * `invoiceNo.util.MAX_LENGTH` enforces — stated twice because Joi is the
   * first line and the util is the one that knows. Whether the shop may name a
   * number at all, who may do it, and which characters are legal (`~` is
   * reserved for revisions) are all decided there, so the two cannot disagree
   * about the policy.
   */
  invoiceNo: Joi.string().trim().max(40).allow('', null).messages({
    'string.base': 'ইনভয়েস নম্বর ঠিকভাবে দিন',
    'string.max': 'ইনভয়েস নম্বর ৪০ অক্ষরের বেশি হতে পারবে না',
  }),
});

module.exports = {
  createSale,
};

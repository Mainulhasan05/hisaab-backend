const Joi = require('joi');
const { PAYMENT_METHODS } = require('../config/constants');

/**
 * These routes NEED a schema, and not as tidiness.
 *
 * `updateAccount` assigns from `req.body` field by field, and the customer
 * routes' history (§11) is the warning: a restricted field becomes settable by
 * any caller the moment it exists and nothing rejects unknown keys. Joi strips
 * what is not listed here, so `balance` — the stored rollup whose only sanctioned
 * writer is `applyAccountDelta` — can never arrive from a client at all.
 */

const name = Joi.string().trim().min(1).max(80).messages({
  'string.empty': 'অ্যাকাউন্টের নাম দিন',
  'any.required': 'অ্যাকাউন্টের নাম দিন',
  'string.max': 'নাম ৮০ অক্ষরের বেশি হতে পারবে না',
});

// A display string like the account's own name — Bengali is expected and no
// romanisation happens near it. Contrast `product.validation`'s `code`, which
// is a CODE128 payload and ASCII-only.
const accountNumber = Joi.string().trim().max(40).allow('', null).messages({
  'string.max': 'অ্যাকাউন্ট নম্বর ৪০ অক্ষরের বেশি হতে পারবে না',
});

const bankName = Joi.string().trim().max(80).allow('', null);
const notes = Joi.string().trim().max(500).allow('', null);

const createAccount = Joi.object({
  name: name.required(),
  type: Joi.string().valid('cash', 'bank', 'mfs', 'card', 'courier', 'other').required().messages({
    'any.only': 'অবৈধ অ্যাকাউন্টের ধরন',
    'any.required': 'অ্যাকাউন্টের ধরন নির্বাচন করুন',
  }),
  method: Joi.string().valid(...Object.values(PAYMENT_METHODS)).required().messages({
    'any.only': 'অবৈধ পেমেন্ট পদ্ধতি',
    'any.required': 'পেমেন্ট পদ্ধতি নির্বাচন করুন',
  }),
  accountNumber,
  bankName,
  notes,
  isDefault: Joi.boolean(),
  // Accepted here, AUTHORISED in the service — owner-only, the same split as
  // `Customer.openingDue`. Negative is allowed on purpose: an overdrawn current
  // account is real, and clamping it would misstate the shop's position in the
  // one direction that matters.
  openingBalance: Joi.number().allow(null),
});

/**
 * `type` and `method` are absent, and that is the point.
 *
 * `type` decides the branch rule, so editing it would strand a cash box's
 * history in a branch the account no longer claims. `method` is what historical
 * rows resolve through, so editing it re-points money that has already been
 * counted. Neither is migratable — close the account and open another.
 */
const updateAccount = Joi.object({
  name,
  accountNumber,
  bankName,
  notes,
  isDefault: Joi.boolean(),
  isActive: Joi.boolean(),
  openingBalance: Joi.number().allow(null),
}).min(1);

const objectId = Joi.string().length(24).hex().messages({
  'string.length': 'অ্যাকাউন্ট সঠিক নয়',
  'string.hex': 'অ্যাকাউন্ট সঠিক নয়',
});

/**
 * `amountIn` is OPTIONAL and defaults to `amountOut` in the service.
 *
 * The no-charge case — banking cash — is by far the most common, and making the
 * shopkeeper type the same number twice to record it would be a tax on the
 * ordinary case for the benefit of the rare one.
 *
 * `amountIn > amountOut` is refused in the service rather than here, because the
 * comparison needs both resolved values including that default. Joi's `ref` could
 * express it, but then the rule would live in two places and one of them would
 * eventually be the stale one.
 */
const createTransfer = Joi.object({
  fromAccount: objectId.required().messages({ 'any.required': 'কোন অ্যাকাউন্ট থেকে, নির্বাচন করুন' }),
  toAccount: objectId.required().messages({ 'any.required': 'কোন অ্যাকাউন্টে, নির্বাচন করুন' }),
  amountOut: Joi.number().greater(0).max(1e11).required().messages({
    'number.greater': 'পরিমাণ ০ এর বেশি হতে হবে',
    'any.required': 'কত টাকা পাঠাচ্ছেন দিন',
  }),
  amountIn: Joi.number().greater(0).max(1e11).allow(null, ''),
  date: Joi.date().allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
});

/**
 * `direction` is accepted but only MEANS anything for `adjustment` — every other
 * type has one answer and the service derives it. Listing it here rather than
 * refusing it keeps a client that always sends the field working, and the
 * service's `directionFor` stays the single statement of the rule.
 *
 * `adjustment` also requires `notes` and owner rights. Both are enforced in the
 * service, not here: the reason is that both are about WHO is asking and what
 * the entry means, which a shape check cannot see.
 */
const createEntry = Joi.object({
  account: objectId.required().messages({ 'any.required': 'অ্যাকাউন্ট নির্বাচন করুন' }),
  type: Joi.string()
    .valid('owner_deposit', 'owner_withdrawal', 'loan_in', 'loan_out', 'adjustment')
    .required()
    .messages({ 'any.only': 'অবৈধ ধরন', 'any.required': 'ধরন নির্বাচন করুন' }),
  direction: Joi.string().valid('in', 'out'),
  amount: Joi.number().greater(0).max(1e11).required().messages({
    'number.greater': 'পরিমাণ ০ এর বেশি হতে হবে',
    'any.required': 'পরিমাণ দিন',
  }),
  date: Joi.date().allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
});

/**
 * `systemBalance` is deliberately ABSENT.
 *
 * It is read from the account by the service. A figure the caller supplies is a
 * figure the caller can make agree with the statement, which would turn the one
 * record that exists to catch a discrepancy into a record that never finds one.
 *
 * `statementBalance` may be negative — an overdrawn current account is real.
 */
const reconcileAccount = Joi.object({
  account: objectId.required().messages({ 'any.required': 'অ্যাকাউন্ট নির্বাচন করুন' }),
  statementBalance: Joi.number().required().messages({
    'any.required': 'স্টেটমেন্টের ব্যালান্স দিন',
  }),
  date: Joi.date().allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
});

module.exports = {
  createAccount,
  updateAccount,
  createTransfer,
  createEntry,
  reconcileAccount,
};

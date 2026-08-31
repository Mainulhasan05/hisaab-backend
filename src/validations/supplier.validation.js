const Joi = require('joi');
const { PAYMENT_METHODS } = require('../config/constants');

/**
 * The supplier MONEY routes need a schema, and not as tidiness.
 *
 * `paySupplier` moves cash out of a fund account and writes down a payable.
 * Joi strips what is not listed here, so a field the service does not name can
 * never arrive from a client — the same reasoning `paymentAccount.validation`
 * gives for keeping `balance` unreachable.
 *
 * The read routes carry no schema, matching every other router in this app.
 */

const amount = Joi.number().positive().max(1e11).required().messages({
  'number.base': 'সঠিক পরিমাণ দিন',
  'number.positive': 'পরিমাণ ০ এর বেশি হতে হবে',
  'number.max': 'পরিমাণ অনেক বড়',
  'any.required': 'পরিমাণ দিন',
});

const method = Joi.string().valid(...Object.values(PAYMENT_METHODS)).messages({
  'any.only': 'অবৈধ পেমেন্ট পদ্ধতি',
});

// Cheque number · bank transfer reference · bKash TrxID. Free text on purpose:
// it is copied off whatever the other party gave, and validating it would
// reject the real thing.
const reference = Joi.string().trim().max(100).allow('', null);
const transactionId = Joi.string().trim().max(100).allow('', null);
const notes = Joi.string().trim().max(500).allow('', null);

/**
 * `paidAt` is permitted here and gated in the service.
 *
 * Whether a user MAY backdate is a permission question, and `resolvePaidAt`
 * owns it along with the period lock. A schema that refused the field outright
 * would take the decision away from the one place that can make it; a schema
 * that never listed it would have `stripUnknown` delete a backdate silently,
 * which is the failure `sale.validation`'s header documents at length.
 */
const paidAt = Joi.date().iso().allow(null);

const account = Joi.string().hex().length(24).allow(null, '').messages({
  'string.hex': 'অবৈধ অ্যাকাউন্ট',
  'string.length': 'অবৈধ অ্যাকাউন্ট',
});

const paySupplier = Joi.object({
  amount,
  method,
  account,
  paidAt,
  reference,
  transactionId,
  notes,
});

/**
 * A void must say WHY.
 *
 * Required rather than optional: reversing a payment raises a payable that was
 * closed and moves cash back into an account, and a reversal nobody can explain
 * next month is indistinguishable from a mistake. The service refuses an empty
 * string too, so a whitespace-only reason cannot slip past this.
 */
const voidPayment = Joi.object({
  reason: Joi.string().trim().min(1).max(300).required().messages({
    'string.empty': 'বাতিলের কারণ লিখুন',
    'any.required': 'বাতিলের কারণ লিখুন',
    'string.max': 'কারণ ৩০০ অক্ষরের বেশি হতে পারবে না',
  }),
});

module.exports = { paySupplier, voidPayment };

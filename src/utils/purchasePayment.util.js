const { PAYMENT_TYPES } = require('../config/constants');

/**
 * Money handed over for a bill AT THE COUNTER, the day the goods arrived.
 *
 * `createPurchase` writes no `Payment` row for it — it only sets
 * `Purchase.paid` (and, since fund accounts, the `payments[]` legs; bills from
 * before that carry `paid` alone). `recordPayment` and `settleSupplierDue`
 * DO write rows, and bump `paid` as they go. So the one definition that holds
 * for every bill ever written is
 *
 *     paidAtPurchase = purchase.paid − Σ(live Payment rows applied to it)
 *
 * The supplier statement prints it as "ক্রয়ের সময় পরিশোধ"; the পরিশোধ
 * register and the per-supplier history list it as a row. All three must use
 * THIS helper — a second formula is how a register and a statement end up
 * disagreeing about what the shop paid.
 */

/**
 * The later-payment `$lookup` both supplier-statement passes hang off a
 * purchase, with each joined row projected down to `applied` — what THIS
 * purchase absorbed of it.
 *
 * A plain `foreignField: 'purchase'` join stopped being the truth twice over:
 *
 *   - a payment may settle SEVERAL bills (F-4). The row names only the primary
 *     purchase, so the primary would soak up the whole `amount` (driving its
 *     computed cash-on-delivery negative, which the `> 0` guard then hides)
 *     while the other bills read as settled on the spot. `allocations` carries
 *     the real split, so where it exists the slice is what counts;
 *   - a voided row (`cancelPurchase` unwinds its payments now) is money the
 *     drawer got back, excluded the way `LIVE_PAYMENT` does it — `$ne`, never
 *     an equality on a field legacy rows do not carry.
 *
 * `shop` and `type` ride as plain predicates so the join stays on the
 * `{shop, purchase}` index prefix instead of scanning every payment per bill.
 */
const laterPaymentsLookup = (shopOid) => ({
  $lookup: {
    from: 'payments',
    let: { pid: '$_id' },
    pipeline: [
      {
        $match: {
          shop: shopOid,
          type: PAYMENT_TYPES.PURCHASE_PAYMENT,
          status: { $ne: 'cancelled' },
          $expr: {
            $or: [
              { $eq: ['$purchase', '$$pid'] },
              { $in: ['$$pid', { $ifNull: ['$allocations.purchase', []] }] },
            ],
          },
        },
      },
      {
        $project: {
          applied: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$allocations', []] } }, 0] },
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$allocations',
                        as: 'a',
                        cond: { $eq: ['$$a.purchase', '$$pid'] },
                      },
                    },
                    as: 'a',
                    in: { $ifNull: ['$$a.amount', 0] },
                  },
                },
              },
              '$amount',
            ],
          },
        },
      },
    ],
    as: 'laterPayments',
  },
});

/** `$paid − Σ laterPayments.applied`, rounded to paisa. Needs the lookup above. */
const PAID_AT_PURCHASE_EXPR = {
  $round: [
    { $subtract: [{ $ifNull: ['$paid', 0] }, { $sum: '$laterPayments.applied' }] },
    2,
  ],
};

module.exports = { laterPaymentsLookup, PAID_AT_PURCHASE_EXPR };

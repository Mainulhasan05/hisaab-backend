const mongoose = require('mongoose');
const { MAX_DECIMALS } = require('../config/units');
const { getBangladeshDayRange } = require('./bdTime.util');

/**
 * Shared scoping/rounding primitives for report aggregations.
 *
 * These used to live as private members of report.service.js. They moved here
 * when the staff report grew large enough to earn its own service file: two
 * services that must agree on "what counts as a net sale" and "where does a day
 * end" cannot each keep their own copy. That is the same failure the BD_OFFSET
 * comment in report.service.js describes — a report that disagrees with the
 * dashboard about which day a sale landed on.
 *
 * report.service.js still exposes `_baseMatch` / `_buildDateMatch` as thin
 * wrappers over these, so every existing caller is untouched.
 */

/** Base $match for an aggregation: shop, plus branch when one is in scope. */
function baseMatch(shopId, branchId = null) {
  const match = { shop: new mongoose.Types.ObjectId(shopId) };
  if (branchId) {
    match.branch = new mongoose.Types.ObjectId(branchId);
  }
  return match;
}

/**
 * Build a date-range match. Ensures end-of-day (23:59:59.999 Bangladesh time)
 * is used when `endDate` is a date-only string or a midnight timestamp —
 * otherwise "১-৩১ জানুয়ারি" silently drops everything sold on the 31st.
 */
function buildDateMatch(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const match = {};

  if (startDate) {
    match.$gte = new Date(startDate);
  }

  if (endDate) {
    const end = new Date(endDate);
    if (typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
      const { endOfDay } = getBangladeshDayRange(endDate.trim());
      match.$lte = endOfDay;
    } else if (
      end.getUTCHours() === 0 &&
      end.getUTCMinutes() === 0 &&
      end.getUTCSeconds() === 0 &&
      end.getUTCMilliseconds() === 0
    ) {
      match.$lte = new Date(end.getTime() + (24 * 60 * 60 * 1000 - 1));
    } else {
      match.$lte = end;
    }
  }

  return match;
}

/**
 * What a sale is actually worth to the shop: the bill total less whatever has
 * since been returned against it, floored at zero. This is THE definition of
 * "net sale" across every report — anything that reports a staff member's or a
 * day's sales must sum this, not `$total`.
 */
function netSaleAmountExpr() {
  return {
    $max: [
      { $subtract: ['$total', { $ifNull: ['$returnedAmount', 0] }] },
      0,
    ],
  };
}

/**
 * Snap an aggregated quantity to the registry's maximum precision.
 *
 * Reports `$sum` quantities ACROSS products, so there is no single unit to
 * round at — MAX_DECIMALS is the correct ceiling: it is the finest precision
 * any unit is allowed, so rounding there can never coarsen a real value while
 * still clearing the float residue that summing fractions leaves behind
 * (12 x 0.1 sums to 1.1102230246251565e-16 over 1.2).
 *
 * Money uses `quantizeMoney` (2 dp); this is for quantities only.
 */
function roundReportQty(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, MAX_DECIMALS);
  return Math.round(num * factor) / factor;
}

module.exports = {
  baseMatch,
  buildDateMatch,
  netSaleAmountExpr,
  roundReportQty,
};

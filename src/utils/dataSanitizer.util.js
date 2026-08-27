/**
 * Data Sanitizer Utility
 * Sanitizes confidential cost prices and profit margins based on user RBAC permissions
 */

function canViewCost(req) {
  if (!req || !req.user) return false;
  if (req.isAdmin || req.user.isOwner) return true;
  const perms = req.user.permissions;
  return perms?.products?.view_cost === true;
}

function canViewPurchaseCost(req) {
  if (!req || !req.user) return false;
  if (req.isAdmin || req.user.isOwner) return true;
  const perms = req.user.permissions;
  return perms?.purchases?.view_cost === true;
}

function canViewProfit(req) {
  if (!req || !req.user) return false;
  if (req.isAdmin || req.user.isOwner) return true;
  const perms = req.user.permissions;
  return perms?.sales?.view_profit === true || perms?.reports?.view_profit === true;
}

/**
 * Sanitize product document or object
 */
function sanitizeProductDoc(doc, allowCost) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };

  if (!allowCost) {
    delete obj.buyingPrice;
    // Derived component cost of a combo — same confidential figure as
    // `buyingPrice`, computed instead of stored. `comboCostMin` is the other
    // end of the range a 'choose' slot creates and is exactly as revealing.
    // The per-row figures the decorator attaches are stripped for the same
    // reason.
    delete obj.comboCost;
    delete obj.comboCostMin;
    if (Array.isArray(obj.comboItems)) {
      obj.comboItems = obj.comboItems.map((c) => {
        const cObj = typeof c.toObject === 'function' ? c.toObject() : { ...c };
        delete cObj.buyingPrice;
        delete cObj.buyingPriceMin;
        return cObj;
      });
    }
    if (Array.isArray(obj.variants)) {
      obj.variants = obj.variants.map((v) => {
        const vObj = typeof v.toObject === 'function' ? v.toObject() : { ...v };
        delete vObj.buyingPrice;
        return vObj;
      });
    }
    // `batches[].costPrice` is what the shop PAID for that delivery — the same
    // confidential figure as `buyingPrice`, reached by a different path. It has
    // always been serialised with the product and was never stripped, so a
    // cashier without `products.view_cost` could read the cost of every batch
    // straight out of the product list response. Sanitising the batch
    // endpoints alone would not close that; the leak is here.
    if (Array.isArray(obj.batches)) {
      obj.batches = obj.batches.map((b) => {
        const bObj = typeof b.toObject === 'function' ? b.toObject() : { ...b };
        delete bObj.costPrice;
        return bObj;
      });
    }
  }
  return obj;
}

/**
 * Batch payloads (`getProductBatches`, `getExpiringBatches`) are not product
 * documents — they are purpose-built shapes with batches nested under owners —
 * so `sanitizeProducts` cannot reach into them. Same rule, same permission.
 */
function sanitizeBatches(data, req) {
  if (canViewCost(req)) return data;
  if (data === null || data === undefined) return data;
  return stripKeysDeep(JSON.parse(JSON.stringify(data)), new Set(['costPrice', 'buyingPrice']));
}

function sanitizeProducts(products, req) {
  const allowCost = canViewCost(req);
  if (allowCost) return products;

  if (Array.isArray(products)) {
    return products.map((p) => sanitizeProductDoc(p, false));
  }
  return sanitizeProductDoc(products, false);
}

/**
 * Sanitize sale document or object
 */
function sanitizeSaleDoc(doc, allowCost, allowProfit) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };

  if (!allowCost && Array.isArray(obj.items)) {
    obj.items = obj.items.map((item) => {
      const itemObj = typeof item.toObject === 'function' ? item.toObject() : { ...item };
      delete itemObj.buyingPrice;
      // Combo lines snapshot each component's cost — the same confidential
      // figure as `buyingPrice`, reached by a different path.
      if (Array.isArray(itemObj.comboComponents)) {
        itemObj.comboComponents = itemObj.comboComponents.map((c) => {
          const compObj = typeof c.toObject === 'function' ? c.toObject() : { ...c };
          delete compObj.unitCost;
          return compObj;
        });
      }
      return itemObj;
    });
  }

  if (!allowProfit) {
    delete obj.profit;
    delete obj.profitLoss;
    delete obj.profitReduction;
  }

  return obj;
}

function sanitizeSales(sales, req) {
  const allowCost = canViewCost(req);
  const allowProfit = canViewProfit(req);
  if (allowCost && allowProfit) return sales;

  if (Array.isArray(sales)) {
    return sales.map((s) => sanitizeSaleDoc(s, allowCost, allowProfit));
  }
  return sanitizeSaleDoc(sales, allowCost, allowProfit);
}

// Money fields on a purchase document, its line items, its payments and the
// purchase summary. Scoped to the purchase endpoints only — `total`/`amount`
// are far too generic to put in the global COST_KEYS strip.
const PURCHASE_MONEY_KEYS = new Set([
  'unitPrice', 'total', 'totalAmount', 'paid', 'due',
  'totalPaid', 'totalDue', 'amount',
  // The supplier's per-pack rate — "৳১,৮০০ per বস্তা". `unitPrice` above is
  // its per-base twin, so leaving this listed nowhere let anyone divide by
  // `packSize` and read back the cost this set exists to withhold. Same defect
  // `packUnitCost` in COST_KEYS was added for, on the other payload.
  'packUnitPrice',
  // What this delivery did to the shelf's cost basis. Snapshots, so they are
  // not named like a price and were never stripped — and `costAfter` IS the
  // product's buying price, exactly the number `view_cost` withholds.
  'costBefore', 'costAfter',
  // ── The landed-cost terms ────────────────────────────────────────────────
  //
  // `landedUnitPrice` is the cost, straightforwardly: `unitPrice` plus this
  // line's share of the ভাড়া, less its share of the discount. Every other
  // field here reconstructs part of it — a reader holding `total`, the shares
  // and the invoice charges can put the cost back together arithmetically,
  // which is the same full-bypass shape `netEarnings` had on the reports side.
  // So the whole set goes, not just the obvious one.
  'landedUnitPrice', 'landedTotal', 'lineDiscount', 'discountShare', 'chargeShare',
  'subtotal', 'itemDiscount', 'discount', 'discountAmount',
  'freightCharge', 'otherCharge', 'merchandise',
  // ── The কেনা ফেরত terms ─────────────────────────────────────────────────
  //
  // A return document's own money is already covered above — its lines carry
  // `unitPrice`, `total`, `landedUnitPrice` and the discount shares, and its
  // head carries `totalAmount`. These are the two names the SUMMARY endpoint
  // invents, and neither resembles anything already listed:
  //
  //     totalReturns         the window's credit total
  //     pendingRefundAmount  what suppliers still owe back
  //
  // `adjustedAmount` is the third and is a strict subset of `totalReturns`, so
  // leaving it out would hand back most of what the other two withhold.
  // `returnedAmount` is the accumulator on `Purchase` itself — the term that
  // makes `totalAmount − paid − returnedAmount` reconstructible, which is the
  // same full-bypass shape `netEarnings` had on the reports side.
  'totalReturns', 'pendingRefundAmount', 'adjustedAmount', 'returnedAmount',
]);

/**
 * Strip buying prices, invoice totals and dues from purchase payloads unless
 * the requester holds purchases.view_cost. What survives — supplier, invoice
 * no, date, status, quantities — still lets a stock handler confirm a delivery
 * was recorded without learning what the shop paid for it.
 */
function sanitizePurchases(data, req) {
  if (canViewPurchaseCost(req)) return data;
  if (data === null || data === undefined) return data;
  return stripKeysDeep(JSON.parse(JSON.stringify(data)), PURCHASE_MONEY_KEYS);
}

// Keys stripped when the user lacks the corresponding permission.
//
// This is a denylist over field NAMES, so a profit figure escapes it the moment
// a report gives it a name that isn't listed. `netEarnings` (profit − expenses,
// returned by the daily summary and the date-wise report) did exactly that: it
// shipped to anyone with plain `reports.view`, and because those same payloads
// carry the expense total beside it, `profit = netEarnings + expenses` put the
// figure back together exactly — a full bypass of `view_profit`.
//
// Any new field derived from profit must be added here, whatever it is called.
const PROFIT_KEYS = new Set([
  'profit', 'totalProfit', 'todayProfit', 'profitLoss', 'grossProfit',
  'netProfit', 'profitMargin', 'profitReduction', 'cogs',
  // Derived: profit minus expenses. Named nothing like "profit", leaks all of it.
  'netEarnings',
  // The returns summary's own name for `profitReduction` — how much profit the
  // day's returns gave back.
  'totalProfitLoss', 'returnsLoss',
]);
const COST_KEYS = new Set([
  'buyingPrice', 'unitCost', 'totalCost', 'totalBuyingValue', 'inventoryValue',
  'comboCost', 'comboCostMin', 'buyingPriceMin',
  // The pack rate on a supplier-statement goods line — "৳১,২০০ per বস্তা". The
  // per-base-unit figure beside it is already `unitCost` above; leaving its
  // pack twin unlisted would let anyone divide by `packSize` and read the cost
  // this set exists to withhold.
  'packUnitCost',
]);

function isPlainObject(val) {
  return val !== null && typeof val === 'object' &&
    (val.constructor === Object || val.constructor === undefined);
}

function stripKeysDeep(data, keys) {
  if (Array.isArray(data)) {
    return data.map((item) => stripKeysDeep(item, keys));
  }
  if (!isPlainObject(data)) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (keys.has(k)) continue;
    out[k] = stripKeysDeep(v, keys);
  }
  return out;
}

/**
 * Sanitize an aggregated report payload (dashboard, sales/product reports,
 * daily summary, trending, exports) based on the requester's permissions.
 * Documents should be plain objects (aggregate/lean results, or .toObject()'d).
 */
function sanitizeReport(data, req) {
  const allowProfit = canViewProfit(req);
  const allowCost = canViewCost(req);
  if (allowProfit && allowCost) return data;

  // Normalize Mongoose docs/ObjectIds/Dates to their JSON form (identical to
  // what res.json would emit) so the deep strip sees only plain objects.
  let result = JSON.parse(JSON.stringify(data));
  if (!allowProfit) result = stripKeysDeep(result, PROFIT_KEYS);
  if (!allowCost) result = stripKeysDeep(result, COST_KEYS);
  return result;
}

module.exports = {
  canViewCost,
  canViewProfit,
  canViewPurchaseCost,
  sanitizeProducts,
  sanitizeBatches,
  sanitizeSales,
  sanitizePurchases,
  sanitizeReport,
  stripKeysDeep,
  PROFIT_KEYS,
  COST_KEYS,
  PURCHASE_MONEY_KEYS,
};

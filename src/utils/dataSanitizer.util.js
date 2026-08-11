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

// Keys stripped when the user lacks the corresponding permission
const PROFIT_KEYS = new Set([
  'profit', 'totalProfit', 'todayProfit', 'profitLoss', 'grossProfit',
  'netProfit', 'profitMargin', 'profitReduction', 'cogs',
]);
const COST_KEYS = new Set([
  'buyingPrice', 'unitCost', 'totalCost', 'totalBuyingValue', 'inventoryValue',
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

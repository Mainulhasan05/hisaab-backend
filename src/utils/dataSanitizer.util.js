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
  }
  return obj;
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

module.exports = {
  canViewCost,
  canViewProfit,
  sanitizeProducts,
  sanitizeSales,
};

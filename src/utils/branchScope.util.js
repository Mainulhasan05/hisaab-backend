/**
 * Branch Scope Utility
 * 
 * Central helper for conditionally adding branch filtering to queries.
 * This is the primary mechanism that keeps single-branch shops untouched
 * while enabling branch-scoped data access for multi-branch shops.
 * 
 * Key principle: branch filtering is ONLY applied when:
 * 1. The shop has multiBranchEnabled === true
 * 2. A specific branch is selected (not "All Branches" view)
 */

/**
 * Build a query filter with optional branch scoping.
 * Adds branch filter only if req.branchId is set (multi-branch + specific branch selected).
 * 
 * @param {Object} req - Express request (must have req.shop and optionally req.branchId)
 * @param {Object} baseFilter - Existing query filter
 * @returns {Object} Filter with branch conditionally added
 * 
 * @example
 * // Single-branch shop: returns { shop: shopId, status: 'completed' }
 * // Multi-branch (branch selected): returns { shop: shopId, branch: branchId, status: 'completed' }
 * // Multi-branch (all branches): returns { shop: shopId, status: 'completed' }
 * const filter = scopeByBranch(req, { status: 'completed' });
 */
function scopeByBranch(req, baseFilter = {}) {
  const filter = { ...baseFilter };

  // Always ensure shop scope
  if (!filter.shop && req.shop) {
    filter.shop = req.shop._id;
  }

  // Add branch scope only when a specific branch is selected
  if (req.branchId) {
    filter.branch = req.branchId;
  }

  return filter;
}

/**
 * Get branch ID for creating new documents.
 * For multi-branch shops, a branch must be selected.
 * For single-branch shops, returns null.
 * 
 * @param {Object} req - Express request
 * @returns {ObjectId|null} Branch ID or null
 * @throws {Error} If multi-branch is enabled but no branch is selected
 */
function getBranchForCreate(req) {
  // Single-branch shop — no branch assignment needed
  if (!req.shop?.multiBranchEnabled) {
    return null;
  }

  // Multi-branch shop — branch is required for creating records
  if (!req.branchId) {
    const error = new Error('মাল্টি-ব্রাঞ্চ দোকানে শাখা নির্বাচন করুন');
    error.statusCode = 400;
    throw error;
  }

  return req.branchId;
}

/**
 * Check if the request has multi-branch context.
 * Useful for conditional logic in services.
 * 
 * @param {Object} req - Express request
 * @returns {boolean} True if shop has multi-branch enabled
 */
function isMultiBranch(req) {
  return req.shop?.multiBranchEnabled === true;
}

/**
 * Build a match stage for aggregation pipelines with optional branch scoping.
 * Similar to scopeByBranch but returns ObjectId types suitable for aggregation.
 * 
 * @param {Object} req - Express request
 * @param {Object} baseMatch - Base match conditions
 * @returns {Object} Match object for aggregation $match stage
 */
function scopeByBranchForAggregation(req, baseMatch = {}) {
  const mongoose = require('mongoose');
  const match = { ...baseMatch };

  if (!match.shop && req.shop) {
    match.shop = new mongoose.Types.ObjectId(req.shop._id);
  }

  if (req.branchId) {
    match.branch = new mongoose.Types.ObjectId(req.branchId);
  }

  return match;
}

/**
 * Get branch code for invoice/reference number generation.
 * Returns null for single-branch shops (no branch code in invoices).
 * 
 * @param {Object} req - Express request
 * @returns {string|null} Branch code (e.g., "DHA") or null
 */
function getBranchCode(req) {
  if (!req.shop?.multiBranchEnabled || !req.branch) {
    return null;
  }
  return req.branch.code || null;
}

module.exports = {
  scopeByBranch,
  getBranchForCreate,
  isMultiBranch,
  scopeByBranchForAggregation,
  getBranchCode
};

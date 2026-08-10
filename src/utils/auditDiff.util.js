/**
 * Audit-log payload shaping.
 *
 * Audit entries used to carry `changes.before` / `changes.after` as whole
 * `toObject()` documents. On the write-heavy models that meant every create
 * stored a second full copy of the entity and every update stored two — paid
 * for in write IOPS, index growth and replication bandwidth, on the two
 * highest-volume collections in the system.
 *
 * That detail was also mostly noise: a product edit that changed one price
 * stored the entire variants array, batch history, image list and tag list
 * twice over, and a reader still had to diff them by eye to find the change.
 *
 * The entity itself remains the authoritative record — `entity.id` points at
 * it, and it outlives the log either way (AuditLog carries a 90-day TTL, so
 * these snapshots were never the durable copy).
 */

/**
 * Pick a whitelist of fields off a document.
 *
 * Undefined fields are omitted rather than stored as null, so an entry only
 * carries what the entity actually had.
 *
 * @param {Object} doc - Mongoose document or plain object
 * @param {string[]} fields - field names to keep (top level only)
 * @returns {Object}
 */
function auditSnapshot(doc, fields) {
  if (!doc) return {};
  const src = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const out = {};
  for (const f of fields) {
    if (src[f] !== undefined) out[f] = src[f];
  }
  return out;
}

/**
 * Field-level diff across a whitelist — only what actually changed.
 *
 * An edit that touches one field produces one entry in `before` and one in
 * `after`, which is both far smaller than two full documents and much easier
 * to read than them.
 *
 * Comparison is by JSON value, so nested objects and arrays (`packaging`,
 * `variants`) compare structurally rather than by reference — a document
 * reloaded from Mongo would otherwise look different from itself on every
 * field. Key ORDER is significant to this comparison; in practice both sides
 * come from the same schema and so serialise consistently. A false positive
 * costs one redundant field in the log, never a missed change.
 *
 * @param {Object} before - pre-change document or plain object
 * @param {Object} after - post-change document or plain object
 * @param {string[]} fields - field names to compare (top level only)
 * @returns {{before: Object, after: Object}} only the differing fields
 */
function auditDiff(before, after, fields) {
  const a = before && typeof before.toObject === 'function' ? before.toObject() : (before || {});
  const b = after && typeof after.toObject === 'function' ? after.toObject() : (after || {});

  const changedBefore = {};
  const changedAfter = {};

  for (const f of fields) {
    const av = a[f];
    const bv = b[f];
    if (av === undefined && bv === undefined) continue;
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      changedBefore[f] = av === undefined ? null : av;
      changedAfter[f] = bv === undefined ? null : bv;
    }
  }

  return { before: changedBefore, after: changedAfter };
}

/**
 * Field whitelists per entity. Kept here so the create path and the update
 * path of the same entity can never drift apart — that divergence is exactly
 * how an audit trail ends up recording a field on creation that it silently
 * stops tracking on edit.
 */
const AUDIT_FIELDS = {
  product: [
    'name', 'code', 'barcode', 'category', 'unit', 'buyingPrice', 'sellingPrice',
    'wholesalePrice',
    'stock', 'minStock', 'isActive', 'isAvailableOnline', 'hasVariants',
    'trackBatches', 'packaging',
  ],
  customer: [
    'name', 'phone', 'email', 'address', 'creditLimit', 'isActive',
    'totalDue', 'totalPaid', 'totalPurchases', 'openingDue',
    // Owner-only and it changes what the shop charges, so a promotion to
    // wholesale is exactly the kind of edit the trail exists to record.
    'isWholesale',
  ],
};

module.exports = { auditSnapshot, auditDiff, AUDIT_FIELDS };

/**
 * Which storefront templates a shop may choose from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN EMPTY GRANT LIST MEANS "EVERYTHING", NOT "NOTHING"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Shop.storefront.allowedTemplates` used to be an allow-list whose empty
 * default meant no templates at all. That made the common case broken by
 * default: an admin switched `features.storefront` on, the shop opened its
 * panel, and the template picker was empty — a website feature that could not
 * pick a website. Every shop needed a second, separate, easily-forgotten admin
 * action before the thing they had been given would work.
 *
 * So the field is now a RESTRICTION, and it is empty for almost everyone:
 *
 *     []            → no restriction. Every `published` template is offered.
 *     ['bazar', …]  → this shop may pick only these.
 *
 * ── WHY THIS RATHER THAN BACK-FILLING EVERY SHOP ────────────────────────────
 *
 * The alternative was to write the full template list onto every shop
 * document. That works once and then rots: the next template published would
 * be invisible to every existing shop until somebody remembered to run another
 * migration, and "why can't I see the new design" would arrive as a support
 * call rather than as a deploy step. Interpreting empty as unrestricted is
 * self-maintaining — publish a template and every shop has it.
 *
 * It also writes nothing. No migration, no cache invalidation, no risk to the
 * shops that DO have a deliberate restriction: a non-empty list keeps meaning
 * exactly what it meant before.
 *
 * ── WHAT DID NOT CHANGE ─────────────────────────────────────────────────────
 *
 * I-11 is untouched. This list is consulted when a shop APPLIES a template and
 * never when one is RENDERED — `publicStorefront.service` still reads the
 * applied key off the Storefront document without asking whether it is still
 * granted. Narrowing a restriction can stop a shop switching TO a template; it
 * can never take a live site down.
 *
 * Only `published` templates are ever offered. A `draft` template is unfinished
 * and a `retired` one is on its way out, so "unrestricted" has never meant
 * "including the ones that are not ready".
 */

/**
 * Is this shop restricted to a specific subset?
 *
 * @param {object} shop  a Shop document or lean object
 * @returns {boolean} false = may pick any published template
 */
function hasTemplateRestriction(shop) {
  const list = shop?.storefront?.allowedTemplates;
  return Array.isArray(list) && list.length > 0;
}

/**
 * The restriction as a set, or `null` when there is none.
 *
 * Callers branch on `null` rather than on an empty set, because an empty set
 * and "no restriction" are the two things this module exists to stop anyone
 * confusing again.
 */
function templateRestrictionSet(shop) {
  return hasTemplateRestriction(shop)
    ? new Set(shop.storefront.allowedTemplates)
    : null;
}

/**
 * May this shop apply `key` right now?
 *
 * Takes the template's status too, because "allowed" and "ready" are separate
 * questions and the caller needs to tell the shop which one failed.
 */
function canApplyTemplate(shop, key) {
  const restriction = templateRestrictionSet(shop);
  return restriction === null || restriction.has(key);
}

/**
 * A Mongo filter selecting every template this shop may be offered.
 *
 * `extraKeys` are folded in unconditionally — the template a shop is CURRENTLY
 * running belongs in its own picker even after a restriction was narrowed or
 * the template retired, so the gallery can grey it and say why rather than
 * showing a shop a list that does not contain the site it is looking at.
 */
function offerableTemplateFilter(shop, extraKeys = []) {
  const keys = [...new Set(extraKeys.filter(Boolean))];
  const restriction = templateRestrictionSet(shop);

  if (restriction === null) {
    return keys.length
      ? { $or: [{ status: 'published' }, { key: { $in: keys } }] }
      : { status: 'published' };
  }

  return { key: { $in: [...new Set([...restriction, ...keys])] } };
}

module.exports = {
  hasTemplateRestriction,
  templateRestrictionSet,
  canApplyTemplate,
  offerableTemplateFilter,
};

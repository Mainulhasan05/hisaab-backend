/**
 * The rules for a shop's public address — `hisaab.bd/s/<slug>`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A UTIL AND NOT TWO COPIES OF A REGEX
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three places decide what a slug may be: the model's pre-save hook (which
 * mints one at registration), the admin endpoint (which lets an operator
 * rewrite one), and the public route's param validator (which decides what is
 * even worth a database round trip). If those three disagree, the failure is
 * silent and permanent — a shop is handed an address that its own public URL
 * validator will not accept, and nobody finds out until a customer taps a link.
 *
 * So the shape lives here once.
 *
 * ── WHY THE CEILING IS 48 AND NOT 80 ────────────────────────────────────────
 *
 * `public.routes.js` accepts up to 80 characters on the URL param, deliberately
 * generously: it is a garbage filter in front of a query, not a naming policy.
 * What we are willing to MINT is a different question — this address gets read
 * aloud over a phone and typed into a 3G browser — so creation is held to 48,
 * matching the landing-page slug rule that already exists.
 */

/** Length bounds for a slug we are willing to create. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 48;

/**
 * Addresses no shop may hold.
 *
 * The `/s/` prefix means a shop slug cannot collide with an app route — that is
 * the whole point of the prefix and it is why this list is short. What is left
 * is the class of strings that would make a URL read as something it is not:
 * `hisaab.bd/s/admin` is not an admin page and must never look like one, and a
 * shop named `www` or `api` in a support ticket costs an hour of confusion.
 */
const RESERVED_SLUGS = Object.freeze([
  'admin', 'api', 'app', 'assets', 'auth', 'cart', 'checkout', 'dashboard',
  'help', 'hisaab', 'login', 'logout', 'offers', 'order', 'orders', 'p',
  'public', 'register', 's', 'search', 'settings', 'sitemap', 'static',
  'storefront', 'support', 'www',
]);

/**
 * Fold arbitrary text down to slug characters.
 *
 * Non-ASCII is DROPPED rather than transliterated. A shop named "হিসাব ফ্যাশন"
 * folds to nothing here, and the caller is expected to notice and fall back —
 * which the model's hook does by appending a random suffix. Transliterating
 * Bangla would produce an address the owner does not recognise as their own
 * name and cannot spell back to a customer, which is worse than a short
 * generated one.
 */
function normalizeSlug(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    // Separators become hyphens BEFORE the strip. Doing it the other way round
    // deletes the underscore in `STUDENT__HUB` and yields `studenthub` — one
    // word, not two — which is exactly the address the operator did not type.
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check a slug a human chose. Returns `{ valid, slug, reason, reasonBn }`.
 *
 * Normalises first, then judges the RESULT — so "Student Hub" is accepted and
 * returns `student-hub`, rather than being rejected for a space the operator
 * would then have to fix by hand. Anything that survives normalisation but
 * fails a rule below is reported with a reason the operator can act on; a
 * generic "invalid slug" would leave them guessing which of five rules bit.
 */
function validateSlug(input) {
  const slug = normalizeSlug(input);

  if (!slug) {
    return {
      valid: false,
      slug,
      reason: 'Slug must contain English letters or digits',
      reasonBn: 'ঠিকানায় ইংরেজি অক্ষর বা সংখ্যা থাকতে হবে',
    };
  }
  if (slug.length < MIN_LENGTH) {
    return {
      valid: false,
      slug,
      reason: `Slug must be at least ${MIN_LENGTH} characters`,
      reasonBn: `ঠিকানা কমপক্ষে ${MIN_LENGTH} অক্ষরের হতে হবে`,
    };
  }
  if (slug.length > MAX_LENGTH) {
    return {
      valid: false,
      slug,
      reason: `Slug must be at most ${MAX_LENGTH} characters`,
      reasonBn: `ঠিকানা সর্বোচ্চ ${MAX_LENGTH} অক্ষরের হতে পারবে`,
    };
  }
  // A slug that is only digits reads as an id, and an address that looks like
  // an id invites someone to build a lookup on it later.
  if (/^\d+$/.test(slug)) {
    return {
      valid: false,
      slug,
      reason: 'Slug cannot be only digits',
      reasonBn: 'ঠিকানা শুধু সংখ্যা দিয়ে হতে পারবে না',
    };
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return {
      valid: false,
      slug,
      reason: `"${slug}" is reserved`,
      reasonBn: `"${slug}" ঠিকানাটি সংরক্ষিত`,
    };
  }

  return { valid: true, slug, reason: null, reasonBn: null };
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  RESERVED_SLUGS,
  normalizeSlug,
  validateSlug,
};

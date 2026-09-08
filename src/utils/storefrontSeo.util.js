/**
 * What a storefront's SEO block is, what it may contain, and what it falls back
 * to when a shop has filled in nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIELD LIST IS SHORT, AND THE OMISSIONS ARE THE DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `title`, `description`, `ogImage`. That is all, and three things a shopkeeper
 * would recognise from a "SEO plugin" are deliberately absent:
 *
 *   NO `keywords`. The meta keywords tag has been ignored by Google since 2009.
 *     Adding the box would teach every shop on the platform to spend ten
 *     minutes on the one field that cannot possibly help them.
 *   NO per-page overrides. A category page's title is `<category> — <shop>`,
 *     composed from data that is already correct and already changes when the
 *     category is renamed. A stored override is a copy that silently goes stale.
 *   NO `canonical`. It is derived from the shop's current slug, and a
 *     hand-typed one is a way to deindex your own site by typo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO CEILINGS PER FIELD: WHAT GOOGLE SHOWS vs WHAT WE STORE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `*_LIMIT` is the length a search result actually renders before Google cuts
 * it. `*_MAX` is what we will persist. They are different numbers on purpose.
 *
 * Refusing to save at 61 characters would be us enforcing a guideline as a law
 * — Google truncates by PIXEL width, the threshold differs for Bangla, and a
 * shop with a long real name can legitimately need more. So the editor warns at
 * the guideline and the server refuses only at the point where the value has
 * stopped being a title at all.
 *
 * ── WHY BANGLA IS COUNTED IN CHARACTERS ANYWAY ──────────────────────────────
 *
 * Pixel measurement needs a font and a renderer, neither of which exists in a
 * Node service or in an `<input maxlength>`. Characters are the honest
 * approximation both ends can compute, and the failure mode is mild: a Bangla
 * title flagged as long when it would have fitted.
 */

const { AppError } = require('../middleware/error.middleware');

/** Where Google starts truncating. The editor warns here; nothing refuses. */
const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 160;

/** Where a value stops being a title or a description. The server refuses here. */
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 320;

/** Every key the SEO block may hold. Anything else is refused, not dropped. */
const SEO_FIELDS = Object.freeze(['title', 'description', 'ogImage']);

/**
 * Collapse whitespace and strip what breaks a `<meta>` tag.
 *
 * Newlines in particular: a shopkeeper pasting from WhatsApp brings them along,
 * and a description containing one renders as a broken snippet in some crawlers
 * and as nothing in others. Line breaks carry no meaning in a one-line summary,
 * so flattening them loses nothing.
 */
function cleanText(input) {
  return String(input == null ? '' : input)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate and normalise a `seo` patch from the editor or the AI endpoint.
 *
 * Returns a clean object. Throws `AppError` on anything the shop must be told
 * about rather than have silently discarded.
 */
function normalizeSeo(input) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('seo must be an object', 'এসইও তথ্য সঠিক নয়', 400);
  }

  // Refused, not dropped — the same rule `updateDraft` applies to unknown block
  // slots, and for the same reason: content stored under a name nothing reads
  // is content the shop believes it wrote and will never see.
  const unknown = Object.keys(input).filter((k) => !SEO_FIELDS.includes(k));
  if (unknown.length) {
    throw new AppError(
      `Unknown SEO fields: ${unknown.join(', ')}`,
      `অজানা এসইও ফিল্ড: ${unknown.join(', ')}`,
      400
    );
  }

  const out = {};

  if ('title' in input) {
    const title = cleanText(input.title);
    if (title.length > TITLE_MAX) {
      throw new AppError(
        `Title must be at most ${TITLE_MAX} characters`,
        `টাইটেল সর্বোচ্চ ${TITLE_MAX} অক্ষরের হতে পারবে`,
        400
      );
    }
    out.title = title;
  }

  if ('description' in input) {
    const description = cleanText(input.description);
    if (description.length > DESCRIPTION_MAX) {
      throw new AppError(
        `Description must be at most ${DESCRIPTION_MAX} characters`,
        `বর্ণনা সর্বোচ্চ ${DESCRIPTION_MAX} অক্ষরের হতে পারবে`,
        400
      );
    }
    out.description = description;
  }

  if ('ogImage' in input) {
    const raw = input.ogImage == null ? '' : String(input.ogImage).trim();
    if (!raw) {
      // Empty means "go back to the logo", which is a real choice and has to be
      // storable. `null` rather than '' so the fallback chain has one shape.
      out.ogImage = null;
    } else if (!/^https?:\/\//i.test(raw)) {
      // Only absolute URLs. A relative path here becomes an og:image tag that
      // Facebook resolves against ITS own origin and silently drops — the shop
      // sees a preview with no picture and nothing on screen explains why.
      throw new AppError(
        'ogImage must be an absolute http(s) URL',
        'শেয়ার ছবির লিংক সম্পূর্ণ (https://…) হতে হবে',
        400
      );
    } else {
      out.ogImage = raw;
    }
  }

  return out;
}

/**
 * The SEO values a page should actually render, after fallbacks.
 *
 * ── WHY THE FALLBACK LIVES HERE AND NOT IN THE PAGE ─────────────────────────
 *
 * `layout.js` already did `seo.title || shop.name`, and so would the product
 * page, the category page and the sitemap — four copies of one rule, drifting.
 * Worse, the AI writer and the editor's live preview both have to agree with
 * whatever the page will do, or the shop is shown a preview of a page that does
 * not exist.
 *
 * So the server resolves it once and every consumer renders what it is handed.
 *
 * `ogImage` falls back to the shop's logo, which is usually square and will be
 * centre-cropped by Facebook. That is worse than a purpose-made 1200×630 card
 * and much better than no image at all — a shared link with no picture gets
 * materially fewer taps. The editor says exactly this, next to the upload.
 */
function resolveSeo(shop, seo = {}) {
  const stored = seo && typeof seo === 'object' ? seo : {};
  const name = cleanText(shop?.name) || 'দোকান';

  return {
    title: cleanText(stored.title) || name,
    description:
      cleanText(stored.description) || `${name} — অনলাইনে অর্ডার করুন। ঘরে বসে ডেলিভারি।`,
    ogImage: stored.ogImage || shop?.logo || null,
    /**
     * Whether each value is the shop's own or ours.
     *
     * The editor renders "আপনার লেখা" vs "স্বয়ংক্রিয়" from this, so a shop can
     * see at a glance which fields they have actually written. A default that
     * looks authored is how every shop on the platform ends up sharing one
     * description forever — and how nobody ever discovers the field.
     */
    isDefault: {
      title: !cleanText(stored.title),
      description: !cleanText(stored.description),
      ogImage: !stored.ogImage,
    },
  };
}

module.exports = {
  TITLE_LIMIT,
  DESCRIPTION_LIMIT,
  TITLE_MAX,
  DESCRIPTION_MAX,
  SEO_FIELDS,
  cleanText,
  normalizeSeo,
  resolveSeo,
};

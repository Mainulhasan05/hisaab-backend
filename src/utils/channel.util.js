/**
 * Sales channel — turning what a shop TYPED into something reports can group by.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Order.sourceNote` is free text, deliberately: "the channels a small shop
 * sells through change faster than a deploy". That argument is right for INPUT
 * and wrong for REPORTING, and the codebase already knows it — `Sale.courier`
 * exists as a ref precisely because `courierName` is free text and shops type it
 * inconsistently ("Steadfast", "steadfast", "স্টেডফাস্ট"), so matching money on
 * it would "either split one courier into three accounts or merge two real
 * ones". A channel report built on `sourceNote` fails the same way: "Facebook",
 * "fb", "ফেসবুক" and "FB page" become four channels.
 *
 * So the note stays exactly as the shop typed it — it is what the order screen
 * prints — and this maps it ONCE, at confirm, onto the closed
 * `Sale.channel` enum that reports actually group by. Two fields, two jobs:
 * the note is testimony, the channel is data.
 *
 * Before this existed, `confirmOrder` hardcoded `channel: 'other'` for every
 * manual order — which is most of them, since most Bangladeshi shops sell in an
 * inbox — so the one enum that could have answered "how much came from
 * Facebook?" was populated correctly only by the storefront.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNRECOGNISED INPUT IS `other`, NEVER A GUESS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A note this table does not know maps to `other` and the shop's own words
 * survive on `sourceNote`. That is the honest answer and it is recoverable: a
 * channel added to the table later can be backfilled from the notes, whereas a
 * wrong guess written into the enum cannot be told apart from a right one.
 */

/**
 * The closed set. MUST stay identical to `Sale.channel`'s enum — a value that
 * is not in the schema fails validation at write time, which on the confirm
 * path means a shopkeeper cannot confirm an order because of a typo in here.
 */
const SALE_CHANNELS = Object.freeze(['pos', 'facebook', 'instagram', 'whatsapp', 'website', 'other']);

/**
 * Aliases, longest-intent first.
 *
 * `exact` matches a whole token and is where the dangerously short aliases live
 * — "wa" as a substring hits "wardrobe", "walk-in" and "ওয়ারেন্টি"; as a token
 * it means WhatsApp. `contains` matches anywhere and is safe only for strings
 * long enough to be unambiguous.
 *
 * Bengali spellings are listed rather than transliterated at runtime: there is
 * no single correct romanisation of হোয়াটসঅ্যাপ, and shops type all of them.
 */
const CHANNEL_ALIASES = Object.freeze([
  {
    channel: 'facebook',
    exact: ['fb', 'ফেবু'],
    contains: ['facebook', 'face book', 'messenger', 'ফেসবুক', 'ফেইসবুক', 'মেসেঞ্জার', 'ম্যাসেঞ্জার', 'ইনবক্স'],
  },
  {
    channel: 'instagram',
    exact: ['ig', 'insta', 'ইনস্টা', 'ইন্সটা'],
    contains: ['instagram', 'ইনস্টাগ্রাম', 'ইন্সটাগ্রাম'],
  },
  {
    channel: 'whatsapp',
    exact: ['wa'],
    contains: ['whatsapp', 'whats app', 'what\'s app', 'হোয়াটসঅ্যাপ', 'হোয়াটস্যাপ', 'ওয়াটসঅ্যাপ', 'হোয়াটসাপ'],
  },
  {
    channel: 'website',
    exact: ['web', 'site'],
    contains: ['website', 'web site', 'ওয়েবসাইট', 'ওয়েব সাইট'],
  },
]);

/**
 * Split a note into comparable tokens.
 *
 * Punctuation and the Bengali danda are separators so "FB/WhatsApp" and
 * "ফোন। ফেসবুক" both tokenise. Case is folded for Latin; Bengali has no case,
 * so `toLowerCase` is a no-op there and costs nothing.
 */
function tokenize(note) {
  return String(note || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * Map a shop's free-text source note onto the `Sale.channel` enum.
 *
 * @param {string|null|undefined} sourceNote What the shop typed ("Facebook",
 *   "ফোন", "WhatsApp আপা"). Anything falsy reads as `other`.
 * @returns {'facebook'|'instagram'|'whatsapp'|'website'|'other'}
 */
function channelFromNote(sourceNote) {
  const raw = String(sourceNote || '').toLowerCase().trim();
  if (!raw) return 'other';

  const tokens = tokenize(raw);
  const tokenSet = new Set(tokens);

  // `contains` before `exact`: a full word is stronger evidence than a token
  // that merely happens to be short. "instagram" must not be decided by the
  // "ig" rule reading a stray token somewhere else in the same note.
  for (const entry of CHANNEL_ALIASES) {
    if (entry.contains.some((needle) => raw.includes(needle))) return entry.channel;
  }
  for (const entry of CHANNEL_ALIASES) {
    if (entry.exact.some((token) => tokenSet.has(token))) return entry.channel;
  }
  return 'other';
}

/**
 * The channel for an `Order` becoming a `Sale`.
 *
 * A storefront order is `website` by construction — it was placed on the
 * website, whatever anybody typed anywhere. Only a manual order consults the
 * note, because only a manual order has one.
 *
 * @param {{source?: string, sourceNote?: string}} order
 * @returns {string} A member of `SALE_CHANNELS`.
 */
function channelForOrder(order) {
  if (!order) return 'other';
  if (order.source === 'storefront') return 'website';
  return channelFromNote(order.sourceNote);
}

module.exports = { SALE_CHANNELS, channelFromNote, channelForOrder };

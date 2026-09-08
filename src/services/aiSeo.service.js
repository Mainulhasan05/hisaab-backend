/**
 * Write a shop's search-result text, and a product's online description, with
 * the platform's Gemini pool.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE INHERITS: THE AI NEVER WRITES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Same rule as `aiExpense.service.js`, for a different reason. There the stake
 * was an immutable ledger row. Here it is worse in one specific way and milder
 * in every other: nothing is immutable, but the output is PUBLISHED UNDER THE
 * SHOP'S NAME, to their customers, in their language, and a wrong claim in a
 * meta description ("সারা দেশে ফ্রি ডেলিভারি") is a promise a shopkeeper never
 * made and will be held to.
 *
 * So both methods return a SUGGESTION. `generateShopSeo` writes nothing;
 * `generateProductDescription` writes nothing. The shopkeeper reads it, edits
 * it, and saves it through the ordinary editor — which for the shop block also
 * means it lands in the DRAFT and still needs a publish.
 *
 * That is also the whole prompt-injection answer. The only untrusted text
 * reaching these prompts is the shop's OWN product names and category names —
 * data they typed, about themselves, that they will read back on the next
 * screen. There is no third party in this loop to attack anyone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MODEL IS ASKED FOR JSON AND NOT PROSE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `responseSchema` + `responseMimeType: application/json` (both already
 * supported by gemini.service) means the answer arrives parseable instead of
 * arriving as "Here are three great options for your shop! 1. ...". Prose would
 * need a regex to dig the title out, and that regex is the bug.
 *
 * Every field is still re-checked here afterwards. A schema constrains shape,
 * not length and not language — the model will cheerfully return an 800
 * character description that satisfies `{type: string}`.
 */

const geminiService = require('./gemini.service');
const { AppError } = require('../middleware/error.middleware');
const {
  TITLE_LIMIT,
  DESCRIPTION_LIMIT,
  TITLE_MAX,
  DESCRIPTION_MAX,
  cleanText,
} = require('../utils/storefrontSeo.util');
const logger = require('../utils/logger.util');

/**
 * How many of the shop's categories and products go into the prompt.
 *
 * Enough for the model to tell a grocer from a clothing shop, which is the
 * entire job. Sending the whole catalogue would cost tokens per request for a
 * signal that saturates after about a dozen names — and on a 3,000-product shop
 * it would blow the context for no gain at all.
 */
const PROMPT_CATEGORY_LIMIT = 12;
const PROMPT_PRODUCT_LIMIT = 12;

/** Longest product description we will accept back. */
const PRODUCT_DESCRIPTION_MAX = 600;

/**
 * Ceiling on any single piece of shop text we paste into a prompt.
 *
 * Not a security control — see the header on why injection is not the threat
 * here — but a cost control. `onlineDescription` allows 2,000 characters and a
 * shop that has pasted an essay into one should not make every subsequent
 * request expensive.
 */
const MAX_FIELD_CHARS = 300;

const clip = (value, max = MAX_FIELD_CHARS) => cleanText(value).slice(0, max);

/**
 * Bengali and Arabic-Indic digits → ASCII, in prices we hand to the model.
 *
 * The prompt asks for Bangla prose but a PRICE inside it should read the way
 * the shop's own product pages read. This is the same defensive normalisation
 * `aiExpense` runs on the way in rather than trusting the instruction.
 */
const DIGIT_MAP = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};
const toAsciiDigits = (s) => String(s).replace(/[০-৯]/g, (d) => DIGIT_MAP[d] || d);

/**
 * The shared instruction block.
 *
 * Kept in one constant because the two prompts must not drift on the rules that
 * matter to a shopkeeper — Bangla, no invented facts, no promises about
 * delivery or price. A second copy is how the product prompt ends up allowed to
 * promise free shipping and the shop prompt is not.
 */
const HOUSE_RULES = [
  'ভাষা: বাংলা। ইংরেজি শব্দ কেবল তখনই যখন দোকানের নিজের নাম বা পণ্যের নাম ইংরেজিতে।',
  'যা দেওয়া হয়নি তা লিখবে না। ডেলিভারি চার্জ, ছাড়, ওয়ারেন্টি, "সবচেয়ে সস্তা", "১ নম্বর" — এসব কখনো লিখবে না।',
  'বিস্ময়বোধক চিহ্ন, ইমোজি, হ্যাশট্যাগ বা উদ্ধৃতি চিহ্ন ব্যবহার করবে না।',
  'সহজ, স্বাভাবিক বাংলা — যেভাবে একজন দোকানদার তার ক্রেতাকে বলবেন।',
].join('\n');

/**
 * Strip the wrapper a model sometimes puts around JSON despite being asked for
 * `application/json` — a ```json fence, or a sentence before the brace.
 *
 * `responseMimeType` makes this rare rather than impossible, and the cost of
 * being wrong is a 422 on a request the shop has already paid a message for.
 */
function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;

  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * "The model answered, and the answer was not usable."
 *
 * 422 specifically, because the controller refunds every status EXCEPT 422 —
 * this is the one case where a real Gemini call was made and a real answer came
 * back. Refunding it would let a loop of unusable requests cost the platform
 * unbounded quota at no cost to the sender. Same contract as `aiExpense`.
 */
const unreadable = (why) =>
  new AppError(
    `AI response could not be used: ${why}`,
    'এআই থেকে ব্যবহারযোগ্য উত্তর পাওয়া যায়নি। আবার চেষ্টা করুন।',
    422
  );

class AiSeoService {
  /**
   * A search title and meta description for the whole storefront.
   *
   * ── WHY THE CATALOGUE IS IN THE PROMPT ──────────────────────────────────
   *
   * "STUDENT HUB" tells a model nothing. "STUDENT HUB, categories: খাতা, কলম,
   * জ্যামিতি বক্স" tells it this is a stationery shop, which is the difference
   * between a description that could belong to any of the 36 shops on the
   * platform and one that could only belong to this one. Generic descriptions
   * are also precisely what Google discards in favour of its own snippet, so
   * the specific one is not a nicety — it is the feature working at all.
   *
   * @param {Object} shop      the Shop document (name, address, type)
   * @param {Object} context   `{ categories: string[], products: string[] }`
   * @returns {Promise<{title: string, description: string}>}
   */
  async generateShopSeo(shop, context = {}) {
    const name = clip(shop?.name, 100);
    if (!name) {
      throw new AppError('Shop has no name', 'দোকানের নাম পাওয়া যায়নি', 400);
    }

    const categories = (context.categories || [])
      .map((c) => clip(c, 40))
      .filter(Boolean)
      .slice(0, PROMPT_CATEGORY_LIMIT);
    const products = (context.products || [])
      .map((p) => clip(p, 60))
      .filter(Boolean)
      .slice(0, PROMPT_PRODUCT_LIMIT);
    const address = clip(shop?.address, 120);

    const prompt = [
      'তুমি একজন বাংলাদেশি অনলাইন দোকানের জন্য সার্চ ইঞ্জিনের টাইটেল ও বর্ণনা লেখো।',
      '',
      '### দোকানের তথ্য',
      `নাম: ${name}`,
      address ? `ঠিকানা: ${address}` : null,
      categories.length ? `পণ্যের ধরন: ${categories.join(', ')}` : null,
      products.length ? `কিছু পণ্য: ${products.join(', ')}` : null,
      '',
      '### নিয়ম',
      HOUSE_RULES,
      `title: দোকানের নাম দিয়ে শুরু, তারপর দোকানটি কী বিক্রি করে। সর্বোচ্চ ${TITLE_LIMIT} অক্ষর।`,
      `description: এক থেকে দুই বাক্য। দোকানটি কী বিক্রি করে এবং কোথায়। সর্বোচ্চ ${DESCRIPTION_LIMIT} অক্ষর।`,
      'দুটোতেই দোকানের নাম থাকতে হবে।',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await geminiService.generateContent(prompt, {
      // Low but not zero. At 0 every stationery shop in the country gets the
      // same sentence, which is the generic-description problem this method
      // exists to avoid; high, and it starts inventing shop attributes.
      temperature: 0.4,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title', 'description'],
      },
    });

    const parsed = parseJson(raw);
    if (!parsed) {
      logger.warn('[aiSeo] unparseable shop SEO response', { shop: String(shop?._id) });
      throw unreadable('not JSON');
    }

    const title = cleanText(parsed.title).slice(0, TITLE_MAX);
    const description = cleanText(parsed.description).slice(0, DESCRIPTION_MAX);

    // Truncated rather than rejected: a model that overshoots the guideline by
    // ten characters has still done the job, and a 422 here would spend the
    // shop's message on nothing. The hard `*_MAX` is the only real boundary,
    // and `normalizeSeo` enforces it again when this is saved.
    if (!title || !description) throw unreadable('missing title or description');

    return {
      title,
      description,
      // What the editor needs to render its counters honestly without
      // recomputing the guideline in the browser.
      limits: { title: TITLE_LIMIT, description: DESCRIPTION_LIMIT },
    };
  }

  /**
   * A customer-facing description for ONE product.
   *
   * ── WHY THIS EXISTS AT ALL, AND WHY IT IS PER-PRODUCT ───────────────────
   *
   * Product pages are where a storefront's search traffic comes from. A shop
   * with forty products and no descriptions has forty near-identical thin
   * pages, and Google treats those as one page or as none. The description is
   * the only per-product text most of these shops will ever have.
   *
   * One at a time, deliberately. A "write all forty" button would put forty
   * unreviewed paragraphs on a live site in one press, in the shop's voice,
   * about products the model has only seen the NAME of — and nobody would read
   * them before the customers did.
   *
   * @param {Object} shop
   * @param {Object} product  a Product document or lean object
   * @returns {Promise<{description: string}>}
   */
  async generateProductDescription(shop, product) {
    const productName = clip(product?.name, 120);
    if (!productName) {
      throw new AppError('Product has no name', 'পণ্যের নাম পাওয়া যায়নি', 400);
    }

    const categoryName = clip(product?.category?.name || '', 40);
    const brand = clip(product?.brand || '', 40);
    const unit = clip(product?.unit || '', 20);
    // The online price if the shop set one, otherwise the shelf price — the
    // same precedence the public product page uses, so the sentence the model
    // writes cannot quote a figure the customer will not see.
    const price = Number(product?.onlinePrice ?? product?.sellingPrice ?? 0);

    const prompt = [
      'তুমি একটি বাংলাদেশি অনলাইন দোকানের পণ্যের বর্ণনা লেখো, যা ক্রেতা পণ্যের পাতায় পড়বে।',
      '',
      '### পণ্যের তথ্য',
      `দোকান: ${clip(shop?.name, 100)}`,
      `পণ্যের নাম: ${productName}`,
      categoryName ? `ক্যাটাগরি: ${categoryName}` : null,
      brand ? `ব্র্যান্ড: ${brand}` : null,
      unit ? `একক: ${unit}` : null,
      price > 0 ? `দাম: ${toAsciiDigits(price)} টাকা` : null,
      '',
      '### নিয়ম',
      HOUSE_RULES,
      'দুই থেকে তিনটি বাক্য। পণ্যটি কী এবং কার কাজে লাগে — এটুকুই।',
      'পণ্যের নাম বাক্যের ভেতরে অন্তত একবার থাকতে হবে।',
      // The model is told the price so it does not contradict the page, and
      // told not to repeat it because the page already renders it — a price in
      // prose is a second copy that goes stale the day the shop changes it.
      'দামের অঙ্ক বর্ণনায় লিখবে না।',
      'উপকরণ, ওজন, সাইজ, রঙ বা মেয়াদ — যা উপরে দেওয়া হয়নি, অনুমান করে লিখবে না।',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await geminiService.generateContent(prompt, {
      temperature: 0.5,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { description: { type: 'string' } },
        required: ['description'],
      },
    });

    const parsed = parseJson(raw);
    if (!parsed) {
      logger.warn('[aiSeo] unparseable product description', {
        shop: String(shop?._id),
        product: String(product?._id),
      });
      throw unreadable('not JSON');
    }

    const description = cleanText(parsed.description).slice(0, PRODUCT_DESCRIPTION_MAX);
    if (!description) throw unreadable('empty description');

    return { description };
  }
}

module.exports = new AiSeoService();
module.exports.PRODUCT_DESCRIPTION_MAX = PRODUCT_DESCRIPTION_MAX;

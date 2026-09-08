const storefrontService = require('../services/storefront.service');
const aiSeoService = require('../services/aiSeo.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const aiQuota = require('../utils/aiQuota.util');
const logger = require('../utils/logger.util');
const { shopHasFeature } = require('../utils/features.util');
const {
  resolveSeo,
  TITLE_LIMIT,
  DESCRIPTION_LIMIT,
  TITLE_MAX,
  DESCRIPTION_MAX,
} = require('../utils/storefrontSeo.util');

/**
 * The shop's own storefront surface. Every route here is behind
 * `requireFeature('storefront')` — see routes/storefront.routes.js.
 */

// The storefront document plus the gallery the picker renders from. One call,
// because the panel's first screen needs both and a second round trip on a
// 3G connection is a second spinner.
exports.getStorefront = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.getStorefront(req.shop._id);
  const templates = await storefrontService.getTemplateGallery(req.shop);

  /**
   * Is Telegram ACTUALLY connected?
   *
   * `Storefront.notifications.telegram` is a preference and defaults ON, so
   * the settings screen showed a ticked switch to shops that had never linked
   * Telegram — or, worse, to one that linked it and later disconnected. New
   * orders then arrived in silence with a switch on screen insisting they
   * would not, which is exactly the failure I-21 names: a control that
   * promises something no code path performs.
   *
   * Reported here rather than fetched from `GET /telegram/status` because that
   * route is `ownerOnly` and this panel is open to managers too — a manager
   * would get a 403 and the screen would have to guess.
   */
  const TelegramLink = require('../models/TelegramLink.model');
  const telegramConnected = await TelegramLink.exists({
    shop: req.shop._id,
    isActive: true,
  });

  return ApiResponse.success(res, {
    data: {
      storefront,
      templates,
      telegramConnected: Boolean(telegramConnected),
      hasUnpublishedChanges: storefront.hasUnpublishedChanges(),
      // The public address. Built here rather than in the client so the client
      // never has to know how storefront URLs are shaped — that changes when
      // subdomains land (ECOMMERCE_PLAN.md §8.5) and this is the one place it
      // should change.
      publicPath: `/s/${req.shop.slug}`,
    },
    message: 'Storefront retrieved successfully',
    messageBn: 'অনলাইন দোকানের তথ্য লোড হয়েছে',
  });
});

exports.getTemplates = asyncHandler(async (req, res) => {
  const templates = await storefrontService.getTemplateGallery(req.shop);
  return ApiResponse.success(res, {
    data: templates,
    message: 'Templates retrieved successfully',
    messageBn: 'টেমপ্লেট তালিকা লোড হয়েছে',
  });
});

exports.applyTemplate = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.applyTemplate(
    req.shop,
    req.user._id,
    req.body.template
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Template applied',
    messageBn: 'টেমপ্লেট প্রয়োগ করা হয়েছে — প্রিভিউ দেখে প্রকাশ করুন',
  });
});

exports.updateDraft = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.updateDraft(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Draft saved',
    messageBn: 'ড্রাফট সংরক্ষণ করা হয়েছে',
  });
});

exports.publish = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.publish(req.shop._id, req.user._id);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Storefront published',
    messageBn: 'ওয়েবসাইট প্রকাশ করা হয়েছে',
  });
});

exports.rollback = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.rollback(
    req.shop._id,
    req.user._id,
    req.params.version
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Version restored into draft',
    messageBn: 'সংস্করণটি ড্রাফটে ফেরানো হয়েছে',
  });
});

exports.setStatus = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.setStatus(
    req.shop._id,
    req.user._id,
    req.body.status
  );
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Storefront status updated',
    messageBn: storefront.status === 'live'
      ? 'অনলাইন দোকান চালু করা হয়েছে'
      : 'অনলাইন দোকান সাময়িকভাবে বন্ধ করা হয়েছে',
  });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.updateSettings(req.shop._id, req.body);
  return ApiResponse.success(res, {
    data: storefront,
    message: 'Settings updated',
    messageBn: 'সেটিংস সংরক্ষণ করা হয়েছে',
  });
});

// ── SEO ─────────────────────────────────────────────────────────────────────

/**
 * The storefront's search text, resolved, plus what the editor needs to judge
 * it: the guideline lengths, the public URL it will appear under, and whether
 * the draft is ahead of what is live.
 *
 * Separate from `GET /storefront` even though that already returns the whole
 * document, because this screen needs the RESOLVED values — title falling back
 * to the shop name, ogImage falling back to the logo — and the shop needs to be
 * able to tell which of those they actually wrote. Making the editor re-derive
 * the fallbacks in the browser is how the preview and the live page drift.
 */
exports.getSeo = asyncHandler(async (req, res) => {
  const storefront = await storefrontService.getStorefront(req.shop._id);
  const draft = storefront.draft?.seo || {};
  const published = storefront.published?.seo || {};

  return ApiResponse.success(res, {
    data: {
      // What the shop has typed, unresolved — this is what the input boxes bind
      // to, and an empty box must stay empty rather than filling with a default
      // the shop would then "save" as their own words.
      draft: {
        title: draft.title || '',
        description: draft.description || '',
        ogImage: draft.ogImage || null,
      },
      // What the pages will actually render once this is published.
      preview: resolveSeo(req.shop, draft),
      // What customers see RIGHT NOW. The editor renders the difference so
      // "প্রকাশ করুন" is visibly the thing that changes Google's copy.
      live: storefront.published?.template ? resolveSeo(req.shop, published) : null,
      limits: {
        title: TITLE_LIMIT,
        description: DESCRIPTION_LIMIT,
        titleMax: TITLE_MAX,
        descriptionMax: DESCRIPTION_MAX,
      },
      publicPath: `/s/${req.shop.slug}`,
      hasUnpublishedChanges: storefront.hasUnpublishedChanges(),
      // Whether pressing publish would actually reach Google. A shop editing
      // SEO on an unpublished site is doing invisible work and should be told.
      isLive: storefront.status === 'live' && !storefront.pausedByAdmin,
      aiEnabled: shopHasFeature(req.shop, 'aiSeo'),
    },
    message: 'Storefront SEO retrieved',
    messageBn: 'এসইও তথ্য লোড হয়েছে',
  });
});

/**
 * How many AI messages this BRANCH has left today. Spends nothing.
 *
 * The same endpoint shape as `GET /expenses/ai/usage`, against the same
 * counter, because it IS the same allowance — see the `aiSeo` feature note. The
 * SEO screen calls it on mount so the remaining-messages pill is right before
 * the shopkeeper presses anything.
 */
exports.getAiUsage = asyncHandler(async (req, res) => {
  const usage = await aiQuota.getUsage(req.shop, req.branchId || null);
  return ApiResponse.success(res, {
    data: usage,
    message: 'AI usage retrieved',
    messageBn: 'এআই ব্যবহারের হিসাব লোড হয়েছে',
  });
});

/**
 * Spend one AI message, run `work`, and hand the message back if the failure
 * was ours.
 *
 * ── WHY BOTH AI ROUTES GO THROUGH ONE HELPER ────────────────────────────────
 *
 * The refund rule has exactly one subtlety and it must not be written twice:
 * every failure refunds EXCEPT 422. A 422 means the model was called, answered,
 * and the answer was unusable — a real Gemini call was spent on it, and
 * refunding those would let a loop of unusable requests cost the platform
 * unbounded quota at no cost to the sender. Everything else (pool exhausted,
 * timeout, Google 5xx) is our problem, not the shopkeeper's.
 *
 * That is the same contract `expense.controller.aiParse` documents. Two copies
 * of it would drift, and the direction they drift in costs either the platform
 * money or the shopkeeper their allowance.
 */
async function withAiMessage(req, res, work) {
  const branchId = req.branchId || null;
  const reservation = await aiQuota.spend(req.shop, branchId);

  if (!reservation.ok) {
    return ApiResponse.tooManyRequests(res, {
      message: `Daily AI message limit reached (${reservation.limit})`,
      messageBn: reservation.limit === 0
        ? 'এই দোকানে এআই বার্তার বরাদ্দ নেই। প্ল্যাটফর্ম অ্যাডমিনের সাথে যোগাযোগ করুন।'
        : `আজকের ${reservation.limit}টি এআই বার্তা শেষ হয়েছে। আগামীকাল আবার চেষ্টা করুন।`,
    });
  }

  try {
    return await work(reservation);
  } catch (err) {
    if (err?.statusCode !== 422) {
      await aiQuota
        .refund(req.shop, branchId, reservation.dayKey)
        .catch((refundErr) =>
          // A failed refund must not replace the real error with a worse one.
          // The shopkeeper loses one message; the log is how we find out.
          logger.warn('Failed to refund AI message', {
            shop: String(req.shop._id),
            branch: branchId ? String(branchId) : null,
            error: refundErr?.message,
          })
        );
    }
    throw err;
  }
}

/**
 * Draft a search title and description for this storefront. WRITES NOTHING.
 *
 * The shop's own catalogue goes into the prompt — category names and a handful
 * of product names — because "STUDENT HUB" alone produces a sentence that would
 * fit any of the 36 shops on this platform, and a generic description is
 * exactly what Google discards in favour of its own snippet.
 *
 * ONLINE products only, and through the same `isAvailableOnline` filter the
 * public pages use. Feeding the model the shop's whole internal catalogue would
 * have it describe a business selling things the website does not.
 */
exports.aiGenerateSeo = asyncHandler(async (req, res) =>
  withAiMessage(req, res, async (reservation) => {
    const context = await storefrontService.getSeoContext(req.shop._id);
    const result = await aiSeoService.generateShopSeo(req.shop, context);

    return ApiResponse.success(res, {
      data: {
        ...result,
        usage: {
          limit: reservation.limit,
          usedToday: reservation.usedToday,
          remaining: reservation.remaining,
        },
      },
      message: 'SEO text generated',
      messageBn: 'এআই লেখা তৈরি করেছে — দেখে নিয়ে সেভ করুন',
    });
  })
);

/**
 * Draft one product's customer-facing description. WRITES NOTHING.
 *
 * The product is loaded through the SHOP's own filter, so a product id from
 * another shop is a 404 rather than a description of somebody else's stock.
 */
exports.aiGenerateProductDescription = asyncHandler(async (req, res) =>
  withAiMessage(req, res, async (reservation) => {
    const product = await storefrontService.getProductForSeo(
      req.shop._id,
      req.params.productId
    );
    const result = await aiSeoService.generateProductDescription(req.shop, product);

    return ApiResponse.success(res, {
      data: {
        ...result,
        product: { id: String(product._id), name: product.name },
        usage: {
          limit: reservation.limit,
          usedToday: reservation.usedToday,
          remaining: reservation.remaining,
        },
      },
      message: 'Product description generated',
      messageBn: 'পণ্যের বর্ণনা তৈরি হয়েছে — দেখে নিয়ে সেভ করুন',
    });
  })
);

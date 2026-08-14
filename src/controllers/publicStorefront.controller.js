const publicStorefrontService = require('../services/publicStorefront.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * The public storefront controller.
 *
 * Every handler here runs WITHOUT `protect`, so there is no `req.user`, no
 * `req.shop` and no `req.branchId`. If a change to this file starts reading any
 * of them it is reading `undefined` — and `{ shop: undefined }` is not an
 * error, it is a filter Mongoose strips, which queries the entire platform
 * (I-5). The shop comes from the slug in the URL and from nowhere else.
 *
 * `Cache-Control` is set per handler rather than globally because the three
 * reads change at genuinely different rates, and a single conservative number
 * for all of them would either serve stale prices or waste the CDN.
 */

/**
 * Shared caching policy for public reads.
 *
 * `s-maxage` lets a CDN and Next's own fetch cache hold the page;
 * `stale-while-revalidate` means a customer never waits on a revalidation —
 * they get the slightly-old page instantly and the refresh happens behind them.
 * On a 3G connection that difference is the whole LCP budget.
 *
 * Deliberately SHORT for anything carrying a price. A shopkeeper who corrects a
 * price expects the site to agree with them within a minute or so, and §4.5 is
 * explicit that the catalogue is live while only presentation is staged — a
 * long TTL here would quietly reintroduce the publish step for prices.
 */
const cache = (res, seconds, swr = 300) => {
  res.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${swr}`);
};

exports.getHome = asyncHandler(async (req, res) => {
  const data = await publicStorefrontService.getHome(req.params.slug);
  cache(res, 60);
  return ApiResponse.success(res, {
    data,
    message: 'Storefront loaded',
    messageBn: 'দোকানের তথ্য লোড হয়েছে',
  });
});

exports.listProducts = asyncHandler(async (req, res) => {
  const { products, pagination, category } = await publicStorefrontService.listProducts(
    req.params.slug,
    {
      category: req.query.category,
      q: req.query.q,
      sort: req.query.sort,
      tag: req.query.tag,
      // Query strings are strings. `offers=false` is truthy, and a filter that
      // silently inverts is worse than one that errors.
      offers: req.query.offers === 'true',
      page: req.query.page,
      limit: req.query.limit,
    }
  );

  // A search result is per-visitor and near-worthless to cache; a category page
  // is shared by everyone who taps that tile.
  cache(res, req.query.q ? 0 : 60);

  return ApiResponse.paginated(res, {
    data: products,
    pagination,
    message: 'Products loaded',
    messageBn: 'পণ্য তালিকা লোড হয়েছে',
    meta: { category },
  });
});

exports.getProduct = asyncHandler(async (req, res) => {
  const data = await publicStorefrontService.getProduct(req.params.slug, req.params.code);
  cache(res, 60);
  return ApiResponse.success(res, {
    data,
    message: 'Product loaded',
    messageBn: 'পণ্যের তথ্য লোড হয়েছে',
  });
});

/**
 * The slug + product-code list a sitemap is built from.
 *
 * Separate from `listProducts` because it answers a different question and must
 * not inherit its shape: a sitemap wants every URL with no pagination and no
 * product detail, and reusing the paged read would have meant walking it 40
 * pages at a time to build one XML file.
 *
 * `Product` + `Offer` structured data on those pages is what puts a shop into
 * Google's free Shopping listings (§8.4) — for a small Bangladeshi retailer
 * that is real traffic, and it costs us this endpoint plus a schema block.
 */
exports.getSitemap = asyncHandler(async (req, res) => {
  const data = await publicStorefrontService.getSitemap(req.params.slug);
  // A day. Crawlers are not customers and re-fetch on their own schedule.
  cache(res, 3600, 86400);
  return ApiResponse.success(res, {
    data,
    message: 'Sitemap loaded',
    messageBn: 'সাইটম্যাপ লোড হয়েছে',
  });
});

/**
 * SMS earnings — what a send cost us, what it earned us, and the gap.
 *
 * ── The two rates ────────────────────────────────────────────────────────────
 *
 * COST is per PROVIDER. Each gateway charges its own rate per segment, and after
 * failover the gateway that carried a message is not always the one the settings
 * name. Cost is therefore read from the provider that actually sent it, at the
 * rate in force at that moment, and stamped on the row. Nothing recomputes it
 * later from today's rates.
 *
 * REVENUE is per SHOP, and it is recognised on CONSUMPTION rather than on sale.
 * A shop that buys a 5,000-message pack has paid, but the platform now owes them
 * 5,000 messages; booking the whole pack as revenue in the month of purchase
 * overstates that month and leaves every month the pack is actually used looking
 * like pure cost. Each send recognises its own slice instead, at the blended
 * rate the shop genuinely paid across its top-ups.
 *
 * ── On unpriced providers ────────────────────────────────────────────────────
 *
 * If a gateway's rate has never been entered, cost resolves to `null` and the
 * segments are counted as UNPRICED rather than as free. Reporting a zero cost
 * would show a 100% margin on real spending, which is the one number an operator
 * must never be shown by accident.
 */

const PlatformSetting = require('../../models/PlatformSetting.model');
const SMSQuota = require('../../models/SMSQuota.model');
const Shop = require('../../models/Shop.model');
const SmsEarning = require('../../models/SmsEarning.model');
const logger = require('../../utils/logger.util');
const { bounded } = require('./bounded');

const RATE_TTL_MS = Number(process.env.SMS_RATE_CACHE_MS) || 60000;
// See routing.js: a fallback is held briefly so one outage costs one wait, not
// one wait per message.
const RATE_FALLBACK_TTL_MS = Number(process.env.SMS_RATE_FALLBACK_CACHE_MS) || 5000;

let rateCache = null;
let rateCachedAt = 0;
let rateCachedTtl = RATE_TTL_MS;
const shopRateCache = new Map();

/**
 * Platform rates: per-provider cost, plus the default a shop is charged.
 *
 * Cached briefly for the same reason routing is — a campaign must not re-read
 * the settings document once per message. Never throws; an unreadable settings
 * document yields nulls, which the callers treat as "unpriced" rather than free.
 */
async function platformRates({ force = false } = {}) {
  if (!force && rateCache && Date.now() - rateCachedAt < rateCachedTtl) return rateCache;

  try {
    const settings = await bounded(PlatformSetting.current(), null, {
      onTimeout: (why) => logger.warn(`[sms/earnings] rate lookup slow/failed (${why})`),
    });
    rateCache = {
      // The single-rate setting stays the fallback, so a platform that has only
      // ever priced one gateway keeps reporting correctly.
      fallbackCost: settings?.platformSmsCost ?? null,
      providerCost: {
        mimsms: settings?.smsProviderCost?.mimsms ?? null,
        automas: settings?.smsProviderCost?.automas ?? null,
      },
      defaultSellPrice: settings?.defaultSmsUnitPrice ?? null,
    };
    rateCachedTtl = settings ? RATE_TTL_MS : RATE_FALLBACK_TTL_MS;
    rateCachedAt = Date.now();
    return rateCache;
  } catch (err) {
    logger.error(`[sms/earnings] rate lookup failed: ${err.message}`);
    rateCache = { fallbackCost: null, providerCost: {}, defaultSellPrice: null };
    rateCachedTtl = RATE_FALLBACK_TTL_MS;
    rateCachedAt = Date.now();
    return rateCache;
  }
}

/** ৳ per segment this gateway charges us, or null if we have never been told. */
async function costRateFor(provider) {
  const rates = await platformRates();
  const specific = rates.providerCost?.[provider];
  if (specific !== null && specific !== undefined) return specific;
  return rates.fallbackCost;
}

/**
 * ৳ per segment this shop actually paid for its quota.
 *
 * Preference order, most truthful first:
 *
 *   1. The blended rate across their own top-ups — total taka paid ÷ total
 *      messages bought. This is what they REALLY paid, including any discounted
 *      pack and any negotiated one-off, and it is the only figure that stays
 *      right after a price change.
 *   2. Their negotiated per-shop rate, if they have one but no recorded top-ups.
 *   3. The platform list price.
 *
 * Cached per shop for the same TTL as everything else here; a campaign resolves
 * it once.
 */
async function sellRateFor(shopId) {
  if (!shopId) return 0; // Platform broadcasts earn nothing — they are pure cost.

  const key = String(shopId);
  const hit = shopRateCache.get(key);
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.rate;

  let rate = null;
  try {
    const quota = await bounded(
      SMSQuota.findOne({ shop: shopId }).select('allocations').lean(), null,
      { onTimeout: (why) => logger.warn(`[sms/earnings] quota rate lookup slow/failed (${why})`) }
    );
    const allocations = quota?.allocations || [];

    const totals = allocations.reduce((acc, a) => {
      const qty = Number(a?.quantity) || 0;
      const price = Number(a?.price) || 0;
      if (qty > 0) { acc.qty += qty; acc.paid += price; }
      return acc;
    }, { qty: 0, paid: 0 });

    if (totals.qty > 0 && totals.paid > 0) {
      rate = totals.paid / totals.qty;
    } else {
      const shop = await bounded(
        Shop.findById(shopId).select('billing.smsUnitPrice').lean(), null,
        { onTimeout: (why) => logger.warn(`[sms/earnings] shop rate lookup slow/failed (${why})`) }
      );
      const negotiated = shop?.billing?.smsUnitPrice;
      rate = (negotiated !== null && negotiated !== undefined)
        ? Number(negotiated)
        : (await platformRates()).defaultSellPrice;
    }
  } catch (err) {
    logger.error(`[sms/earnings] sell-rate lookup failed for ${key}: ${err.message}`);
    rate = (await platformRates()).defaultSellPrice;
  }

  const resolved = Number.isFinite(Number(rate)) ? Number(rate) : 0;
  shopRateCache.set(key, { rate: resolved, at: Date.now() });
  return resolved;
}

/**
 * Price one send and book it.
 *
 * Returns the figures so the caller can stamp them on the SMSLog row in the same
 * write it was going to make anyway — the log keeps the detail until the TTL
 * takes it, and this collection keeps the money forever.
 *
 * NEVER THROWS. Accounting sits downstream of delivery: a booking failure must
 * not turn a delivered message into a failed one, and must not abort a campaign
 * halfway. Failures are logged and the send continues.
 */
async function priceAndRecord({
  shopId = null,
  provider,
  segments = 0,
  failedOver = false,
  failed = false,
  at = new Date(),
} = {}) {
  const blank = {
    provider, billedSegments: segments,
    unitCost: null, totalCost: null, revenue: null, unpriced: true,
  };
  if (!provider || !segments || segments <= 0) return { ...blank, billedSegments: 0 };

  try {
    const [unitCost, sellRate] = await Promise.all([
      costRateFor(provider),
      sellRateFor(shopId),
    ]);

    const unpriced = unitCost === null || unitCost === undefined;
    const totalCost = unpriced ? null : Number((unitCost * segments).toFixed(4));

    // A failed send delivered nothing, so it earns nothing — but it may still
    // have cost us, which is why cost is booked and revenue is not.
    const revenue = failed ? 0 : Number((sellRate * segments).toFixed(4));

    await SmsEarning.record({
      shop: shopId || null,
      provider,
      segments,
      revenue,
      gatewayCost: totalCost || 0,
      unpriced,
      failedOver,
      failed,
      at,
    });

    return {
      provider,
      billedSegments: segments,
      unitCost: unpriced ? null : unitCost,
      totalCost,
      revenue,
      unpriced,
    };
  } catch (err) {
    logger.error(`[sms/earnings] failed to record earnings: ${err.message}`);
    return blank;
  }
}

/**
 * The earnings report.
 *
 * Grouped by period and provider by default, because "which gateway made us
 * money this month" is the question the two-provider setup exists to raise.
 */
async function report({ from = null, to = null, shopId = null, provider = null, groupBy = 'period' } = {}) {
  const match = {};
  if (from) match.period = { ...(match.period || {}), $gte: from };
  if (to) match.period = { ...(match.period || {}), $lte: to };
  if (shopId) match.shop = shopId;
  if (provider) match.provider = provider;

  const groupKey = groupBy === 'shop'
    ? { shop: '$shop', provider: '$provider' }
    : groupBy === 'provider'
      ? { provider: '$provider' }
      : { period: '$period', provider: '$provider' };

  const rows = await SmsEarning.aggregate([
    { $match: match },
    {
      $group: {
        _id: groupKey,
        messages: { $sum: '$messages' },
        segments: { $sum: '$segments' },
        revenue: { $sum: '$revenue' },
        gatewayCost: { $sum: '$gatewayCost' },
        unpricedSegments: { $sum: '$unpricedSegments' },
        failedOverSegments: { $sum: '$failedOverSegments' },
        failedSegments: { $sum: '$failedSegments' },
      },
    },
    { $sort: { '_id.period': -1, '_id.provider': 1 } },
  ]);

  const shaped = rows.map((r) => {
    const margin = r.revenue - r.gatewayCost;
    return {
      ...r._id,
      messages: r.messages,
      segments: r.segments,
      revenue: round(r.revenue),
      gatewayCost: round(r.gatewayCost),
      margin: round(margin),
      // A percentage of zero revenue is not 0%, it is undefined — and printing
      // 0% next to real spending reads as break-even rather than as a loss.
      marginPercent: r.revenue > 0 ? round((margin / r.revenue) * 100, 2) : null,
      unpricedSegments: r.unpricedSegments,
      failedOverSegments: r.failedOverSegments,
      failedSegments: r.failedSegments,
      // The honest caveat, carried on every row rather than in a footnote.
      costIsFloor: r.unpricedSegments > 0,
    };
  });

  const totals = shaped.reduce((acc, r) => {
    acc.messages += r.messages;
    acc.segments += r.segments;
    acc.revenue += r.revenue;
    acc.gatewayCost += r.gatewayCost;
    acc.unpricedSegments += r.unpricedSegments;
    acc.failedOverSegments += r.failedOverSegments;
    return acc;
  }, { messages: 0, segments: 0, revenue: 0, gatewayCost: 0, unpricedSegments: 0, failedOverSegments: 0 });

  totals.revenue = round(totals.revenue);
  totals.gatewayCost = round(totals.gatewayCost);
  totals.margin = round(totals.revenue - totals.gatewayCost);
  totals.marginPercent = totals.revenue > 0 ? round((totals.margin / totals.revenue) * 100, 2) : null;
  totals.costIsFloor = totals.unpricedSegments > 0;

  return { rows: shaped, totals };
}

function round(n, dp = 2) {
  const v = Number(n) || 0;
  return Number(v.toFixed(dp));
}

/** Drop cached rates — called when an admin changes pricing. */
function invalidate() {
  rateCache = null;
  rateCachedAt = 0;
  rateCachedTtl = RATE_TTL_MS;
  shopRateCache.clear();
}

module.exports = {
  platformRates,
  costRateFor,
  sellRateFor,
  priceAndRecord,
  report,
  invalidate,
};

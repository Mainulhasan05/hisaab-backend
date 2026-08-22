/**
 * "Which gateway sends this, and which catches it if that fails?"
 *
 * Resolved ONCE per request or per campaign — never per message. A 5,000-message
 * campaign that resolves per message is 5,000 database round-trips to re-read a
 * document that cannot have changed, which is why `resolve()` returns a plain
 * object the caller passes down rather than something callers re-derive.
 *
 * ── Why an in-process cache and not Redis ────────────────────────────────────
 *
 * The routing decision is platform-wide: one document, the same answer for every
 * shop. That is a very different shape from a per-tenant lookup, where a shared
 * cache earns its keep by avoiding a database read per tenant per message. Here
 * a short TTL over a single value gets the same benefit for none of the
 * operational surface.
 *
 * The cost is honest and bounded: with several PM2 workers, each holds its own
 * copy, so a change made in the admin panel takes up to TTL_MS to be picked up
 * by workers other than the one that served the write. Thirty seconds of a
 * campaign continuing on the previous gateway is an acceptable price; anything
 * longer would not be, which is why the TTL is short rather than generous.
 *
 * If per-shop routing is ever added, this is the module that grows a Redis hash
 * keyed by provider with a negative-cache sentinel — the send paths above should
 * not need to change.
 */

const PlatformSetting = require('../../models/PlatformSetting.model');
const registry = require('./registry');
const logger = require('../../utils/logger.util');
const { bounded } = require('./bounded');

const TTL_MS = Number(process.env.SMS_ROUTING_CACHE_MS) || 30000;

/**
 * How long a FALLBACK answer is held.
 *
 * Shorter than the success TTL, because it is a guess standing in for a real
 * answer and should be re-tried soon — but not zero, which is the trap this
 * exists to avoid: without it, every message during a database outage pays the
 * lookup timeout again, so a campaign of fifty batches spends a minute and a
 * half waiting for the same failure fifty times over. One outage, one wait.
 */
const FALLBACK_TTL_MS = Number(process.env.SMS_ROUTING_FALLBACK_CACHE_MS) || 5000;

let cached = null;
let cachedAt = 0;
let cachedTtl = TTL_MS;

/** Env-only answer. The floor beneath everything, used when the DB is unreachable. */
function envFallback() {
  const primary = registry.getDefaultProviderName();
  return {
    primaryProvider: primary,
    failoverProvider: null,
    failoverEnabled: process.env.SMS_FAILOVER_ENABLED === 'true',
    source: 'env',
  };
}

/**
 * The current routing settings.
 *
 * Never throws. A settings read that fails must not be what stops a shop from
 * sending a receipt — the platform default is a perfectly good answer, and it is
 * the answer the system had before this feature existed.
 */
async function resolve({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < cachedTtl) {
    return cached;
  }

  try {
    // Bounded: which gateway to use is not worth ten seconds of a buffering
    // Mongo driver on every message. See bounded.js.
    const settings = await bounded(PlatformSetting.current(), null, {
      onTimeout: (why) => logger.warn(`[sms] routing lookup slow/failed (${why}) — using default`),
    });

    // A stored name that is no longer a registered provider must not take the
    // platform down with it — fall back and say so loudly.
    let primary = settings?.smsPrimaryProvider || null;
    if (primary && !registry.isKnownProvider(primary)) {
      logger.warn(`[sms] stored primary provider '${primary}' is not registered — using default`);
      primary = null;
    }

    let failover = settings?.smsFailoverProvider || null;
    if (failover && !registry.isKnownProvider(failover)) {
      logger.warn(`[sms] stored failover provider '${failover}' is not registered — ignoring`);
      failover = null;
    }

    // A failover equal to the primary is not failover. Guarded on write too;
    // this is the belt to that write-path's braces, for rows that predate it.
    if (failover && registry.normalizeName(failover) === registry.normalizeName(primary || registry.getDefaultProviderName())) {
      failover = null;
    }

    cached = {
      primaryProvider: registry.normalizeName(primary) || registry.getDefaultProviderName(),
      failoverProvider: failover ? registry.normalizeName(failover) : null,
      failoverEnabled: Boolean(settings?.smsFailoverEnabled),
      source: settings ? 'settings' : 'env',
    };
    // A null `settings` means the read timed out or failed and this is the env
    // fallback wearing the shape of an answer. Hold it briefly rather than
    // permanently, so the next send after the database recovers picks up the
    // real configuration.
    cachedTtl = settings ? TTL_MS : FALLBACK_TTL_MS;
    cachedAt = Date.now();
    return cached;
  } catch (err) {
    logger.error(`[sms] routing lookup failed (${err.message}) — falling back to env default`);
    cached = envFallback();
    cachedTtl = FALLBACK_TTL_MS;
    cachedAt = Date.now();
    return cached;
  }
}

/**
 * Drop the cached answer.
 *
 * Called by the admin write path so the instance that served the change reflects
 * it immediately. Other instances catch up within TTL_MS — see the header.
 */
function invalidate() {
  cached = null;
  cachedAt = 0;
  cachedTtl = TTL_MS;
}

/**
 * The full picture for the admin screen: what is set, what it resolves to, and
 * whether the chosen gateways actually have credentials.
 */
async function describe() {
  const routing = await resolve({ force: true });
  const primaryConfigured = (() => {
    try { return registry.getAdapter(routing.primaryProvider).isConfigured(); } catch { return false; }
  })();
  const failoverConfigured = routing.failoverProvider
    ? (() => {
      try { return registry.getAdapter(routing.failoverProvider).isConfigured(); } catch { return false; }
    })()
    : false;

  return {
    ...routing,
    primaryConfigured,
    failoverConfigured,
    // Failover that is switched on but has nothing usable behind it is the
    // failure mode worth surfacing: it looks armed on the screen and does
    // nothing at 2am.
    failoverEffective: routing.failoverEnabled
      && (failoverConfigured || Boolean(registry.getAnyOtherConfigured(routing.primaryProvider))),
  };
}

module.exports = { resolve, invalidate, describe, TTL_MS };

/**
 * Who the request actually came from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `req.ip`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `req.ip` is never falsy on a real Express request. With no trusted
 * `X-Forwarded-For` to resolve, it returns the SOCKET address — and behind a
 * reverse proxy on the same host that is `::ffff:127.0.0.1`. Two separate
 * places wrote `req.ip || req.headers['x-forwarded-for']` as a safety net and
 * neither net could ever be reached, because the thing on the left is always
 * truthy. Both recorded a loopback address for every request in production:
 * the founder's Telegram alerts, and the audit trail.
 *
 * The other half of it: `app.set('trust proxy', …)` makes Express read ONLY
 * `X-Forwarded-For`. A proxy configured to set just `X-Real-IP` — an entirely
 * ordinary nginx block — leaves `req.ip` on loopback with the answer sitting in
 * a header beside it, and nothing in Express will ever look there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER, AND WHY IT IS THIS ORDER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `req.ip` is tried FIRST, because when it works it is the only candidate that
 * cannot be forged. `trust proxy: 1` makes Express drop the hop nearest the
 * server and take the entry to its left, so a client that sends its own
 * `X-Forwarded-For: 1.2.3.4` has that value pushed left and ignored.
 *
 * Everything after it is a header, and a header is only as trustworthy as the
 * proxy in front. `X-Real-IP` and `CF-Connecting-IP` are single-valued and are
 * SET (overwritten) by a correctly configured proxy, so a forged one does not
 * survive the hop. The first entry of `X-Forwarded-For` is last precisely
 * because it is the one a client controls — nginx's `$proxy_add_x_forwarded_for`
 * APPENDS, so a request that arrives already carrying the header keeps its own
 * value at the front. It is here as a last resort, not as a preference.
 *
 * These are reached only when `req.ip` is internal, i.e. when `trust proxy`
 * found nothing to resolve. If that happens on a deployment that also does not
 * overwrite `X-Real-IP`, the address is attacker-suppliable — the fix for that
 * is in the nginx config, not here.
 *
 * ── If Cloudflare is ever put in front of the API ────────────────────────────
 *
 * That is two hops, and `app.js` trusts one. `req.ip` would resolve to a
 * Cloudflare edge address — public, so this function would return it and stop
 * before reaching `CF-Connecting-IP`. Raise `trust proxy` to 2 at that point;
 * do not reorder this list, or the header becomes forgeable for everyone who is
 * NOT behind Cloudflare.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTERNAL ADDRESSES ARE SKIPPED, NOT REJECTED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A loopback or RFC1918 address means "this arrived on our own wire" — it
 * answers which machine, not who. So the walk keeps going when it sees one.
 * But the FIRST such address is remembered and returned if nothing better turns
 * up, because on a developer's laptop there is no proxy and `127.0.0.1` is the
 * honest answer rather than a gap. Callers that need to tell the two apart ask
 * `isInternalAddress` about the result — the audit trail stores it either way,
 * the founder alert says "the proxy is not sending an address" instead.
 */

/**
 * Is this address our own infrastructure rather than a client?
 *
 * Loopback, the three RFC1918 private ranges, link-local, and IPv6
 * unique-local / link-local.
 *
 * @param {string} ip a normalised address (no `::ffff:` prefix)
 */
function isInternalAddress(ip) {
  if (!ip) return false;
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
    || ip === '::1'
    || /^(fc|fd|fe80)/i.test(ip);
}

/**
 * `::ffff:203.0.113.9` → `203.0.113.9`, and junk → null.
 *
 * The prefix is what an IPv4 address looks like arriving over a dual-stack
 * socket. It is noise in a log column and on a phone screen, and it makes the
 * same client look like two different ones depending on how it connected.
 */
function normalize(value) {
  const ip = String(value || '').trim().replace(/^::ffff:/i, '');
  if (!ip || ip === 'unknown') return null;
  return ip;
}

/**
 * The best available address for this request.
 *
 * @param {object} req an Express request, or anything with `ip` / `headers`
 * @returns {string|null} a client address; an internal one if that is all there
 *                        is; null when the request carries no address at all
 */
function resolveClientIp(req) {
  if (!req) return null;

  const headers = req.headers || {};
  const candidates = [
    req.ip,
    headers['x-real-ip'],
    headers['cf-connecting-ip'],
    // Only ever the FIRST entry: the rest of the chain is the proxies it
    // passed through, and they are not the client.
    String(headers['x-forwarded-for'] || '').split(',')[0],
    req.socket?.remoteAddress,
    req.connection?.remoteAddress,
  ];

  let internal = null;
  for (const candidate of candidates) {
    const ip = normalize(candidate);
    if (!ip) continue;
    if (!isInternalAddress(ip)) return ip;
    if (!internal) internal = ip;
  }

  return internal;
}

module.exports = { resolveClientIp, isInternalAddress };

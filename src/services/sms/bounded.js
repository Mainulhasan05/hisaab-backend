/**
 * Bound a lookup that a send is waiting on.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Routing and pricing are both read from the database on the path of every send.
 * Both already fall back safely when the read FAILS — but a Mongo that is
 * unreachable does not fail fast. Mongoose buffers the query and waits out
 * `bufferTimeoutMS` (10s by default) before rejecting, so an outage in a
 * collection that only decides *which gateway to use* would add ten seconds to
 * every message, and a campaign of fifty batches would sit there for eight
 * minutes doing nothing.
 *
 * A configuration lookup is not worth waiting for. If it has not answered in a
 * couple of seconds, the platform default is the right answer and the send
 * should get on with it.
 *
 * The promise is NOT cancelled on timeout — there is no such thing for a query
 * already in flight. It is simply no longer awaited; it settles later and is
 * ignored. Its rejection is swallowed so a late failure cannot surface as an
 * unhandled rejection and take the process down.
 */

const DEFAULT_MS = Number(process.env.SMS_LOOKUP_TIMEOUT_MS) || 2000;

/**
 * @param {Promise} promise   the lookup
 * @param {*} fallback        what to resolve with if it is too slow or throws
 * @param {object} [opts]
 * @param {number} [opts.ms]  how long to wait
 * @param {function} [opts.onTimeout] called with the reason, for logging
 */
function bounded(promise, fallback, { ms = DEFAULT_MS, onTimeout = null } = {}) {
  let timer;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout(`timed out after ${ms}ms`);
      resolve(fallback);
    }, ms);
    // Never hold the event loop open for this. A pending config lookup must not
    // be the reason a CLI script or a test worker refuses to exit.
    if (typeof timer.unref === 'function') timer.unref();
  });

  const guarded = Promise.resolve(promise)
    .catch((err) => {
      if (onTimeout) onTimeout(err.message);
      return fallback;
    });

  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { bounded, DEFAULT_MS };

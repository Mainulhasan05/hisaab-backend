/**
 * Ambient request context, via AsyncLocalStorage.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * Audit metadata (IP, browser, OS, user agent) can only come from the request,
 * and services are not given the request. `AuditLog.log()` took an optional
 * `req` for exactly this — but 33 call sites across product, sale, purchase,
 * expense, cashRegister, supplier, coupon and salesReturn call
 * `AuditLog.create()` directly instead, and those wrote no metadata at all.
 * Every stock update, product edit and expense in the system therefore had a
 * blank Origin panel: "IP address —, Browser —, OS —".
 *
 * Threading `req` through 33 call sites would fix today's misses and guarantee
 * tomorrow's: the next service to log something will forget again, and the
 * failure is silent — a row that saves fine and is simply missing its origin.
 *
 * So the request is stored ambiently for the life of the request instead, and
 * `AuditLog` reads it in a `pre('validate')` hook. A call site cannot forget
 * something it never has to remember.
 *
 * ── Why AsyncLocalStorage is safe here ──────────────────────────────────────
 *
 * Node runs one request at a time per tick; ALS propagates the store across
 * every `await`, `.then()` and callback descended from `als.run()`, and keeps
 * concurrent requests isolated. It is the same mechanism request-scoped tracing
 * uses. The cost is a small amount of bookkeeping per async hop.
 *
 * Everything here degrades to `null` outside a request — jobs, scripts, tests
 * and the seeder all call the same services, and none of them have a request.
 * That is a normal state, not an error.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `context` available to everything it awaits.
 * Called once per request by the requestContext middleware.
 */
function runWithContext(context, fn) {
  return storage.run(context, fn);
}

/** The whole ambient context, or null outside a request. */
function getContext() {
  return storage.getStore() || null;
}

/**
 * Audit metadata for the request in flight, or null.
 *
 * Shaped to `AuditLog.metadata` exactly, so the hook is a plain assignment.
 * `req.clientInfo` is built by requestContext.middleware.js, which already
 * handles x-forwarded-for / x-real-ip / cf-connecting-ip and parses the UA.
 */
function getAuditMetadata() {
  const ctx = storage.getStore();
  if (!ctx?.clientInfo) return null;

  const { ip, userAgent, browser, os, device } = ctx.clientInfo;
  return { ip, userAgent, browser, os, device };
}

/** The authenticated actor, when one exists. Used to fill in a missing `user`. */
function getActor() {
  const ctx = storage.getStore();
  if (!ctx) return null;

  return {
    userId: ctx.user?._id || null,
    adminId: ctx.admin?._id || null,
    shopId: ctx.shop?._id || null,
    branchId: ctx.branchId || null,
  };
}

module.exports = {
  runWithContext,
  getContext,
  getAuditMetadata,
  getActor,
};

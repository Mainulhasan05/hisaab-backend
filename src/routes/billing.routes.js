const express = require('express');

const router = express.Router();
const controller = require('../controllers/platformCheckout.controller');
const { protect, allowWhenExpired } = require('../middleware/auth.middleware');
const { validate, Joi } = require('../middleware/validate.middleware');
const idempotency = require('../middleware/idempotency.middleware');
const { checkoutLimiter } = require('../middleware/rateLimiter.middleware');

/**
 * The shop paying HisaabBD.
 *
 * ── Why `protect` is applied per-route here and not `router.use(protect)` ────
 *
 * Because two of these routes have to work when every other write in the app is
 * refused. `auth.middleware` returns 402 for any non-GET made by a shop whose
 * subscription has expired — which is correct, and which would make renewing
 * impossible, since renewing is a POST made by exactly those shops.
 *
 * `allowWhenExpired` must therefore run BEFORE `protect` so the flag is set by
 * the time the guard reads it, and that ordering is only expressible per route.
 * Writing it out route by route also means the exception is visible where
 * somebody adding a third endpoint will see it, rather than hidden in a list
 * inside the middleware.
 *
 * A BLOCKED shop is still refused, by `protect` and again by the service. Only
 * expiry is carved out.
 *
 * ── What is NOT accepted here ───────────────────────────────────────────────
 *
 * A price. Both schemas end `.unknown(false)`, so a client that sends `amount`
 * on the subscription route or `quantity`/`unitPrice` on the SMS route is
 * REFUSED rather than having it ignored — the rule `public.routes.js` states for
 * the storefront checkout, for the same reason. The subscription price comes
 * from the package ladder and the SMS quantity from the platform rate, both
 * server-side.
 */

const monthsBody = Joi.object({
  // Bounded, but the real constraint is that the number must match a CONFIGURED
  // package — the service rejects anything else. This only stops nonsense
  // reaching it.
  months: Joi.number().integer().min(1).max(120).required()
    .messages({ 'any.required': 'কত মাসের প্যাকেজ তা নির্বাচন করুন' }),
}).unknown(false);

const smsAmountBody = Joi.object({
  // The floor and ceiling are enforced in the service against PlatformSetting,
  // so an operator can change them without a redeploy. `positive()` here is only
  // to keep a negative or a string out of the arithmetic.
  amount: Joi.number().positive().max(1000000).required()
    .messages({ 'any.required': 'কত টাকার এসএমএস কিনবেন তা লিখুন' }),
}).unknown(false);

const orderIdParam = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

router.get('/me', protect, controller.getBilling);

router.post(
  '/checkout/subscription',
  allowWhenExpired,
  protect,
  checkoutLimiter,
  /* Idempotency ENGAGES ONLY IF THE CALLER SENDS `x-idempotency-key`.
   *
   * Worth being precise about, because it is easy to read this line as
   * "double-taps are handled" — they are not, by this. A browser that taps
   * twice sends two requests with no key and gets two gateway sessions; what
   * actually prevents that is the button disabling itself while the first is in
   * flight, and the fact that a spare unpaid session is harmless (it is swept
   * to `abandoned` and nobody is charged).
   *
   * It is mounted for the caller that DOES send one — a retry after a network
   * timeout, where the first request may well have reached us and opened a real
   * session. Replaying that response is much better than minting a second
   * invoice number for the same intent.
   *
   * The TTL is minutes, not the 24 hours used for storefront orders. The
   * middleware caches 4xx as well as 2xx, so a long window would pin a
   * transient failure to a key and refuse a legitimate retry for the rest of
   * the day — on the one screen a shop uses to pay us. */
  idempotency({ ttlSeconds: 120, lockTtlSeconds: 60 }),
  validate(monthsBody),
  controller.startSubscriptionCheckout
);

// No `allowWhenExpired`: an expired shop cannot send SMS anyway, so selling it
// credits it cannot use is taking money for nothing. Renew first, then top up.
router.post(
  '/checkout/sms',
  protect,
  checkoutLimiter,
  // Same short window, same reasoning as the route above.
  idempotency({ ttlSeconds: 120, lockTtlSeconds: 60 }),
  validate(smsAmountBody),
  controller.startSmsCheckout
);

router.get('/orders/:id', protect, validate(orderIdParam, 'params'), controller.getOrder);

// The return page polls this while it waits. `allowWhenExpired` because the
// shop is still expired at the moment it asks — the renewal it is asking about
// has not been applied yet.
router.post(
  '/orders/:id/verify',
  allowWhenExpired,
  protect,
  checkoutLimiter,
  validate(orderIdParam, 'params'),
  controller.verifyOrder
);

module.exports = router;

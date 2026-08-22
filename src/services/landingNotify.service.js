/**
 * Landing page notifications — telling the shop an order arrived.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 *
 * `landingOrder.service.js` is under the I-17 structural guard, which scans it
 * for imports of the shop's ledger models. Notification code reaches for
 * unrelated things — the SMS gateway, Telegram links, the shop's name — and
 * every one of those imports makes that file harder to read as the proof it is
 * meant to be. Keeping the messaging here leaves the placement path free of
 * anything that is not pricing.
 *
 * It is under the same guard anyway (see `landingLedgerIsolation.test.js`), for
 * the obvious reason: "look up the customer to get their name" is the single
 * most natural thing to write in a file like this, and it is exactly what must
 * not happen. Every name and number sent from here comes off the ORDER, which
 * carries its own snapshot.
 *
 * ── NOTHING HERE MAY THROW INTO THE CUSTOMER'S REQUEST ──────────────────────
 *
 * A Telegram outage, an exhausted SMS balance and an unlinked shop are all
 * ordinary. None of them is a reason to fail an order that is already written,
 * so every path here catches its own errors and logs. The caller does not await
 * the result.
 */

const logger = require('../utils/logger.util');

/** Cap on what one order's notification may say about a long address. */
const ADDRESS_PREVIEW = 90;

class LandingNotifyService {
  /**
   * A new order landed — tell whoever is linked on Telegram.
   *
   * Free, instant, and it reaches a phone the owner is already holding, which
   * is why it defaults ON. Until this existed a landing order arrived and
   * nobody learned about it: the shop had no panel and no alert, so the whole
   * feature depended on someone opening the admin screen on a hunch.
   *
   * @param {Object} page   the LandingPage the order came through
   * @param {Object} order  the LandingOrder just written
   */
  async orderPlaced(page, order) {
    if (page?.notifications?.telegram === false) return;

    try {
      // Lazy: telegram.service boots an HTTP client, and this module is loaded
      // by the public routes on every worker.
      const telegramService = require('./telegram.service');
      const TelegramLink = require('../models/TelegramLink.model');
      const { escapeHtml } = require('../utils/telegramFormat.util');

      const links = await TelegramLink.find({ shop: order.shop, isActive: true }).lean();
      if (!links.length) return;

      const text = this._placedText(page, order, escapeHtml);

      for (const link of links) {
        // Sequential rather than Promise.all: `safeSend` already retries with
        // backoff, and a shop has a handful of links at most.
        await telegramService.safeSend(link.telegramChatId, text, {
          eventType: 'landing_order_placed',
          shopId: order.shop,
          userId: link.user,
        });
      }
    } catch (err) {
      logger.warn(`[LandingNotify] telegram failed for ${order?.orderNo}: ${err.message}`);
    }
  }

  /**
   * The message body.
   *
   * Carries the campaign name, because a shop running আম, লিচু and মধু at once
   * gets three streams of these and the order number's prefix alone is a code
   * they have to remember. Everything else is what a person needs to decide
   * whether to pick up the phone.
   */
  _placedText(page, order, escapeHtml) {
    const lines = [
      `🌾 <b>নতুন অর্ডার!</b>  <code>${escapeHtml(order.orderNo)}</code>`,
      `📄 ${escapeHtml(page?.title || 'সিজন পেজ')}`,
      '',
      `👤 ${escapeHtml(order.customer.name)}  (${escapeHtml(order.customer.phone)})`,
      `📍 ${escapeHtml(String(order.customer.address || '').slice(0, ADDRESS_PREVIEW))}`,
    ];

    for (const item of order.items || []) {
      lines.push(`• ${escapeHtml(item.label)} × ${item.quantity}`);
    }

    if (order.discount?.amount > 0) {
      lines.push(`🏷️ কুপন ${escapeHtml(order.discount.code || '')} — ৳${order.discount.amount} ছাড়`);
    }
    if (order.delivery?.freeByThreshold) {
      lines.push('🚚 ডেলিভারি ফ্রি');
    }

    lines.push(`🧾 মোট <b>৳${order.total}</b>`);

    // The advance is the reason a human must look at this order before it is
    // packed, so it is the last thing said and it says what is unresolved.
    if (order.paymentMethod === 'advance') {
      lines.push(
        `💳 অগ্রিম ৳${order.advance?.amount || 0} — TrxID <code>${escapeHtml(order.advance?.trxId || '')}</code>`,
        `   <b>যাচাই করুন</b> · হাতে নেবেন ৳${order.codAmount}`
      );
    }

    lines.push('', 'পেজ প্যানেল → অর্ডার থেকে নিশ্চিত করুন।');
    return lines.join('\n');
  }

  /**
   * The shop confirmed the order — text the CUSTOMER.
   *
   * Metered and billed to the shop, so it defaults OFF and only fires when the
   * page was switched on deliberately (`notifications.smsOnConfirm`). A default
   * that spends a shop's balance on every order is how you earn an angry phone
   * call.
   *
   * Quota, segment counting and the shop's sign-off all belong to
   * `sms.service`; nothing about that is re-implemented here.
   */
  async orderConfirmed(page, order, { userId = null } = {}) {
    if (!page?.notifications?.smsOnConfirm) return;

    try {
      const smsService = require('./sms.service');

      const message =
        `আপনার অর্ডার ${order.orderNo} নিশ্চিত হয়েছে। ` +
        `মোট ৳${order.total}` +
        (order.codAmount !== order.total ? `, ডেলিভারিতে দিতে হবে ৳${order.codAmount}` : '') +
        `। ধন্যবাদ।`;

      // `customerId` is null and stays null — there is no Customer record and
      // creating one is the exact thing I-17 forbids.
      await smsService.sendSingle(order.shop, userId, order.customer.phone, message, null, null, {
        audience: 'landing_order',
      });
    } catch (err) {
      // An exhausted balance is ordinary and must not undo a confirmation the
      // shop has already made.
      logger.warn(`[LandingNotify] sms failed for ${order?.orderNo}: ${err.message}`);
    }
  }
}

module.exports = new LandingNotifyService();
module.exports.ADDRESS_PREVIEW = ADDRESS_PREVIEW;

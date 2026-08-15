/**
 * Landing page orders — placement and the shop's worklist.
 *
 * ── THIS MODULE MUST NEVER TOUCH THE SHOP'S BOOKS (I-17) ────────────────────
 *
 * No `Customer`, no `Sale`, no `StockTransaction`, no `Payment`, no
 * `InvoiceCounter`, no shared `Order`. `confirmed` here means "I rang them and
 * they are real", not "post this to the ledger". `landingLedgerIsolation.test.js`
 * enforces this by scanning for the imports.
 *
 * ── EVERY FIGURE IS DERIVED SERVER-SIDE (I-13) ──────────────────────────────
 *
 * The submitted body carries `offer` keys, a `zone` key and quantities. It does
 * NOT carry prices, and any it does carry are ignored. Prices come from
 * `LandingPage.offers[]` at the moment the order is written, and are snapshotted
 * onto the order so a later edit cannot rewrite what a customer agreed to.
 *
 * This matters more here than on the storefront. There the untrusted input was a
 * stranger's browser; here the PAGE ITSELF is authored input — possibly by a
 * language model — and the number printed next to the button was never checked
 * by anyone.
 */

const mongoose = require('mongoose');

const LandingOrder = require('../models/LandingOrder.model');
const LandingOrderCounter = require('../models/LandingOrderCounter.model');
const { resolveLandingPage } = require('../utils/landingPageState.util');
const { getBangladeshTodayStr } = require('../utils/bdTime.util');
const { normalizePhone, isValidPhone } = require('../utils/phone.util');
const { AppError } = require('../middleware/error.middleware');

const { LANDING_ORDER_STATUSES } = LandingOrder;

/** Most of one offer a single order may take. A hedge against a fat finger and a bot. */
const MAX_QUANTITY = 99;

/** How far back the duplicate check looks. */
const DUPLICATE_WINDOW_HOURS = 24;

class LandingOrderService {
  // ── Placement ─────────────────────────────────────────────────────────────

  /**
   * Write one order from a public form submission.
   *
   * @param {Object} page      a LandingPage document
   * @param {Object} body      the submitted form
   * @param {Object} [meta]    { ip, userAgent, attribution }
   */
  async place(page, body, { ip = null, userAgent = null, attribution = {} } = {}) {
    const state = resolveLandingPage(page);
    if (!state.canAcceptOrders) {
      // 410 rather than 404: the page exists and the customer is looking at it.
      // The advertisement may still be running, and "gone" is the honest answer.
      const error = new AppError(
        `This page is not accepting orders (${state.state})`,
        'এই অফারটি শেষ হয়েছে — নতুন অর্ডার নেওয়া হচ্ছে না',
        410
      );
      error.code = 'PAGE_CLOSED';
      throw error;
    }

    const customer = this._resolveCustomer(body);
    const items = this._resolveItems(page, body);
    const delivery = this._resolveDelivery(page, body);

    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const deliveryCharge = delivery.charge;

    const orderNo = await this._nextOrderNo(page);

    return LandingOrder.create({
      shop: page.shop,
      page: page._id,
      orderNo,
      customer,
      items,
      delivery,
      subtotal,
      deliveryCharge,
      total: subtotal + deliveryCharge,
      status: 'pending',
      statusHistory: [{ status: 'pending', at: new Date() }],
      attribution: this._cleanAttribution(attribution),
      meta: {
        ip: ip ? String(ip).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
      },
    });
  }

  /**
   * Name, phone and address — a SNAPSHOT, not a `Customer` (I-17).
   *
   * The phone is normalised on the way in so that the duplicate check and the
   * customers view group one person together whether they typed `01712…`,
   * `+8801712…` or `8801712…`. Storing it raw would make every one of those look
   * like a different buyer.
   */
  _resolveCustomer(body) {
    const name = String(body?.customerName || '').trim();
    const rawPhone = String(body?.phone || '').trim();
    const address = String(body?.address || '').trim();

    if (!name) throw new AppError('Name is required', 'আপনার নাম দিন', 400);
    if (!isValidPhone(rawPhone)) {
      throw new AppError('A valid phone number is required', 'সঠিক মোবাইল নম্বর দিন', 400);
    }
    if (!address) throw new AppError('Address is required', 'ঠিকানা দিন', 400);

    return {
      name: name.slice(0, 120),
      phone: normalizePhone(rawPhone),
      address: address.slice(0, 500),
      note: String(body?.note || '').trim().slice(0, 500) || undefined,
    };
  }

  /**
   * Turn the posted offer keys into priced lines.
   *
   * The whole of I-13 lives in this method. A key that is not an ACTIVE offer on
   * this page is refused rather than skipped: silently dropping it would write
   * an order for less than the customer chose, and they would find out at the
   * door.
   */
  _resolveItems(page, body) {
    const active = page.activeOffers();
    if (active.length === 0) {
      throw new AppError('This page has nothing to order', 'এই পেজে অর্ডার করার মতো কিছু নেই', 409);
    }

    // A single-offer page needs no picker in its HTML, so an absent `offer` is
    // not an error there — it is the only thing it could have been.
    const requested = this._requestedOffers(body, active);

    const items = [];
    for (const { key, quantity } of requested) {
      const offer = page.findOffer(key);
      if (!offer) {
        throw new AppError(
          `Unknown offer "${key}"`,
          'নির্বাচিত অফারটি আর পাওয়া যাচ্ছে না — পেজটি রিফ্রেশ করুন',
          409
        );
      }

      const qty = clampQuantity(quantity);
      items.push({
        offerKey: offer.key,
        // Snapshotted so editing the offer tomorrow cannot rewrite what this
        // customer saw and agreed to today.
        label: offer.label,
        unitPrice: offer.price,
        quantity: qty,
        lineTotal: offer.price * qty,
      });
    }

    if (items.length === 0) {
      throw new AppError('Please choose an option', 'একটি অপশন নির্বাচন করুন', 400);
    }
    return items;
  }

  /** Normalise the several shapes a form can post an offer selection in. */
  _requestedOffers(body, active) {
    const quantity = body?.quantity;

    // `offer` as an array — a form with checkboxes rather than radios.
    if (Array.isArray(body?.offer)) {
      return body.offer.filter(Boolean).map((key) => ({ key, quantity: 1 }));
    }

    // `items: [{ offer, quantity }]` — a form that lets one customer take two
    // of one pack and one of another.
    if (Array.isArray(body?.items) && body.items.length > 0) {
      return body.items
        .filter((i) => i && i.offer)
        .map((i) => ({ key: String(i.offer), quantity: i.quantity }));
    }

    if (body?.offer) return [{ key: String(body.offer), quantity }];

    // No selection on a single-offer page: unambiguous.
    if (active.length === 1) return [{ key: active[0].key, quantity }];

    throw new AppError('Please choose an option', 'একটি অপশন নির্বাচন করুন', 400);
  }

  /**
   * Resolve the delivery zone and its charge.
   *
   * An absent or unknown zone falls back to the first active one rather than
   * failing. The page may legitimately have no zone picker (one charge for
   * everyone), and refusing an order over a missing optional field is the wrong
   * trade when the alternative is a lost sale.
   */
  _resolveDelivery(page, body) {
    const zones = (page.delivery?.zones || []).filter((z) => z.isActive !== false);
    if (zones.length === 0) return { zoneKey: null, zoneName: null, charge: 0 };

    const chosen = (body?.zone && page.findZone(body.zone)) || zones[0];
    return {
      zoneKey: chosen.key,
      zoneName: chosen.name,
      charge: Number(chosen.charge) || 0,
    };
  }

  /** UTM and click ids only, bounded. Never trusted, never used for anything but reporting. */
  _cleanAttribution(attribution) {
    const take = (v) => (v ? String(v).slice(0, 200) : undefined);
    return {
      utmSource: take(attribution.utmSource),
      utmMedium: take(attribution.utmMedium),
      utmCampaign: take(attribution.utmCampaign),
      utmContent: take(attribution.utmContent),
      fbclid: take(attribution.fbclid),
      referrer: attribution.referrer ? String(attribution.referrer).slice(0, 500) : undefined,
    };
  }

  /**
   * `AAM-0007`. The prefix is the page's, the sequence is the SHOP's.
   *
   * Keyed on (shop, day) so a shop running three campaigns gets one continuous
   * daily series it can read, told apart by prefix rather than by three number
   * series colliding at 0001.
   */
  async _nextOrderNo(page) {
    const today = getBangladeshTodayStr();
    const seq = await LandingOrderCounter.nextSeq(page.shop, today, () =>
      LandingOrder.countDocuments({
        shop: page.shop,
        createdAt: { $gte: new Date(`${today}T00:00:00+06:00`) },
      })
    );
    const prefix = String(page.orderPrefix || 'LP').toUpperCase();
    return `${prefix}-${String(seq).padStart(4, '0')}`;
  }

  // ── The shop's worklist ───────────────────────────────────────────────────

  async listForShop(shopId, { page = null, status = null, search = null, limit = 50, skip = 0 } = {}) {
    const query = { shop: shopId };
    if (page) query.page = page;
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      query.$or = [{ orderNo: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const [items, total] = await Promise.all([
      LandingOrder.find(query).sort({ createdAt: -1 }).skip(Number(skip) || 0).limit(safeLimit),
      LandingOrder.countDocuments(query),
    ]);

    return { items, total, limit: safeLimit };
  }

  /**
   * Fetch one order, scoped to the shop that owns it.
   *
   * A 404 rather than a 403 for a foreign order: a shop must not be able to
   * discover that an order id exists by the shape of the error.
   */
  async getForShop(orderId, shopId) {
    const order = await LandingOrder.findOne({ _id: orderId, shop: shopId });
    if (!order) throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    return order;
  }

  /**
   * Move an order along.
   *
   * Only forward, plus `cancelled` from anywhere before `delivered`. Reversing a
   * status is refused: `statusHistory` is what the shop reads to answer "when
   * did this ship", and letting it go backwards makes that record a guess.
   *
   * Nothing here writes outside this collection (I-17). `confirmed` in
   * particular does NOT create a Sale.
   */
  async updateStatus(orderId, shopId, nextStatus, { userId = null, note = null } = {}) {
    const order = await this.getForShop(orderId, shopId);

    if (!LANDING_ORDER_STATUSES.includes(nextStatus)) {
      throw new AppError(`Unknown status "${nextStatus}"`, 'অজানা স্ট্যাটাস', 400);
    }
    if (order.status === nextStatus) return order;

    const allowed = order.nextStatuses();
    if (!allowed.includes(nextStatus)) {
      throw new AppError(
        `Cannot move an order from ${order.status} to ${nextStatus}`,
        `"${order.status}" থেকে "${nextStatus}"-এ নেওয়া যাবে না`,
        409
      );
    }

    order.status = nextStatus;
    order.statusHistory.push({
      status: nextStatus,
      at: new Date(),
      by: userId,
      note: note ? String(note).slice(0, 300) : undefined,
    });

    await order.save();
    return order;
  }

  /**
   * Mark a prank or a refused parcel.
   *
   * Kept apart from `cancelled` because the two answer different questions. A
   * cancellation is often the customer changing their mind, which is ordinary;
   * this feeds the duplicate check. Lumping them together makes the confirmation
   * rate — the number a trader judges a campaign by — meaningless.
   */
  async setFake(orderId, shopId, isFake) {
    const order = await this.getForShop(orderId, shopId);
    order.isFake = Boolean(isFake);
    await order.save();
    return order;
  }

  /**
   * Recent orders from the same phone — flagged in the worklist, never blocked.
   *
   * COD landing pages in Bangladesh take a meaningful share of duplicate and
   * prank orders. Refusing automatically would also refuse the ordinary case of
   * someone ordering twice in a day, so this informs the human who is about to
   * ring them rather than deciding for them.
   */
  async duplicatesFor(order, { hours = DUPLICATE_WINDOW_HOURS } = {}) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return LandingOrder.find({
      shop: order.shop,
      'customer.phone': order.customer.phone,
      _id: { $ne: order._id },
      createdAt: { $gte: since },
    }).select('orderNo status total createdAt isFake').sort({ createdAt: -1 }).limit(10);
  }
}

/** 1..MAX_QUANTITY, defaulting to 1. A blank, a word or a negative all mean one. */
function clampQuantity(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = new LandingOrderService();
module.exports.MAX_QUANTITY = MAX_QUANTITY;
module.exports.DUPLICATE_WINDOW_HOURS = DUPLICATE_WINDOW_HOURS;
module.exports.clampQuantity = clampQuantity;

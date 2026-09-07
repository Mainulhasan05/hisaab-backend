const mongoose = require('mongoose');
const Order = require('../models/Order.model');
const OrderCounter = require('../models/OrderCounter.model');
const Product = require('../models/Product.model');
const Storefront = require('../models/Storefront.model');
const publicStorefrontService = require('./publicStorefront.service');
const { AppError } = require('../middleware/error.middleware');
const { getBangladeshTodayStr, getBangladeshTodayRange } = require('../utils/bdTime.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { normalizePhone, isValidPhone } = require('../utils/phone.util');
const { branchFilter, branchMatch, isActiveBranch, wrongBranchError } = require('../utils/branchScope.util');
const { resolveAddress, _norm: geoNorm } = require('../utils/bdGeo.util');
const logger = require('../utils/logger.util');

/**
 * Per-phone daily ceiling on storefront orders, per shop.
 *
 * The IP guard (`orderAbuse.middleware`) is blind in both directions behind
 * Bangladeshi CGNAT: one address is a whole neighbourhood, and one abuser has a
 * new address every reconnect. The phone number is the identity a COD order
 * cannot function without, so it is the second axis — a stranger can rotate
 * IPs, but every junk order still has to name a phone, and the same phone
 * naming ten unconfirmed parcels a day is not a customer. The
 * `{shop, 'customer.phone', createdAt}` index was built for exactly this read.
 */
const PHONE_DAILY_MAX = Number(process.env.ORDER_PHONE_DAILY_MAX) || 10;

/**
 * Which statuses each forward transition may leave from.
 *
 * `confirmed` is absent on purpose — it is not a status update, it is
 * `confirmOrder`, the one door into the ledger (I-9). Fulfilment steps may be
 * skipped forward (a shop that hands the parcel to the courier without ever
 * pressing "packed" is normal), but never backward, and `delivered` is
 * terminal: undoing money is `cancelOrder`/returns, not a status edit.
 */
const FORWARD_TRANSITIONS = Object.freeze({
  packed: ['confirmed'],
  shipped: ['confirmed', 'packed'],
  delivered: ['confirmed', 'packed', 'shipped'],
});

/**
 * Orders — the shared core.
 *
 * ── ONE PLACEMENT PATH, TWO DOORS ───────────────────────────────────────────
 *
 * An order reaches this service from two places and they have almost nothing in
 * common at the edge:
 *
 *   · the PUBLIC storefront — an unauthenticated stranger, rate limited, IP
 *     recorded, nothing about the request trusted;
 *   · MANUAL entry — a member of shop staff typing in what arrived as a
 *     Facebook message or a phone call, on an authenticated route with a
 *     permission check in front of it.
 *
 * Everything after the door is identical, and this file is that everything.
 * Both go through `resolveLines` and `placeOrder`, so both get server-derived
 * prices, the same cost snapshot, the same stock rules, the same numbering and
 * the same lifecycle. If the two had separate implementations they would drift,
 * and the drift would show up as a Facebook order that priced differently from
 * the website — with the shopkeeper unable to say which one was right.
 *
 * ── NOTHING HERE TOUCHES THE BOOKS ──────────────────────────────────────────
 *
 * Placement writes one `Order` document. No stock movement, no `Sale`, no
 * `StockTransaction`, no `CustomerBalance`. That is invariant I-9 and the
 * reasoning is on `Order.model.js`. Confirmation is a separate act with its own
 * service method, and it is the only thing in this file that will ever call
 * `saleService`.
 */
class OrderService {
  /**
   * Turn `[{productId, variantSku, quantity}]` into priced order lines.
   *
   * ── THE REQUEST BODY IS A LIST OF WISHES, NOT A LIST OF PRICES ────────────
   *
   * The client sends what it wants and how many. It does NOT send what things
   * cost, and anything it does send about money is ignored. Every price on the
   * returned lines is read from the `Product` document here, using
   * `publicStorefront.service`'s own pricing rule — the same function that
   * rendered the number the customer saw, so the checkout total and the
   * catalogue can never disagree.
   *
   * That is the difference between a checkout and a form. A client-supplied
   * price is a client-supplied discount.
   *
   * @param {object} shop      resolved shop document (or its id)
   * @param {object} opts
   * @param {Array}  opts.items       [{productId, variantSku?, quantity}]
   * @param {boolean} opts.onlineOnly true for the public path — refuses any
   *        product the shop has not marked available online. False for manual
   *        entry, where staff legitimately sell things the website does not
   *        list (a Facebook customer asking for something off-catalogue).
   * @returns {Promise<{lines: Array, subtotal: number}>}
   */
  async resolveLines(shopId, { items, onlineOnly = true } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('No items in the order', 'অর্ডারে কোনো পণ্য নেই', 400);
    }
    if (items.length > 50) {
      // A cap rather than an unbounded loop: this runs on an unauthenticated
      // endpoint and each line is a document read.
      throw new AppError('Too many items in one order', 'এক অর্ডারে অনেক বেশি পণ্য', 400);
    }

    // One query for the lot. A per-line `findById` would be N round trips on
    // the one endpoint a stranger can trigger.
    const ids = [...new Set(items.map((i) => String(i.productId || '')))];
    const products = await Product.find({
      _id: { $in: ids },
      shop: shopId,
      ...(onlineOnly ? { isAvailableOnline: true } : {}),
      isActive: { $ne: false },
    }).lean();

    const byId = new Map(products.map((p) => [String(p._id), p]));
    const lines = [];

    for (const raw of items) {
      const product = byId.get(String(raw.productId || ''));
      if (!product) {
        // Deliberately not "product 6a76… not found": the customer cannot act
        // on an id. The shop's own staff get the same message and can see which
        // line is missing from the form they are looking at.
        throw new AppError(
          'One of the products is no longer available',
          'একটি পণ্য আর পাওয়া যাচ্ছে না',
          400
        );
      }

      const quantity = Number(raw.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError('Invalid quantity', 'পরিমাণ সঠিক নয়', 400);
      }

      const line = product.hasVariants
        ? this._variantLine(product, raw, quantity)
        : this._simpleLine(product, quantity);

      lines.push(line);
    }

    const subtotal = quantizeMoney(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    return { lines, subtotal };
  }

  /** A line for a product with no variants. */
  _simpleLine(product, quantity) {
    const { price, compareAt } = publicStorefrontService._effective(product);
    this._assertStock(product.stock, quantity, product.name);

    return {
      product: product._id,
      variantSku: null,
      name: product.name,
      code: product.code,
      variantLabel: null,
      unit: product.unit || null,
      image: this._imageOf(product),
      quantity,
      unitPrice: price,
      compareAtPrice: compareAt,
      lineTotal: quantizeMoney(price * quantity),
      // Never leaves the server. See Order.model.js.
      buyingPrice: Number(product.buyingPrice) || 0,
    };
  }

  /**
   * A line for one variant.
   *
   * The variant is addressed by SKU because that is what the public product
   * page publishes and what survives the shop reordering its variant list. An
   * index would point at a different size after any edit to the product.
   */
  _variantLine(product, raw, quantity) {
    const sku = String(raw.variantSku || '').trim();
    if (!sku) {
      throw new AppError(
        `Choose an option for "${product.name}"`,
        `"${product.name}" এর জন্য একটি অপশন বেছে নিন`,
        400
      );
    }

    const variant = (product.variants || []).find(
      (v) => String(v.sku) === sku && v.isActive !== false
    );
    if (!variant) {
      throw new AppError(
        `That option for "${product.name}" is no longer available`,
        `"${product.name}" এর সেই অপশনটি আর নেই`,
        400
      );
    }

    // The parent's online price flows down to a variant that has none of its
    // own — the same precedence the catalogue rendered with.
    const parentOnline = publicStorefrontService._onlinePriceOf(product);
    const { price, compareAt } = publicStorefrontService._effective(variant, parentOnline);
    this._assertStock(variant.stock, quantity, product.name);

    return {
      product: product._id,
      variantSku: sku,
      name: product.name,
      code: product.code,
      variantLabel: this._variantLabel(variant),
      unit: product.unit || null,
      image: variant.image || this._imageOf(product),
      quantity,
      unitPrice: price,
      compareAtPrice: compareAt,
      lineTotal: quantizeMoney(price * quantity),
      buyingPrice: Number(variant.buyingPrice ?? product.buyingPrice) || 0,
    };
  }

  /**
   * Stock, checked but NOT reserved.
   *
   * ECOMMERCE_PLAN.md §6.3 is explicit that nothing is reserved for an
   * unconfirmed order, and this check does not change that. It exists to catch
   * the ordinary case — someone ordering ten of something with three in stock —
   * at the moment they can still do something about it.
   *
   * Two customers ordering the last unit will BOTH succeed here, and that is
   * correct: neither has been promised anything, and the shop decides who gets
   * it at confirm time, where the real guard lives (`createSale` refuses to
   * take stock below zero). Reserving on placement would let a stranger empty a
   * shop's shelves with a script and no intention of paying.
   */
  _assertStock(available, wanted, name) {
    const stock = Number(available) || 0;
    if (stock <= 0) {
      throw new AppError(
        `"${name}" is out of stock`,
        `"${name}" এখন স্টকে নেই`,
        409
      );
    }
    if (wanted > stock) {
      throw new AppError(
        `Only ${stock} of "${name}" available`,
        `"${name}" এর ${stock}টি আছে`,
        409
      );
    }
  }

  _variantLabel(variant) {
    const values = Object.values(variant.attributes || {}).filter(Boolean);
    return values.length ? values.join(' · ') : (variant.sku || null);
  }

  _imageOf(product) {
    const catalog = Array.isArray(product.catalogImages) ? product.catalogImages : [];
    const primary = catalog.find((i) => i?.isPrimary && i.url) || catalog.find((i) => i?.url);
    if (primary) return primary.thumbnail || primary.url;
    const legacy = (product.images || []).find((u) => typeof u === 'string' && u);
    return legacy || null;
  }

  /**
   * Resolve the delivery charge from WHERE THE CUSTOMER IS.
   *
   * ── WHAT CHANGED, AND WHY IT HAD TO ────────────────────────────────────────
   *
   * This function used to take a `zoneKey` straight off the checkout body. It
   * checked the key existed in the shop's zone table and charged it — which
   * meant the CLIENT was choosing the delivery price. A customer in Rangpur
   * could tick "ঢাকার ভিতরে ৳৬০" and pay ৳৬০, and nothing anywhere could tell
   * that was wrong, because the server never learned where they were.
   *
   * That is the same hole I-10 closes for product prices, left open one field
   * to the right. So the customer now names a PLACE — validated against
   * `bdGeo` — and the zone is derived from the shop's own mapping.
   *
   * ── RESOLUTION ORDER: SPECIFIC BEFORE GENERAL, NAMED BEFORE DEFAULT ───────
   *
   *   1. area/upazila match   — "Savar" is outside Dhaka even though the
   *                             district is Dhaka. Without this level the
   *                             busiest district in the country cannot be
   *                             priced correctly at all.
   *   2. district match       — the broad brush, and all most shops need.
   *   3. `defaultZoneKey`     — the named catch-all.
   *   4. refuse               — never charge zero by omission.
   *
   * Step 4 is the one worth stating plainly: an address nobody claimed and no
   * default to fall back on is a configuration the shop has not finished, and
   * a 400 that says so is better than a free delivery it never notices.
   *
   * Snapshotted onto the order, never referenced: a shop that raises its Dhaka
   * charge must not change what an already-placed order said it would cost.
   *
   * @param {object} address `{ district, subdistrict }` — names, either language.
   */
  resolveDelivery(storefront, address, { pickup = false, requireSubdistrict = true } = {}) {
    if (pickup) {
      if (!storefront?.delivery?.pickupEnabled) {
        throw new AppError('Pickup is not offered', 'পিকআপ সুবিধা নেই', 400);
      }
      return {
        zoneKey: null, zoneName: null, charge: 0,
        etaDaysMin: null, etaDaysMax: null, isPickup: true,
        district: null, subdistrict: null,
      };
    }

    const zones = (storefront?.delivery?.zones || []).filter((z) => z.isActive !== false);
    if (!zones.length) {
      // A shop with every zone switched off cannot take a delivery order, and
      // saying so beats silently charging nothing.
      throw new AppError(
        'This shop has no delivery areas configured',
        'এই দোকানের কোনো ডেলিভারি এলাকা নেই',
        400
      );
    }

    const resolved = resolveAddress(address || {}, { requireSubdistrict });
    if (!resolved.ok) {
      throw new AppError('Invalid delivery address', resolved.error, 400);
    }
    const { district, subdistrict } = resolved;

    // Compared on the canonical English name, case-insensitively: the mapping
    // is written by a shopkeeper through a picker, but it is also written by a
    // migration and could be edited by hand, and "dhaka" must not miss "Dhaka".
    const has = (list, name) =>
      Array.isArray(list) && list.some((n) => geoNorm(n) === geoNorm(name));

    let zone = subdistrict ? zones.find((z) => has(z.areas, subdistrict.name)) : null;
    if (!zone) zone = zones.find((z) => has(z.districts, district.name));
    if (!zone) {
      const fallbackKey = String(storefront?.delivery?.defaultZoneKey || '').trim();
      if (fallbackKey) zone = zones.find((z) => z.key === fallbackKey);
    }
    if (!zone) {
      throw new AppError(
        'No delivery zone covers this address',
        `"${district.bn || district.name}" এ এই দোকান এখনো ডেলিভারি দেয় না — দোকানে ফোন করুন`,
        400
      );
    }

    return {
      zoneKey: zone.key,
      zoneName: zone.nameBn || zone.name,
      charge: Number(zone.charge) || 0,
      etaDaysMin: zone.etaDaysMin ?? null,
      etaDaysMax: zone.etaDaysMax ?? null,
      isPickup: false,
      // Snapshotted as canonical names — what the packing slip prints and what
      // the courier is told. Never the upstream's ids; see bdGeo.util.
      district: district.name,
      districtBn: district.bn || null,
      subdistrict: subdistrict?.name || null,
      subdistrictBn: subdistrict?.bn || null,
    };
  }

  /**
   * Free delivery above a threshold, per zone. Applied AFTER the subtotal is
   * known, which is why it is not part of `resolveDelivery`.
   */
  applyFreeDelivery(storefront, delivery, subtotal) {
    if (delivery.isPickup || !delivery.zoneKey) return delivery;
    const zone = (storefront?.delivery?.zones || []).find((z) => z.key === delivery.zoneKey);
    const threshold = Number(zone?.freeAbove) || 0;
    if (threshold > 0 && subtotal >= threshold) {
      return { ...delivery, charge: 0 };
    }
    return delivery;
  }

  /**
   * Issue the next order number for this shop.
   *
   * `ORD-YYMMDD-NNNN`. Readable over the phone, sorts chronologically, and
   * carries its own date so a shopkeeper reading it in a Telegram notification
   * knows when it arrived without opening anything.
   */
  async nextOrderNo(shopId, prefix = 'ORD') {
    const today = getBangladeshTodayStr();
    const seq = await OrderCounter.nextSeq(shopId, today, async () => {
      // Seeds only on the first order of the day, so a shop that starts using
      // this mid-afternoon continues rather than restarting at 0001.
      const { startOfDay, endOfDay } = getBangladeshTodayRange();
      return Order.countDocuments({
        shop: shopId,
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      });
    });

    // The shop's own prefix (`Storefront.orderPrefix`, settable in settings).
    // Sanitised to the same alphabet the tracking route accepts
    // (`/^[A-Z0-9-]+$/`) — a prefix with a stray character would make every
    // order number fail the public tracking page's params validation.
    const cleaned = String(prefix || 'ORD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'ORD';
    return `${cleaned}-${today.slice(2).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
  }

  /**
   * Price a basket without placing it.
   *
   * ── WHY THIS EXISTS RATHER THAN ARITHMETIC IN THE BROWSER ─────────────────
   *
   * The old checkout added the line prices and the zone charge itself, and it
   * could, because it had exactly one line and the customer had picked the
   * zone by hand. Neither is true now: a cart has many lines, and the zone is
   * DERIVED from the customer's district by rules (area beats district beats
   * default) that live in `resolveDelivery`. Re-implementing those in a
   * component would be a second opinion on what a customer is charged.
   *
   * So the checkout asks. Same resolver, same prices, same free-delivery
   * threshold, same refusals — the number on the button is the number the
   * order will carry, because one function produced both.
   *
   * Writes nothing. Safe to call on every change to the form, which is why the
   * route is outside `orderAbuseGuard` (that guard's budget is for ORDERS; a
   * customer changing their mind twice must not spend it).
   */
  async quoteOrder({ shopId, storefront, items, address, pickup = false, onlineOnly = true }) {
    const { lines, subtotal } = await this.resolveLines(shopId, { items, onlineOnly });

    let delivery;
    try {
      delivery = this.resolveDelivery(storefront, address, { pickup });
      delivery = this.applyFreeDelivery(storefront, delivery, subtotal);
    } catch (err) {
      /**
       * An unresolvable address is not a failed quote — it is a quote for the
       * items, with the delivery part still unknown. The customer has usually
       * just not reached the district dropdown yet, and answering with a 400
       * would blank the basket they are looking at.
       *
       * Anything that is NOT about the address still throws.
       */
      if (err?.statusCode !== 400) throw err;
      return {
        lines: lines.map(this._publicLine),
        subtotal,
        deliveryCharge: null,
        total: null,
        delivery: null,
        deliveryError: err.messageBn || err.message,
      };
    }

    return {
      lines: lines.map(this._publicLine),
      subtotal,
      deliveryCharge: delivery.charge,
      total: quantizeMoney(subtotal + delivery.charge),
      delivery: {
        zoneName: delivery.zoneName,
        etaDaysMin: delivery.etaDaysMin,
        etaDaysMax: delivery.etaDaysMax,
        isPickup: delivery.isPickup,
        district: delivery.districtBn || delivery.district || null,
        subdistrict: delivery.subdistrictBn || delivery.subdistrict || null,
      },
      deliveryError: null,
    };
  }

  /**
   * A line as the customer may see it.
   *
   * `buyingPrice` is on every resolved line and must never reach a browser —
   * it is what the shop paid, and the storefront is public. Whitelisted rather
   * than deleted so a field added to the line shape later is invisible here by
   * default instead of leaking until somebody notices.
   */
  _publicLine(line) {
    return {
      productId: String(line.product),
      variantSku: line.variantSku,
      name: line.name,
      code: line.code,
      variantLabel: line.variantLabel,
      unit: line.unit,
      image: line.image,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      compareAtPrice: line.compareAtPrice,
      lineTotal: line.lineTotal,
    };
  }

  /**
   * Create an order. The single write both doors funnel into.
   *
   * Everything about money is computed here from the resolved lines and the
   * resolved zone — the caller cannot pass a total in.
   */
  async placeOrder({
    shop,
    storefront,
    branch = null,
    customer,
    items,
    // `{ district, subdistrict }` — names, either language. The zone is derived
    // from these, never sent by the client. See resolveDelivery.
    address,
    pickup = false,
    // Storefront customers pick from a dropdown and must name their area —
    // Dhaka cannot be priced without it. Staff typing a phone order may not
    // know it yet. See resolveAddress.
    requireSubdistrict = true,
    source = 'storefront',
    sourceNote = null,
    createdBy = null,
    onlineOnly = true,
    meta = {},
  }) {
    const shopId = shop._id || shop;

    const phone = normalizePhone(customer?.phone);
    if (!phone || !isValidPhone(phone)) {
      throw new AppError('A valid mobile number is required', 'সঠিক মোবাইল নম্বর দিন', 400);
    }
    if (!String(customer?.name || '').trim()) {
      throw new AppError('Name is required', 'নাম দিন', 400);
    }
    if (!pickup && !String(customer?.address || '').trim()) {
      throw new AppError('Address is required', 'ঠিকানা দিন', 400);
    }

    // ── The per-phone ceiling, storefront orders only ────────────────────────
    //
    // Staff typing in Facebook orders are not spamming themselves, so manual
    // entry is exempt. Thrown as a 429, which the public controller does NOT
    // count as an abuse strike — deliberately: a family sharing one phone and
    // one shop exists, and their eleventh genuine order of the day is over-use,
    // not probing. The shopkeeper still has the earlier ten in the worklist.
    if (source === 'storefront') {
      const { startOfDay, endOfDay } = getBangladeshTodayRange();
      const todayCount = await Order.countDocuments({
        shop: shopId,
        'customer.phone': phone,
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      });
      if (todayCount >= PHONE_DAILY_MAX) {
        throw new AppError(
          'Too many orders from this number today',
          'এই নম্বর থেকে আজ অনেকগুলো অর্ডার হয়েছে — দোকানে সরাসরি ফোন করুন',
          429
        );
      }
    }

    const { lines, subtotal } = await this.resolveLines(shopId, { items, onlineOnly });

    let delivery = this.resolveDelivery(storefront, address, { pickup, requireSubdistrict });
    delivery = this.applyFreeDelivery(storefront, delivery, subtotal);

    const total = quantizeMoney(subtotal + delivery.charge);
    const orderNo = await this.nextOrderNo(shopId, storefront?.orderPrefix);

    const order = await Order.create({
      shop: shopId,
      branch: branch || storefront?.branch || null,
      orderNo,
      source,
      sourceNote,
      createdBy,
      customer: {
        name: String(customer.name).trim(),
        phone,
        address: String(customer.address || '').trim(),
        note: String(customer.note || '').trim() || undefined,
      },
      items: lines,
      delivery,
      subtotal,
      deliveryCharge: delivery.charge,
      total,
      paymentMethod: 'cod',
      status: 'pending',
      statusHistory: [{ status: 'pending', at: new Date(), by: createdBy || null }],
      meta: {
        ip: meta.ip || null,
        userAgent: meta.userAgent || null,
        idempotencyKey: meta.idempotencyKey || null,
      },
    });

    // Fire-and-forget, like the SMS receipt in `createSale`: a stats counter or
    // a Telegram hiccup must never fail an order that is already written.
    this._afterPlacement(shop, storefront, order).catch((err) =>
      logger.error(`[Order] post-placement hooks failed for ${order.orderNo}: ${err.message}`)
    );

    return order;
  }

  /**
   * What happens AFTER the order document exists: the storefront's own
   * counters, and the owner's Telegram ping.
   *
   * `stats.totalOrders`/`lastOrderAt` move at placement — they answer "is this
   * storefront being used", which the admin oversight list sorts by.
   * `stats.totalRevenue` moves at CONFIRM, not here: an unconfirmed order is
   * not revenue, and counting it would make the admin list report money that
   * 20–40% COD cancellation rates will take back.
   */
  async _afterPlacement(shop, storefront, order) {
    if (storefront?._id) {
      await Storefront.updateOne(
        { _id: storefront._id },
        { $inc: { 'stats.totalOrders': 1 }, $set: { 'stats.lastOrderAt': new Date() } }
      ).catch((err) => logger.warn(`[Order] stats update failed: ${err.message}`));
    }

    // Telegram: free, instant, defaults ON — but only for storefront orders.
    // A staff member typing in a manual order does not need to be told about
    // the order they are looking at.
    if (order.source !== 'storefront') return;
    if (storefront && storefront.notifications?.telegram === false) return;

    try {
      // Lazy: telegram.service boots an HTTP client and this module is loaded
      // by the public routes on every worker.
      const telegramService = require('./telegram.service');
      const TelegramLink = require('../models/TelegramLink.model');
      const { escapeHtml } = require('../utils/telegramFormat.util');

      const links = await TelegramLink.find({ shop: order.shop, isActive: true }).lean();
      if (!links.length) return;

      const where = order.delivery?.isPickup
        ? 'পিকআপ — দোকান থেকে নেবেন'
        : (order.delivery?.zoneName || order.customer.address || '');
      const text =
        `🛒 <b>নতুন অর্ডার!</b>  <code>${escapeHtml(order.orderNo)}</code>\n\n` +
        `👤 ${escapeHtml(order.customer.name)}  (${escapeHtml(order.customer.phone)})\n` +
        `📍 ${escapeHtml(where)}\n` +
        `🧾 ${order.items.length}টি পণ্য — মোট <b>৳${order.total}</b>\n\n` +
        `অনলাইন প্যানেল → অর্ডার থেকে নিশ্চিত করুন।`;

      for (const link of links) {
        // Sequential, not Promise.all: safeSend already retries with backoff,
        // and a shop has a handful of links at most.
        await telegramService.safeSend(link.telegramChatId, text, {
          eventType: 'order_placed',
          shopId: order.shop,
          userId: link.user,
        });
      }
    } catch (err) {
      logger.warn(`[Order] Telegram notify failed for ${order.orderNo}: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // The merchant side — the worklist, the detail screen and the lifecycle.
  // Every method here takes `req` because every read is branch-scoped through
  // the sanctioned helpers (I-2) and every consequential write needs the
  // acting user. These are called only from authenticated, RBAC'd routes.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The worklist. `{shop, status, createdAt:-1}` is the index this rides.
   *
   * Oldest-first for pending — the plan's own §7.2 rule: the order that has
   * waited longest is the one to deal with next. Everything else newest-first,
   * because "what just happened" is the question the other tabs answer.
   */
  async listOrders(req, { status, q, page = 1, limit = 20 } = {}) {
    const filter = branchFilter(req, { shop: req.shop._id });

    if (status && Order.ORDER_STATUSES.includes(status)) {
      filter.status = status;
    }
    if (q && String(q).trim()) {
      const term = String(q).trim();
      const phone = normalizePhone(term);
      // An order number or a phone — the two things a shopkeeper actually has
      // in hand when a customer calls. Never a free regex over names on an
      // unindexed field.
      filter.$or = [
        { orderNo: term.toUpperCase() },
        ...(phone ? [{ 'customer.phone': phone }] : []),
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const sort = filter.status === 'pending' ? { createdAt: 1 } : { createdAt: -1 };

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort(sort)
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return {
      orders: orders.map((o) => this.toMerchantOrder(o)),
      pagination: {
        page: pageNum,
        limit: perPage,
        total,
        pages: Math.ceil(total / perPage) || 1,
      },
    };
  }

  /**
   * Order counts per status — the tab badges and the dashboard's pending tile.
   * `branchMatch`, not `branchFilter`: this is an aggregation and $match does
   * not cast (I-3).
   */
  async countsByStatus(req) {
    const rows = await Order.aggregate([
      { $match: branchMatch(req, { shop: req.shop._id }) },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = Object.fromEntries(Order.ORDER_STATUSES.map((s) => [s, 0]));
    for (const row of rows) {
      if (row._id in counts) counts[row._id] = row.count;
    }
    counts.all = rows.reduce((sum, r) => sum + r.count, 0);
    return counts;
  }

  /**
   * The overview screen's numbers, in one round trip: status counts, today's
   * activity, and the most recent handful of orders.
   *
   * "Revenue" here is deliberately CONFIRMED money only — the total of today's
   * orders that have a Sale behind them. Pending totals are wishes, and a
   * dashboard that adds wishes to revenue teaches the shopkeeper to distrust
   * every number on it.
   */
  async summary(req) {
    const { startOfDay, endOfDay } = getBangladeshTodayRange();
    const todayRange = { $gte: startOfDay, $lte: endOfDay };

    const [counts, todayRows, recent] = await Promise.all([
      this.countsByStatus(req),
      Order.aggregate([
        { $match: branchMatch(req, { shop: req.shop._id, createdAt: todayRange }) },
        {
          $group: {
            _id: null,
            placed: { $sum: 1 },
            confirmedRevenue: {
              $sum: {
                $cond: [
                  { $in: ['$status', ['confirmed', 'packed', 'shipped', 'delivered']] },
                  '$total',
                  0,
                ],
              },
            },
          },
        },
      ]),
      Order.find(branchFilter(req, { shop: req.shop._id }))
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

    return {
      counts,
      today: {
        placed: todayRows[0]?.placed || 0,
        confirmedRevenue: quantizeMoney(todayRows[0]?.confirmedRevenue || 0),
      },
      recent: recent.map((o) => this.toMerchantOrder(o)),
    };
  }

  /** One order, branch-scoped, or a helpful wrong-branch error for owners. */
  async getById(req, orderId) {
    const order = await Order.findOne(
      branchFilter(req, { _id: orderId, shop: req.shop._id })
    ).lean();

    if (!order) {
      // Same shape sale.service uses: an owner with a branch selected gets told
      // which branch the record lives in; staff get a bare 404.
      const elsewhere = await Order.findOne({ _id: orderId, shop: req.shop._id })
        .populate('branch', 'name code')
        .lean();
      if (elsewhere?.branch) {
        const err = wrongBranchError(req, elsewhere.branch);
        if (err) throw err;
      }
      throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    }

    /**
     * Which customer SMS this shop has switched ON — i.e. which buttons the
     * detail screen may offer.
     *
     * Sent with the ORDER rather than fetched separately by the panel so the
     * screen cannot render a button the server would refuse. These are
     * offer-flags, never auto-send flags; `notifyCustomer` explains why.
     */
    const storefront = await Storefront.findOne({ shop: req.shop._id })
      .select('notifications').lean();

    return {
      ...this.toMerchantOrder(order),
      smsOffered: {
        confirmed: storefront?.notifications?.smsOnConfirm === true,
        shipped: storefront?.notifications?.smsOnShip === true,
      },
    };
  }

  /**
   * A fulfilment step: packed / shipped / delivered. Moves NO money — the money
   * moved at confirm. Guarded atomically: the status filter in the update means
   * two staff pressing two buttons at once resolve to one winner, and the loser
   * is told the order has moved rather than silently rewriting history.
   */
  async updateStatus(req, orderId, nextStatus, { userId, note = null } = {}) {
    const allowedFrom = FORWARD_TRANSITIONS[nextStatus];
    if (!allowedFrom) {
      throw new AppError('Invalid status', 'এই অবস্থায় নেওয়া যাবে না', 400);
    }

    const set = { status: nextStatus };
    if (nextStatus === 'delivered') set.deliveredAt = new Date();

    const order = await Order.findOneAndUpdate(
      branchFilter(req, { _id: orderId, shop: req.shop._id, status: { $in: allowedFrom } }),
      {
        $set: set,
        $push: {
          statusHistory: {
            status: nextStatus,
            at: new Date(),
            by: userId || null,
            ...(note ? { note: String(note).slice(0, 300) } : {}),
          },
        },
      },
      { new: true }
    ).lean();

    if (!order) {
      // Either it does not exist in this scope, or it is not in a state this
      // transition may leave from. Look once more to say which.
      const current = await Order.findOne(
        branchFilter(req, { _id: orderId, shop: req.shop._id })
      ).select('status').lean();
      if (!current) {
        throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
      }
      if (current.status === 'pending') {
        throw new AppError(
          'Confirm the order first',
          'আগে অর্ডারটি নিশ্চিত করুন — তারপর প্যাক/পাঠানো যাবে',
          400
        );
      }
      throw new AppError(
        `Cannot move a ${current.status} order to ${nextStatus}`,
        'অর্ডারটির অবস্থা ইতিমধ্যে বদলে গেছে — পাতাটি রিফ্রেশ করুন',
        409
      );
    }

    return this.toMerchantOrder(order);
  }

  /**
   * Text the customer about their parcel — ONE order, ONE explicit tap.
   *
   * ── WHY THIS IS NOT AUTOMATIC ──────────────────────────────────────────────
   *
   * The obvious implementation is to send on every `confirm` and every `ship`
   * whenever the shop's flag is on. `Order.model.js` argues against exactly
   * that, and the argument is right: SMS is metered and billed per message, so
   * a per-status automatic toggle means a shop enabling it once and then
   * spending money on every order forever, discovering the bill at the end of
   * the month.
   *
   * So `Storefront.notifications.smsOnConfirm` / `smsOnShip` decide what is
   * OFFERED — whether the button appears — and never what is spent. This
   * method is what the button calls.
   *
   * ── WHAT THIS FIXES ────────────────────────────────────────────────────────
   *
   * Both flags have been switches in অনলাইন → সেটিংস since P2, labelled
   * "আপনার SMS কোটা থেকে খরচ হবে", and nothing read either one. A shopkeeper
   * could turn them on, believe their customers were being texted and their
   * quota spent, and both were false. A switch that promises to spend money
   * and does nothing is worse than a missing feature, because nobody goes
   * looking for it. See I-21.
   *
   * ── COST ───────────────────────────────────────────────────────────────────
   *
   * The body is Bangla, so it is UCS-2 and every 67 characters is a segment.
   * These are kept to two — the order number, one fact, and the shop's name,
   * which `sendSingle` appends and bills for.
   */
  async notifyCustomer(req, orderId, kind, { userId = null } = {}) {
    if (!['confirmed', 'shipped'].includes(kind)) {
      throw new AppError('Unknown notification', 'এই ধরনের বার্তা পাঠানো যায় না', 400);
    }

    const order = await Order.findOne(
      branchFilter(req, { _id: orderId, shop: req.shop._id })
    );
    if (!order) throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);

    const flag = kind === 'shipped' ? 'smsOnShip' : 'smsOnConfirm';
    const storefront = await Storefront.findOne({ shop: req.shop._id })
      .select('notifications').lean();
    if (storefront?.notifications?.[flag] !== true) {
      throw new AppError(
        'This message is switched off',
        'এই বার্তাটি সেটিংসে বন্ধ আছে — আগে চালু করুন',
        400
      );
    }

    // Announcing a thing that has not happened is worse than not announcing it.
    if (kind === 'confirmed' && order.status === 'pending') {
      throw new AppError('Order is not confirmed', 'অর্ডারটি এখনো নিশ্চিত হয়নি', 400);
    }
    if (kind === 'shipped' && !['shipped', 'delivered'].includes(order.status)) {
      throw new AppError('Order has not shipped', 'অর্ডারটি এখনো পাঠানো হয়নি', 400);
    }

    // Already told, for this transition. Charging a shop twice for the same
    // announcement is the second question the notification log exists to
    // answer, so refuse rather than log it a second time.
    if ((order.notifications || []).some((n) => n.channel === 'sms' && n.status === kind && n.ok)) {
      throw new AppError('Already sent', 'এই বার্তাটি আগেই পাঠানো হয়েছে', 409);
    }

    const phone = order.customer?.phone;
    if (!phone) throw new AppError('No phone number', 'কাস্টমারের নম্বর নেই', 400);

    const text = kind === 'shipped'
      ? `আপনার অর্ডার ${order.orderNo} পাঠানো হয়েছে। শীঘ্রই পৌঁছে যাবে।`
      : `আপনার অর্ডার ${order.orderNo} নিশ্চিত হয়েছে। মোট ৳${order.total}।`;

    const smsService = require('./sms.service');
    let ok = true;
    let error = null;
    try {
      await smsService.sendSingle(order.shop, userId, phone, text, null, req, {
        audience: kind === 'shipped' ? 'order_shipped' : 'order_confirmed',
      });
    } catch (err) {
      // An exhausted quota or a gateway outage is recorded, not thrown: the
      // order is unaffected, and the shopkeeper needs to see WHY it did not go
      // rather than a red toast they cannot act on later.
      ok = false;
      error = String(err?.messageBn || err?.message || '').slice(0, 300);
      logger.warn(`[Order] SMS ${kind} for ${order.orderNo}: ${error}`);
    }

    order.notifications.push({
      channel: 'sms',
      status: kind,
      to: phone,
      text,
      sentAt: new Date(),
      sentBy: userId || null,
      ok,
      ...(error ? { error } : {}),
    });
    await order.save();

    return {
      ok,
      error,
      order: {
        ...this.toMerchantOrder(order.toObject()),
        // Preserved across the response so the button does not vanish and
        // reappear while the screen re-renders from this payload.
        smsOffered: {
          confirmed: storefront?.notifications?.smsOnConfirm === true,
          shipped: storefront?.notifications?.smsOnShip === true,
        },
      },
    };
  }

  /**
   * CONFIRM — the one door into the ledger (I-9).
   *
   * The exact sequence matters and is worth stating:
   *
   *   1. CLAIM the order atomically (`pending` → `confirmed`, sale still null).
   *      Two staff confirming at once resolve here: one claims, one gets a 409.
   *   2. Run `saleService.createSale` — the EXISTING path, transactional, with
   *      its atomic stock guard, customer create/link, CustomerBalance, audit.
   *      Prices are handed in as trusted overrides so the Sale bills what the
   *      order quoted, not today's shelf price (see createSale's note).
   *   3. Stamp `order.sale` — set exactly once.
   *
   *   If step 2 throws (usually 409 "পর্যাপ্ত স্টক নেই"), the claim is rolled
   *   back and the order returns to `pending` with nothing consumed. A crash
   *   between 2 and 3 leaves a confirmed order with `sale: null` and the Sale
   *   already booked — visible (the detail screen shows the mismatch) and
   *   fixable, which beats the reverse ordering where a crash books a Sale
   *   nobody can find from the worklist at all.
   */
  async confirmOrder(req, orderId, userId) {
    const shopId = req.shop._id;

    // Read first for the branch guard and the line mapping — the atomic claim
    // below is what actually decides the race.
    const existing = await Order.findOne({ _id: orderId, shop: shopId }).lean();
    if (!existing) {
      throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    }
    if (existing.status !== 'pending') {
      throw new AppError(
        `Order is already ${existing.status}`,
        existing.status === 'cancelled'
          ? 'অর্ডারটি বাতিল করা হয়েছে'
          : 'অর্ডারটি ইতিমধ্যে নিশ্চিত করা হয়েছে',
        409
      );
    }

    // The sale must land in the branch that will fulfil it. For a single-branch
    // shop everything here is null and nothing happens. For a multi-branch
    // shop, `createSale` writes into the ACTIVE branch (`requireBranch`), so an
    // order pinned to a branch may only be confirmed with that branch active.
    if (existing.branch && !isActiveBranch(req, existing.branch)) {
      const branchDoc = await mongoose.model('Branch')
        .findById(existing.branch).select('name code').lean();
      const err = wrongBranchError(req, branchDoc);
      throw err || new AppError('Order belongs to another branch', 'অর্ডারটি অন্য শাখার', 404);
    }

    // Map order lines to createSale's shape: variantSku (what the storefront
    // publishes) → variantId (what the POS path addresses). One query.
    const productIds = [...new Set(existing.items.map((i) => String(i.product)))];
    const products = await Product.find({ _id: { $in: productIds }, shop: shopId })
      .select('variants.sku variants._id')
      .lean();
    const skuToId = new Map();
    for (const p of products) {
      for (const v of p.variants || []) {
        skuToId.set(`${p._id}:${v.sku}`, v._id);
      }
    }

    const saleItems = [];
    const unitPriceOverrides = new Map();
    for (const line of existing.items) {
      const productId = String(line.product);
      let variantId = null;
      if (line.variantSku) {
        variantId = skuToId.get(`${productId}:${line.variantSku}`);
        if (!variantId) {
          throw new AppError(
            `Variant no longer exists for "${line.name}"`,
            `"${line.name}" এর অপশনটি আর নেই — অর্ডারটি বাতিল করে নতুন করে নিন`,
            409
          );
        }
      }
      saleItems.push({ productId, variantId, quantity: line.quantity });
      unitPriceOverrides.set(
        variantId ? `${productId}:${variantId}` : productId,
        line.unitPrice
      );
    }

    // 1. Claim.
    const claimStamp = { status: 'confirmed', at: new Date(), by: userId || null };
    const claimed = await Order.findOneAndUpdate(
      { _id: orderId, shop: shopId, status: 'pending' },
      {
        $set: { status: 'confirmed', confirmedAt: claimStamp.at, confirmedBy: userId || null },
        $push: { statusHistory: claimStamp },
      },
      { new: true }
    );
    if (!claimed) {
      throw new AppError('Order was just handled by someone else', 'অর্ডারটি এইমাত্র অন্য কেউ প্রসেস করেছে', 409);
    }

    // 2. The Sale. Lazy require: sale.service is heavy and order placement (the
    // hot public path through this module) never needs it.
    const saleService = require('./sale.service');
    let sale;
    try {
      sale = await saleService.createSale(
        shopId,
        userId,
        {
          items: saleItems,
          customerName: existing.customer.name,
          customerPhone: existing.customer.phone,
          paid: 0,
          isOnline: true,
          channel: existing.source === 'storefront' ? 'website' : 'other',
          deliveryCharge: existing.deliveryCharge || 0,
          shippingAddress: existing.delivery?.isPickup
            ? 'পিকআপ'
            : existing.customer.address,
          notes: [existing.customer.note, existing.sourceNote, `অনলাইন অর্ডার ${existing.orderNo}`]
            .filter(Boolean)
            .join(' · '),
        },
        req,
        { unitPriceOverrides }
      );
    } catch (err) {
      // Roll the claim back — the order returns to the worklist untouched.
      await Order.updateOne(
        { _id: orderId, shop: shopId, status: 'confirmed', sale: null },
        {
          $set: { status: 'pending', confirmedAt: null, confirmedBy: null },
          $pop: { statusHistory: 1 },
        }
      ).catch((revertErr) =>
        logger.error(`[Order] confirm rollback failed for ${existing.orderNo}: ${revertErr.message}`)
      );
      throw err;
    }

    // 3. Stamp the link. Set exactly once, never rewritten.
    const order = await Order.findOneAndUpdate(
      { _id: orderId, shop: shopId, sale: null },
      { $set: { sale: sale._id } },
      { new: true }
    ).lean();

    // Confirmed revenue is the storefront stat that means money.
    Storefront.updateOne(
      { shop: shopId },
      { $inc: { 'stats.totalRevenue': existing.total } }
    ).catch(() => {});

    logger.info(`[Order] ${existing.orderNo} confirmed → sale ${sale.invoiceNo}`);
    return { order: this.toMerchantOrder(order), sale: { _id: sale._id, invoiceNo: sale.invoiceNo } };
  }

  /**
   * Cancel.
   *
   * Before confirm this is free — the order touched nothing (I-9), so
   * cancelling is a status write and nothing else. After confirm there is a
   * Sale, and the ONLY sanctioned unwind is `saleService.cancelSale`, which
   * restores stock, reverses the customer's due and audits both sides.
   * A delivered order is past cancelling — that is a sales return.
   */
  async cancelOrder(req, orderId, userId, reason = '') {
    const existing = await Order.findOne(
      branchFilter(req, { _id: orderId, shop: req.shop._id })
    ).lean();
    if (!existing) {
      throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    }
    if (existing.status === 'cancelled') {
      throw new AppError('Already cancelled', 'অর্ডারটি আগেই বাতিল হয়েছে', 409);
    }
    if (existing.status === 'delivered') {
      throw new AppError(
        'A delivered order is returned, not cancelled',
        'ডেলিভারি হয়ে যাওয়া অর্ডার বাতিল নয় — রিটার্ন করুন',
        400
      );
    }

    // Unwind the books first. If this throws, the order stays as it was —
    // an order marked cancelled with a live Sale behind it would be a lie in
    // the one place the shopkeeper checks.
    if (existing.sale) {
      const saleService = require('./sale.service');
      await saleService.cancelSale(
        req.shop._id,
        userId,
        existing.sale,
        reason || `অনলাইন অর্ডার ${existing.orderNo} বাতিল`,
        req.branchId || null
      );
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, shop: req.shop._id, status: existing.status },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: userId || null,
          cancelReason: String(reason || '').slice(0, 500),
        },
        $push: {
          statusHistory: { status: 'cancelled', at: new Date(), by: userId || null },
        },
      },
      { new: true }
    ).lean();

    if (!order) {
      throw new AppError(
        'Order state changed — refresh and retry',
        'অর্ডারটির অবস্থা বদলে গেছে — রিফ্রেশ করে আবার চেষ্টা করুন',
        409
      );
    }

    return this.toMerchantOrder(order);
  }

  /**
   * The merchant's view of an order.
   *
   * Same allowlist discipline as `toPublicOrder`, one level up in trust: the
   * caller is authenticated staff, so they get the lifecycle, the history and
   * the forensics — but still NOT `items[].buyingPrice`. Cost is `sales.view`
   * territory once a Sale exists; a cashier working the parcel desk does not
   * need every margin in the catalogue on a screen that faces the shop floor.
   */
  toMerchantOrder(order) {
    if (!order) return null;
    return {
      _id: order._id,
      orderNo: order.orderNo,
      status: order.status,
      source: order.source,
      sourceNote: order.sourceNote || null,
      branch: order.branch || null,
      customer: {
        name: order.customer?.name,
        phone: order.customer?.phone,
        address: order.customer?.address,
        note: order.customer?.note || null,
      },
      items: (order.items || []).map((i) => ({
        product: i.product,
        variantSku: i.variantSku || null,
        name: i.name,
        code: i.code || null,
        variantLabel: i.variantLabel || null,
        unit: i.unit || null,
        image: i.image || null,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        compareAtPrice: i.compareAtPrice ?? null,
        lineTotal: i.lineTotal,
      })),
      delivery: order.delivery || null,
      subtotal: order.subtotal,
      deliveryCharge: order.deliveryCharge,
      total: order.total,
      paymentMethod: order.paymentMethod,
      sale: order.sale || null,
      confirmedAt: order.confirmedAt || null,
      cancelledAt: order.cancelledAt || null,
      cancelReason: order.cancelReason || null,
      deliveredAt: order.deliveredAt || null,
      statusHistory: order.statusHistory || [],
      /**
       * What has already been texted, so the detail screen can grey out a
       * button rather than let a shopkeeper pay twice for the same
       * announcement. `text` is included because "why was I charged for four
       * messages on one order" is answered by showing the four messages.
       */
      notifications: (order.notifications || []).map((n) => ({
        channel: n.channel,
        status: n.status || null,
        text: n.text || null,
        sentAt: n.sentAt || null,
        ok: n.ok !== false,
        error: n.error || null,
      })),
      meta: {
        ip: order.meta?.ip || null,
        userAgent: order.meta?.userAgent || null,
      },
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * Find one order for the public tracking page.
   *
   * Both the order number and the phone must match. See the controller for why
   * the number alone is not enough — it is sequential and therefore guessable,
   * and the record behind it is a name, an address and a shopping list.
   *
   * The phone is normalised before comparison so a customer who typed
   * `+8801712345678` at checkout and `01712345678` here is the same person.
   */
  async findForTracking(shopId, orderNo, phone) {
    const normalised = normalizePhone(phone);
    if (!normalised || !String(orderNo || '').trim()) return null;

    return Order.findOne({
      shop: shopId,
      orderNo: String(orderNo).trim().toUpperCase(),
      'customer.phone': normalised,
    }).lean();
  }

  /**
   * The customer-facing view of an order.
   *
   * An ALLOWLIST, built by naming keys, for exactly the reason
   * `publicStorefront.service.toPublicProduct` is: this is served to an
   * unauthenticated stranger, and `Order.items[].buyingPrice` is what the shop
   * paid its supplier. Spreading the document and deleting a field is one
   * forgotten line away from publishing every margin in the catalogue.
   *
   * `meta` is absent too — the customer's own IP is not interesting to them and
   * echoing it back is a gift to anyone probing.
   */
  toPublicOrder(order) {
    return {
      orderNo: order.orderNo,
      status: order.status,
      placedAt: order.createdAt,
      customer: {
        name: order.customer?.name,
        phone: order.customer?.phone,
        address: order.customer?.address,
      },
      items: (order.items || []).map((i) => ({
        name: i.name,
        variantLabel: i.variantLabel || null,
        unit: i.unit || null,
        image: i.image || null,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      delivery: {
        zoneName: order.delivery?.zoneName || null,
        charge: order.delivery?.charge || 0,
        etaDaysMin: order.delivery?.etaDaysMin ?? null,
        etaDaysMax: order.delivery?.etaDaysMax ?? null,
        isPickup: order.delivery?.isPickup === true,
      },
      subtotal: order.subtotal,
      deliveryCharge: order.deliveryCharge,
      total: order.total,
      paymentMethod: order.paymentMethod,
    };
  }
}

module.exports = new OrderService();

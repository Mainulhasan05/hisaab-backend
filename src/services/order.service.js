const mongoose = require('mongoose');
const Order = require('../models/Order.model');
const OrderCounter = require('../models/OrderCounter.model');
const Product = require('../models/Product.model');
const Storefront = require('../models/Storefront.model');
const publicStorefrontService = require('./publicStorefront.service');
const { AppError } = require('../middleware/error.middleware');
const {
  getBangladeshTodayStr,
  getBangladeshTodayRange,
  getBangladeshDayRange,
} = require('../utils/bdTime.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { normalizePhone, isValidPhone } = require('../utils/phone.util');
const { branchFilter, branchMatch, isActiveBranch, wrongBranchError } = require('../utils/branchScope.util');
const { resolveAddress, _norm: geoNorm } = require('../utils/bdGeo.util');
const { buildOrderStatusSms, ORDER_SMS_KINDS } = require('../utils/smsTemplates.util');
const { channelForOrder } = require('../utils/channel.util');
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
 * How long an order may sit in one state before it counts as STUCK.
 *
 * ── WHY THE WORKLIST NEEDED A NOTION OF "LATE" AT ALL ───────────────────────
 *
 * Status tabs answer "what state is this in". They do not answer the question
 * the shop actually loses money on, which is "what have I forgotten". An
 * unconfirmed order is a customer who has not been called; two days later it is
 * a customer who has bought elsewhere. The tab said `নতুন ৫` whether those five
 * arrived nine minutes ago or nine days ago.
 *
 * Measured against `updatedAt` — TIME SINCE LAST MOVEMENT, one meaning for
 * every state. For a pending order nothing has touched it, so `updatedAt` is
 * `createdAt` and this reads as age since placement; for the rest it reads as
 * time in the current state, which is the right question once someone has
 * started work on it. Using `createdAt` throughout would flag a shipped parcel
 * for being old rather than for being late.
 *
 * `delivered` and `cancelled` are absent because they are terminal: an order
 * that is finished cannot be late.
 */
const STUCK_AFTER_HOURS = Object.freeze({
  pending: 24,
  confirmed: 48,
  packed: 48,
  shipped: 168, // a week on the road is a parcel to chase the courier about
});

/** Ceiling on an export, so one click cannot ask for a shop's entire history. */
const EXPORT_MAX_ROWS = 5000;

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
  async quoteOrder({
    shopId,
    storefront,
    items,
    address,
    pickup = false,
    onlineOnly = true,
    requireSubdistrict = true,
  }) {
    const { lines, subtotal } = await this.resolveLines(shopId, { items, onlineOnly });

    let delivery;
    try {
      delivery = this.resolveDelivery(storefront, address, { pickup, requireSubdistrict });
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

    /**
     * The locality, attached AFTER the zone is settled — never before.
     *
     * Placing it here rather than passing it into `resolveDelivery` is the
     * whole guarantee: an unvalidated string cannot have influenced the charge,
     * because the charge was already decided when it arrived. See
     * `Order.delivery.area`.
     */
    const area = String(address?.area || '').trim().slice(0, 80);
    if (area && !delivery.isPickup) delivery = { ...delivery, area };

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
  /**
   * Turn the worklist's query parameters into one Mongo filter.
   *
   * ── EVERY READER OF THIS SCREEN BUILDS ITS FILTER HERE ─────────────────────
   *
   * The list, the tab badges, the totals line and the CSV export are four
   * queries over one question, and the screen is only honest if all four ask it
   * the same way. When the badges were built from an unfiltered
   * `countsByStatus` the tab said `নতুন ১২` above a list of three, because the
   * count ignored the date range the list obeyed — the exact "cards agreeing
   * with the list" failure AGENT_WORKFLOW §7.3 tells us to check for.
   *
   * `omitStatus` is what the badges pass: a tab's own count must reflect every
   * OTHER filter and not itself, or every tab but the active one reads zero.
   *
   * ── WHY `$and` AND NOT TWO `$or` KEYS ──────────────────────────────────────
   *
   * Both the search term and the stuck-order rule are disjunctions. Written as
   * `filter.$or = …` twice, the second silently overwrites the first — the
   * search quietly stops applying and the shopkeeper is handed somebody else's
   * order. They are pushed onto `$and` instead, which composes.
   */
  _worklistFilter(req, { status, q, from, to, source, zone, late, omitStatus = false } = {}) {
    const filter = branchFilter(req, { shop: req.shop._id });
    const and = [];

    if (!omitStatus && status && Order.ORDER_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (source === 'storefront' || source === 'manual') {
      filter.source = source;
    }

    /**
     * The delivery arrangement. One control, two shapes of answer: `pickup` is
     * not a zone and cannot be matched as one — an order the customer collects
     * has `zoneKey: null`, so a naive zone filter would match all of them or
     * none of them depending on how it happened to be written.
     */
    if (zone === 'pickup') {
      filter['delivery.isPickup'] = true;
    } else if (zone) {
      filter['delivery.zoneKey'] = zone;
      filter['delivery.isPickup'] = { $ne: true };
    }

    /**
     * Calendar days in Bangladesh, converted here and nowhere else.
     *
     * `getBangladeshDayRange` gives the UTC instants that bound a BD day, so
     * "today" means midnight-to-midnight in Dhaka rather than on the server —
     * which on a UTC host is six hours out and files every order rung before
     * 6am under the previous day.
     *
     * A malformed date is IGNORED rather than allowed to become epoch zero. The
     * route already refuses anything that is not `YYYY-MM-DD`, so reaching here
     * with one means a caller that bypassed it, and silently widening their
     * range to "everything since 1970" is a worse answer than no filter.
     */
    const range = {};
    if (from) {
      const { startOfDay } = getBangladeshDayRange(String(from));
      if (startOfDay instanceof Date && !Number.isNaN(startOfDay.getTime())) {
        range.$gte = startOfDay;
      }
    }
    if (to) {
      const { endOfDay } = getBangladeshDayRange(String(to));
      if (endOfDay instanceof Date && !Number.isNaN(endOfDay.getTime())) {
        range.$lte = endOfDay;
      }
    }
    if (range.$gte || range.$lte) filter.createdAt = range;

    if (q && String(q).trim()) {
      const term = String(q).trim();
      const phone = normalizePhone(term);
      // An order number or a phone — the two things a shopkeeper actually has
      // in hand when a customer calls. Never a free regex over names on an
      // unindexed field.
      and.push({
        $or: [
          { orderNo: term.toUpperCase() },
          ...(phone ? [{ 'customer.phone': phone }] : []),
        ],
      });
    }

    if (late === true || late === 'true') {
      const now = Date.now();
      and.push({
        $or: Object.entries(STUCK_AFTER_HOURS).map(([state, hours]) => ({
          status: state,
          updatedAt: { $lt: new Date(now - hours * 60 * 60 * 1000) },
        })),
      });
    }

    if (and.length) filter.$and = and;
    return filter;
  }

  /**
   * The worklist. `{shop, status, createdAt:-1}` is the index this rides.
   *
   * NEWEST-FIRST everywhere, including the pending tab.
   *
   * ── WHY THIS CHANGED ────────────────────────────────────────────────────────
   *
   * Pending used to be oldest-first, on §7.2's rule that the order which has
   * waited longest is the one to deal with next. That is sound queue theory and
   * it was the wrong screen for it: a shopkeeper who has just been pinged about
   * a new order opens this list to find THAT order, and it was at the bottom,
   * behind every older one they had already decided not to deal with yet. The
   * most recent event is the reason the screen was opened.
   *
   * The anti-rot property oldest-first was protecting is not lost, because it
   * is not this sort's job any more — `STUCK_AFTER_HOURS` and the `late` filter
   * do it directly and better. An order that has sat too long is named as stuck,
   * counted on the overview and reachable in one tap from there, rather than
   * being merely near the top of a list and hoping to be noticed. Position was
   * always a weak signal for "this is rotting"; a label is a strong one.
   *
   * An explicit `sort` still overrides, because a shopkeeper reconciling a
   * day's takings wants the big ones first and does not care when they arrived.
   */
  async listOrders(req, { page = 1, limit = 20, sort: sortBy, ...criteria } = {}) {
    const filter = this._worklistFilter(req, criteria);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort(this._sortFor(sortBy, criteria.status))
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
   * The sort clause, given an explicit choice.
   *
   * `status` is still taken so the signature does not have to change at three
   * call sites, and because "the default depends on the tab" is a decision that
   * has already been made once and reversed once — the next person to want it
   * has the parameter waiting rather than having to thread it through again.
   * See `listOrders` for why the answer is currently the same for every tab.
   */
  // eslint-disable-next-line no-unused-vars
  _sortFor(sortBy, status) {
    if (sortBy === 'oldest') return { createdAt: 1 };
    if (sortBy === 'newest') return { createdAt: -1 };
    if (sortBy === 'amount') return { total: -1, createdAt: -1 };
    // Newest-first on every tab, pending included. The oldest-first default the
    // pending tab used to carry buried the order the shopkeeper opened the
    // screen to find; staleness is surfaced by `late`/`stuck`, not by position.
    return { createdAt: -1 };
  }

  /**
   * How many orders the current filter matches, and what they are worth.
   *
   * The worth is the part that needs saying out loud: this is the sum of
   * `total` over whatever is being looked at, which on a `delivered` tab is
   * money earned and on a `pending` tab is money merely HOPED for. The screen
   * labels it per tab; a service that returned one number called "revenue"
   * would be inviting the two to be added together, which is the habit
   * `summary` already refuses to teach.
   */
  async worklistTotals(req, criteria = {}) {
    const rows = await Order.aggregate([
      { $match: branchMatch(req, this._worklistFilter(req, criteria)) },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$total' } } },
    ]);
    return {
      count: rows[0]?.count || 0,
      amount: quantizeMoney(rows[0]?.amount || 0),
    };
  }

  /**
   * The rows behind the current view, for a spreadsheet.
   *
   * One line per ORDER, not per item: what a shop reconciles is the parcel and
   * the money on it. `EXPORT_MAX_ROWS` caps it so a shop with a year of history
   * and no filters cannot ask for all of it at once — and the caller is told
   * when it was truncated rather than being handed a file that quietly stops.
   */
  async exportRows(req, criteria = {}) {
    const orders = await Order.find(this._worklistFilter(req, criteria))
      .sort(this._sortFor(criteria.sort, criteria.status))
      .limit(EXPORT_MAX_ROWS + 1)
      .lean();

    return {
      orders: orders.slice(0, EXPORT_MAX_ROWS).map((o) => this.toMerchantOrder(o)),
      truncated: orders.length > EXPORT_MAX_ROWS,
      limit: EXPORT_MAX_ROWS,
    };
  }

  /**
   * Order counts per status — the tab badges and the dashboard's pending tile.
   *
   * ── THE BADGES OBEY EVERY FILTER EXCEPT THE TABS THEMSELVES ────────────────
   *
   * `omitStatus: true` is the whole subtlety. A tab's badge must be counted
   * under the date range, source, zone and search the user has set — otherwise
   * "নতুন ১২" sits above a list of three and the shopkeeper cannot tell which
   * number is the lie. But it must NOT be counted under the active status, or
   * every tab except the open one reads zero.
   *
   * Passing no criteria at all gives the whole-shop counts, which is what the
   * overview's pending tile wants.
   *
   * `branchMatch`, not `branchFilter`: this is an aggregation and `$match` does
   * not cast (I-3).
   */
  async countsByStatus(req, criteria = {}) {
    const rows = await Order.aggregate([
      { $match: branchMatch(req, this._worklistFilter(req, { ...criteria, omitStatus: true })) },
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
   * COMMITTED STOCK — units promised to pending orders that have NOT left the
   * shelf yet.
   *
   * ── Why this is a number and not a reservation ──────────────────────────────
   *
   * Placing an order deducts nothing (I-9, and `_assertStock`'s note explains
   * why reserving would let a stranger with a script empty a shop's shelves on
   * paper). That decision is right and this does not change it.
   *
   * What it left behind was a silence. With three shirts on the shelf and three
   * pending orders for shirts, `Product.stock` says 3, the storefront says "in
   * stock", the reorder alert stays quiet, and the counter will happily sell all
   * three — and the shopkeeper finds out when the parcel desk presses confirm
   * and gets "পর্যাপ্ত স্টক নেই" on an order they already promised someone. The
   * shop was never told what it had committed.
   *
   * So: the units stay available, and the commitment becomes VISIBLE. The
   * shopkeeper decides what to do about it, which is the same division of labour
   * as everywhere else here — the system does not silently reserve, and it does
   * not silently hide either.
   *
   * ── Pending only ────────────────────────────────────────────────────────────
   *
   * `confirmed` and everything after it has ALREADY come off `Product.stock`;
   * counting those here would double-count the same units, showing a shop twice
   * the exposure it has. `cancelled` and `returned` never take any.
   *
   * @param {object} req
   * @param {string[]|null} productIds Restrict to these products, for a screen
   *   showing a page of them. Null = every product with pending demand.
   * @returns {Promise<Map<string, number>>} product id (string) → units promised
   */
  async committedStock(req, productIds = null) {
    const match = branchMatch(req, { shop: req.shop._id, status: 'pending' });
    const pipeline = [
      { $match: match },
      { $unwind: '$items' },
    ];
    if (Array.isArray(productIds) && productIds.length) {
      pipeline.push({
        $match: {
          'items.product': {
            $in: productIds.map((id) => new mongoose.Types.ObjectId(String(id))),
          },
        },
      });
    }
    pipeline.push({
      $group: { _id: '$items.product', units: { $sum: '$items.quantity' } },
    });

    const rows = await Order.aggregate(pipeline);
    return new Map(rows.map((r) => [String(r._id), r.units || 0]));
  }

  /**
   * How many orders are STUCK, by state — the overview's "কাজ বাকি" queue.
   *
   * Not derivable from `countsByStatus`: that answers "how many are pending",
   * and the question a shop loses money on is "how many have been pending too
   * long". See `STUCK_AFTER_HOURS`.
   *
   * Every id in the `$match` comes from `branchMatch`, which casts (I-3).
   */
  async stuckCounts(req) {
    const now = Date.now();
    const rows = await Order.aggregate([
      {
        $match: branchMatch(req, {
          shop: req.shop._id,
          $or: Object.entries(STUCK_AFTER_HOURS).map(([state, hours]) => ({
            status: state,
            updatedAt: { $lt: new Date(now - hours * 60 * 60 * 1000) },
          })),
        }),
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const stuck = Object.fromEntries(Object.keys(STUCK_AFTER_HOURS).map((s) => [s, 0]));
    for (const row of rows) {
      if (row._id in stuck) stuck[row._id] = row.count;
    }
    stuck.total = rows.reduce((sum, r) => sum + r.count, 0);
    return stuck;
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

    /**
     * Yesterday, bounded the same way.
     *
     * A count on its own is not information — "৭টি অর্ডার" is good or bad only
     * against something. Derived by subtracting a day from today's BD-aligned
     * start rather than by formatting a date string, so the two windows cannot
     * disagree about where a day begins.
     */
    const dayMs = 24 * 60 * 60 * 1000;
    const yesterdayRange = {
      $gte: new Date(startOfDay.getTime() - dayMs),
      $lte: new Date(endOfDay.getTime() - dayMs),
    };

    const dayShape = {
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
    };

    const [counts, stuck, todayRows, yesterdayRows, recent, committed] = await Promise.all([
      this.countsByStatus(req),
      this.stuckCounts(req),
      Order.aggregate([
        { $match: branchMatch(req, { shop: req.shop._id, createdAt: todayRange }) },
        { $group: dayShape },
      ]),
      Order.aggregate([
        { $match: branchMatch(req, { shop: req.shop._id, createdAt: yesterdayRange }) },
        { $group: dayShape },
      ]),
      Order.find(branchFilter(req, { shop: req.shop._id }))
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      this.committedStock(req),
    ]);

    const day = (rows) => ({
      placed: rows[0]?.placed || 0,
      confirmedRevenue: quantizeMoney(rows[0]?.confirmedRevenue || 0),
    });

    /**
     * What pending orders have PROMISED, and which of those promises the shelf
     * cannot currently keep.
     *
     * `short` is the part worth acting on: products where pending demand already
     * exceeds what is in stock. Every one of those is an order that will be
     * refused at confirm with "পর্যাপ্ত স্টক নেই" unless the shop restocks — and
     * before this, the first anyone heard of it was that refusal.
     *
     * Compared at PRODUCT level even for variant products, whose `stock` is the
     * rollup of their variants. That is coarse: three orders for size M and ten
     * L's on the shelf reads as covered. It is still the right first cut —
     * it is never a false alarm (if the total is short, something certainly is),
     * and the per-variant version needs the same comparison keyed on
     * `items.variantSku`, which is a bigger read for a warning nobody has asked
     * to be more precise yet.
     */
    let committedUnits = 0;
    let shortProducts = [];
    if (committed.size) {
      for (const units of committed.values()) committedUnits += units;
      const ids = [...committed.keys()];
      const products = await Product.find({
        _id: { $in: ids },
        shop: req.shop._id,
        isDeleted: { $ne: true },
      })
        .select('name code stock')
        .lean();
      shortProducts = products
        .map((p) => ({
          _id: p._id,
          name: p.name,
          code: p.code || null,
          stock: Number(p.stock) || 0,
          committed: committed.get(String(p._id)) || 0,
        }))
        .filter((p) => p.committed > p.stock)
        .sort((a, b) => (b.committed - b.stock) - (a.committed - a.stock))
        .slice(0, 10);
    }

    return {
      counts,
      /**
       * Stock promised but not yet taken — the visible half of I-9.
       *
       * `units` is what pending orders have asked for and the shelf has NOT
       * given up: placing an order moves no stock, and this is the shop being
       * told so in a number rather than finding out at confirm time. `short` is
       * the subset already over-promised.
       */
      committedStock: {
        units: committedUnits,
        products: committed.size,
        short: shortProducts,
      },
      /**
       * The action queue: what is waiting on a human right now.
       *
       * ── ONE TILE, ONE STATUS, DELIBERATELY ────────────────────────────────
       *
       * The obvious shape was a single "পাঠাতে হবে" spanning confirmed AND
       * packed — two states of one job, and it reads better. It is also a lie
       * the moment it is tapped: the overview links each row into the worklist,
       * the worklist filters by ONE status, and a tile saying five that opens a
       * list of three is precisely the card-disagrees-with-the-list failure
       * AGENT_WORKFLOW §7.3 names. Better wording is not worth a number the
       * shopkeeper learns to distrust.
       *
       * `stuck` is the exception and is allowed to span statuses, because the
       * worklist has a filter that means exactly it (`late=true`).
       */
      queue: {
        pending: counts.pending || 0,
        confirmed: counts.confirmed || 0,
        packed: counts.packed || 0,
        inTransit: counts.shipped || 0,
        stuck: stuck.total || 0,
      },
      stuck,
      today: day(todayRows),
      yesterday: day(yesterdayRows),
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

    return this.toMerchantOrder(order);
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
    if (!ORDER_SMS_KINDS.includes(kind)) {
      throw new AppError('Unknown notification', 'এই ধরনের বার্তা পাঠানো যায় না', 400);
    }

    const order = await Order.findOne(
      branchFilter(req, { _id: orderId, shop: req.shop._id })
    );
    if (!order) throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);

    /**
     * The message must describe the order's ACTUAL state.
     *
     * The shopkeeper presses this from the order screen, which may have been
     * open since before someone else moved the order on — so a "confirmed"
     * message could otherwise go out for an order that has since been
     * cancelled. Announcing a state the order is not in is worse than not
     * announcing at all, because the customer acts on it.
     *
     * `cancelled` and `delivered` are exact. The rest allow any LATER state
     * too: a shop that packed and shipped in one go may still want to send the
     * confirmation it never got round to.
     */
    const ORDER = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];
    const reached = ORDER.indexOf(order.status);
    const needed = ORDER.indexOf(kind);
    const stateOk = kind === 'cancelled'
      ? order.status === 'cancelled'
      : order.status !== 'cancelled' && reached >= needed && needed > 0;

    if (!stateOk) {
      throw new AppError(
        `Order is ${order.status}`,
        'অর্ডারের বর্তমান অবস্থার সাথে এই বার্তাটি মেলে না — পাতাটি রিফ্রেশ করুন',
        409
      );
    }

    // Already told, for this transition. Charging a shop twice for the same
    // announcement is the second question the notification log exists to
    // answer, so refuse rather than log it a second time.
    if ((order.notifications || []).some((n) => n.channel === 'sms' && n.status === kind && n.ok)) {
      throw new AppError('Already sent', 'এই বার্তাটি আগেই পাঠানো হয়েছে', 409);
    }

    const phone = order.customer?.phone;
    if (!phone) throw new AppError('No phone number', 'কাস্টমারের নম্বর নেই', 400);

    /**
     * Built by the SHARED template, never inline here.
     *
     * `lib/sms/templates.js` mirrors that builder character for character and
     * is what the order screen previews. Composing a body here instead would
     * mean the preview the shopkeeper approved and the message the customer
     * receives came from two different pieces of code — which is the one thing
     * a preview exists to rule out.
     */
    const text = buildOrderStatusSms({
      kind,
      orderNo: order.orderNo,
      total: order.total,
      isPickup: order.delivery?.isPickup === true,
    });
    if (!text) {
      throw new AppError('No message for this status', 'এই অবস্থার জন্য কোনো বার্তা নেই', 400);
    }

    const smsService = require('./sms.service');
    let ok = true;
    let error = null;
    try {
      await smsService.sendSingle(order.shop, userId, phone, text, null, req, {
        audience: `order_${kind}`,
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

    return { ok, error, order: this.toMerchantOrder(order.toObject()) };
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
    const buyingPriceOverrides = new Map();
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
      const key = variantId ? `${productId}:${variantId}` : productId;
      saleItems.push({ productId, variantId, quantity: line.quantity });
      unitPriceOverrides.set(key, line.unitPrice);
      /**
       * The COST as it stood when the order was placed.
       *
       * Only set when the line actually carries one. Orders placed before
       * `buyingPrice` was populated have it as `undefined`, and passing that
       * through would be read as "cost 0" by the override — turning the whole
       * line into pure profit. Absent here means `createSale` falls back to the
       * product's current cost, which is exactly what it did before this map
       * existed, so old orders confirm as they always have.
       */
      if (Number.isFinite(line.buyingPrice)) {
        buyingPriceOverrides.set(key, line.buyingPrice);
      }
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
          /**
           * Derived from the shop's own `sourceNote`, not hardcoded.
           *
           * This used to be `source === 'storefront' ? 'website' : 'other'`,
           * which collapsed EVERY manual order into `other` — and manual is how
           * most shops here actually sell, so the one field a channel report
           * could group by was accurate only for the storefront. See
           * utils/channel.util.js for why the note itself cannot be the key.
           */
          channel: channelForOrder(existing),
          deliveryCharge: existing.deliveryCharge || 0,
          shippingAddress: existing.delivery?.isPickup
            ? 'পিকআপ'
            : existing.customer.address,
          notes: [existing.customer.note, existing.sourceNote, `অনলাইন অর্ডার ${existing.orderNo}`]
            .filter(Boolean)
            .join(' · '),
        },
        req,
        { unitPriceOverrides, buyingPriceOverrides, order: orderId }
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
    if (existing.status === 'returned') {
      throw new AppError(
        'This parcel was already returned',
        'এই পার্সেলটি আগেই ফেরত এসেছে',
        409
      );
    }
    if (existing.status === 'delivered') {
      throw new AppError(
        'A delivered order is returned, not cancelled',
        'ডেলিভারি হয়ে যাওয়া অর্ডার বাতিল নয় — রিটার্ন করুন',
        400
      );
    }
    // A shipped parcel is an RTO, not a cancellation, and the two are counted
    // separately on purpose — see `returnOrder` and the lifecycle note on
    // `Order.model.js`. Sending them here would also dead-end: `cancelSale`
    // refuses while a courier holds the money, and this path has no way to
    // release it.
    if (existing.status === 'shipped') {
      throw new AppError(
        'A shipped parcel is returned, not cancelled',
        'পাঠানো পার্সেল বাতিল নয় — "পার্সেল ফেরত এসেছে" ব্যবহার করুন',
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
   * RTO — the parcel shipped, the customer refused it, and it is back.
   *
   * ── WHY THIS IS NOT JUST `cancelOrder` ──────────────────────────────────────
   *
   * Two reasons, one for the shopkeeper and one for the code.
   *
   * For the shopkeeper: a refused parcel and a cancelled order cost completely
   * different amounts, and only one of them is a number worth watching. See the
   * lifecycle note on `Order.model.js`.
   *
   * For the code: a shipped parcel's money is usually sitting on a courier's
   * balance, and `cancelSale` REFUSES to void an invoice in that state — "this
   * parcel is still with a courier, record its return first". That refusal is
   * correct and must stay. But before this method existed, the only way to
   * obey it was to leave the online orders screen, find the invoice in the
   * sales list, press "পার্সেল ফেরত এসেছে" there, then come back and cancel:
   * three screens, in an order nothing tells you, for the single most common
   * outcome in a COD business. The 409 was accurate and useless.
   *
   * So this does the whole unwind in the order it has to happen:
   *
   *   1. release the courier's money back onto the customer's খাতা, if a
   *      courier is holding it (`undispatchFromCourier`);
   *   2. void the invoice — stock back on the shelf, due reversed
   *      (`cancelSale`, which now has nothing to object to);
   *   3. mark the order `returned`.
   *
   * ── FAILURE ORDERING ────────────────────────────────────────────────────────
   *
   * Books first, status last, exactly as `cancelOrder` does it. If step 1 or 2
   * throws, the order stays `shipped` and the shopkeeper sees why — an order
   * marked returned with a live invoice behind it would be a lie in the one
   * place they check. The reverse ordering has no such recovery.
   *
   * A crash between 2 and 3 leaves a cancelled Sale under a `shipped` order.
   * That is visible (the detail screen shows the sale as cancelled) and is
   * fixed by pressing the button again — step 1 no-ops with no courier, and
   * step 2 is refused as already-cancelled, which this treats as success for
   * that reason.
   */
  async returnOrder(req, orderId, userId, reason = '') {
    const existing = await Order.findOne(
      branchFilter(req, { _id: orderId, shop: req.shop._id })
    ).lean();
    if (!existing) {
      throw new AppError('Order not found', 'অর্ডারটি পাওয়া যায়নি', 404);
    }
    if (existing.status === 'returned') {
      throw new AppError('Already returned', 'এই পার্সেলটি আগেই ফেরত এসেছে', 409);
    }
    /**
     * Only a parcel that actually went out can come back.
     *
     * `delivered` is excluded deliberately: the customer HAD the goods, so what
     * follows is a `SalesReturn` against the invoice — which refunds, restocks
     * and books the loss on the day it arrived — not an unwind of the sale as
     * though it never happened.
     */
    if (existing.status !== 'shipped') {
      throw new AppError(
        `Only a shipped parcel can be returned (this one is ${existing.status})`,
        existing.status === 'delivered'
          ? 'ডেলিভারি হয়ে যাওয়া পার্সেলের জন্য "মাল ফেরত" ব্যবহার করুন'
          : 'শুধু পাঠানো পার্সেলই ফেরত আসতে পারে — এটি এখনো পাঠানো হয়নি',
        400
      );
    }

    const trimmedReason = String(reason || '').slice(0, 500);

    if (existing.sale) {
      const saleService = require('./sale.service');

      // 1. Take the money back off the courier, if they are holding it. Skipped
      //    for an own-rider delivery and for any shop without fund accounts,
      //    where there was never a courier leg to reverse.
      const sale = await mongoose.model('Sale')
        .findOne({ _id: existing.sale, shop: req.shop._id })
        .select('courier status')
        .lean();

      if (sale?.courier) {
        await saleService.undispatchFromCourier(
          req.shop._id,
          userId,
          {
            saleId: existing.sale,
            reason: trimmedReason || `অনলাইন অর্ডার ${existing.orderNo} ফেরত এসেছে`,
          },
          req
        );
      }

      // 2. Void the invoice. Already-cancelled is not an error here: it means a
      //    previous attempt got this far and died before stamping the status,
      //    and refusing would strand the order in `shipped` forever.
      if (sale?.status !== 'cancelled') {
        await saleService.cancelSale(
          req.shop._id,
          userId,
          existing.sale,
          trimmedReason || `অনলাইন অর্ডার ${existing.orderNo} ফেরত এসেছে (RTO)`,
          req.branchId || null
        );
      }
    }

    // 3. Stamp it. The status filter is what makes two staff pressing the
    //    button at once resolve to one winner.
    const order = await Order.findOneAndUpdate(
      { _id: orderId, shop: req.shop._id, status: 'shipped' },
      {
        $set: {
          status: 'returned',
          returnedAt: new Date(),
          returnedBy: userId || null,
          returnReason: trimmedReason,
        },
        $push: {
          statusHistory: {
            status: 'returned',
            at: new Date(),
            by: userId || null,
            ...(trimmedReason ? { note: trimmedReason.slice(0, 300) } : {}),
          },
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
      returnedAt: order.returnedAt || null,
      returnReason: order.returnReason || null,
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

const Order = require('../models/Order.model');
const OrderCounter = require('../models/OrderCounter.model');
const Product = require('../models/Product.model');
const publicStorefrontService = require('./publicStorefront.service');
const { AppError } = require('../middleware/error.middleware');
const { getBangladeshTodayStr, getBangladeshTodayRange } = require('../utils/bdTime.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { normalizePhone, isValidPhone } = require('../utils/phone.util');

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
   * Resolve the delivery charge from the storefront's own zone table.
   *
   * Snapshotted onto the order, never referenced: a shop that raises its Dhaka
   * charge must not change what an already-placed order said it would cost.
   *
   * An unknown zone key is refused rather than defaulted to zero — a silent
   * fallback to free delivery on a typo is the shop's money.
   */
  resolveDelivery(storefront, zoneKey, { pickup = false } = {}) {
    if (pickup) {
      if (!storefront?.delivery?.pickupEnabled) {
        throw new AppError('Pickup is not offered', 'পিকআপ সুবিধা নেই', 400);
      }
      return { zoneKey: null, zoneName: null, charge: 0, etaDaysMin: null, etaDaysMax: null, isPickup: true };
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

    const zone = zones.find((z) => z.key === String(zoneKey || '').trim());
    if (!zone) {
      throw new AppError('Choose a delivery area', 'ডেলিভারি এলাকা বেছে নিন', 400);
    }

    return {
      zoneKey: zone.key,
      zoneName: zone.nameBn || zone.name,
      charge: Number(zone.charge) || 0,
      etaDaysMin: zone.etaDaysMin ?? null,
      etaDaysMax: zone.etaDaysMax ?? null,
      isPickup: false,
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
  async nextOrderNo(shopId) {
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

    return `ORD-${today.slice(2).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
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
    zoneKey,
    pickup = false,
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

    const { lines, subtotal } = await this.resolveLines(shopId, { items, onlineOnly });

    let delivery = this.resolveDelivery(storefront, zoneKey, { pickup });
    delivery = this.applyFreeDelivery(storefront, delivery, subtotal);

    const total = quantizeMoney(subtotal + delivery.charge);
    const orderNo = await this.nextOrderNo(shopId);

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

    return order;
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

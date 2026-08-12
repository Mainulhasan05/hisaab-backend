const HeldCart = require('../models/HeldCart.model');
const { AppError } = require('../middleware/error.middleware');
const { branchFilter, requireBranch } = require('../utils/branchScope.util');

class HeldCartService {
  /**
   * Hold current cart
   */
  async holdCart(shopId, userId, cartData, req) {
    const branchId = req ? requireBranch(req) : null;
    const { items, customer, customerName, customerPhone, discount, discountType, deliveryCharge, notes, label } = cartData;

    if (!items || items.length === 0) {
      throw new AppError('Cart is empty', 'কার্ট খালি', 400);
    }

    const heldCart = await HeldCart.create({
      shop: shopId,
      branch: branchId,
      items,
      customer,
      customerName,
      customerPhone,
      discount: discount || 0,
      discountType: discountType || 'fixed',
      deliveryCharge: Number(deliveryCharge) || 0,
      notes,
      label: label || customerName || `Cart #${Date.now().toString(36).slice(-4).toUpperCase()}`,
      heldBy: userId,
    });

    return heldCart;
  }

  /**
   * Get all active held carts for a shop/branch
   */
  async getHeldCarts(shopId, options = {}) {
    const query = { shop: shopId, status: 'held' };
    if (options.branchId) query.branch = options.branchId;


    const carts = await HeldCart.find(query)
      .populate('customer', 'name phone')
      .populate('heldBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return carts;
  }

  /**
   * Get a single held cart
   */
  async getHeldCartById(shopId, cartId, req = null) {
    const cart = await HeldCart.findOne(branchFilter(req, { _id: cartId, shop: shopId }))
      // `isWholesale` and `wholesalePrice` ride along so a resumed cart shows
      // the same prices it was held at. Both are inert for a shop without
      // `features.wholesale` — the till never reads them, since `hasFeature`
      // gates the client the same way it gates the server.
      .populate('customer', 'name phone isWholesale')
      .populate('heldBy', 'name')
      .populate('items.product', 'name code sellingPrice wholesalePrice stock');

    if (!cart) {
      throw new AppError('Held cart not found', 'কার্ট পাওয়া যায়নি', 404);
    }
    return cart;
  }

  /**
   * Resume a held cart — returns cart data for POS to load
   */
  async resumeCart(shopId, cartId, req = null) {
    const cart = await this.getHeldCartById(shopId, cartId, req);

    if (cart.status !== 'held') {
      throw new AppError('Cart is no longer available', 'কার্টটি আর পাওয়া যাচ্ছে না', 400);
    }

    return cart;
  }

  /**
   * Discard a held cart
   */
  async discardCart(shopId, cartId, req = null) {
    const cart = await HeldCart.findOneAndUpdate(
      branchFilter(req, { _id: cartId, shop: shopId, status: 'held' }),
      { status: 'discarded' },
      { new: true }
    );

    if (!cart) {
      throw new AppError('Held cart not found or already processed', 'কার্ট পাওয়া যায়নি', 404);
    }

    return cart;
  }

  /**
   * Mark cart as converted to sale.
   *
   * ⚠️ NOTHING CALLS THIS. There is no route for it and `sale.service.createSale`
   * does not invoke it, so a held cart that has been resumed and sold stays
   * `status: 'held'` for the rest of its life. It keeps showing in the held
   * list, and resuming it a second time produces a second invoice, a second
   * stock deduction and a second entry on the customer's due — for goods that
   * left the shop once.
   *
   * The hold-cart UI is switched off for exactly this reason
   * (`hisaab-frontend/lib/uiFlags.js` → `HOLD_CART_ENABLED`), which is what
   * makes the bug currently unreachable from the app. The routes stay mounted,
   * so a direct API caller can still hit it.
   *
   * Finishing it means calling this from inside `createSale`'s transaction —
   * with the session, so a rolled-back sale does not leave a cart marked
   * converted — and passing the held-cart id through the POS payload. Then a
   * test that resumes and sells the same cart twice, and only then flip the
   * flag.
   */
  async markConverted(shopId, cartId, saleId, req = null) {
    await HeldCart.updateOne(
      branchFilter(req, { _id: cartId, shop: shopId }),
      { status: 'converted', convertedSale: saleId }
    );
  }

  /**
   * Auto-expire old carts for one shop.
   * `shopId` is required — without it this updateMany ran across every shop on
   * the platform, so any cashier could expire another tenant's held carts.
   */
  async expireOldCarts(shopId) {
    if (!shopId) {
      throw new AppError('Shop context required', 'দোকান নির্ধারণ করা যায়নি', 400);
    }

    const result = await HeldCart.updateMany(
      { shop: shopId, status: 'held', expiresAt: { $lt: new Date() } },
      { status: 'expired' }
    );
    return { expired: result.modifiedCount };
  }
}

module.exports = new HeldCartService();

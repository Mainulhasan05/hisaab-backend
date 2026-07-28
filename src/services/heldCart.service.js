const HeldCart = require('../models/HeldCart.model');
const { AppError } = require('../middleware/error.middleware');
const { getBranchForCreate } = require('../utils/branchScope.util');

class HeldCartService {
  /**
   * Hold current cart
   */
  async holdCart(shopId, userId, cartData, req) {
    const branchId = req ? getBranchForCreate(req) : null;
    const { items, customer, customerName, customerPhone, discount, discountType, notes, label } = cartData;

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
  async getHeldCartById(shopId, cartId) {
    const cart = await HeldCart.findOne({ _id: cartId, shop: shopId })
      .populate('customer', 'name phone')
      .populate('heldBy', 'name')
      .populate('items.product', 'name code sellingPrice stock');

    if (!cart) {
      throw new AppError('Held cart not found', 'কার্ট পাওয়া যায়নি', 404);
    }
    return cart;
  }

  /**
   * Resume a held cart — returns cart data for POS to load
   */
  async resumeCart(shopId, cartId) {
    const cart = await this.getHeldCartById(shopId, cartId);

    if (cart.status !== 'held') {
      throw new AppError('Cart is no longer available', 'কার্টটি আর পাওয়া যাচ্ছে না', 400);
    }

    return cart;
  }

  /**
   * Discard a held cart
   */
  async discardCart(shopId, cartId) {
    const cart = await HeldCart.findOneAndUpdate(
      { _id: cartId, shop: shopId, status: 'held' },
      { status: 'discarded' },
      { new: true }
    );

    if (!cart) {
      throw new AppError('Held cart not found or already processed', 'কার্ট পাওয়া যায়নি', 404);
    }

    return cart;
  }

  /**
   * Mark cart as converted to sale
   */
  async markConverted(shopId, cartId, saleId) {
    await HeldCart.updateOne(
      { _id: cartId, shop: shopId },
      { status: 'converted', convertedSale: saleId }
    );
  }

  /**
   * Auto-expire old carts (called periodically or on request)
   */
  async expireOldCarts() {
    const result = await HeldCart.updateMany(
      { status: 'held', expiresAt: { $lt: new Date() } },
      { status: 'expired' }
    );
    return { expired: result.modifiedCount };
  }
}

module.exports = new HeldCartService();

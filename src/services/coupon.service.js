const Coupon = require('../models/Coupon.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

class CouponService {
  // Create coupon
  async createCoupon(shopId, userId, couponData) {
    const {
      code,
      description,
      descriptionBn,
      discountType,
      discountValue,
      minPurchase,
      maxDiscount,
      validFrom,
      validUntil,
      usageLimit,
    } = couponData;

    // Auto-generate code if not provided
    const couponCode = code
      ? code.toUpperCase().trim()
      : await Coupon.generateCode(shopId);

    // Check if code already exists
    const existing = await Coupon.findOne({ shop: shopId, code: couponCode });
    if (existing) {
      throw new AppError(
        'এই কোড দিয়ে ইতিমধ্যে কুপন আছে',
        'Coupon with this code already exists',
        400
      );
    }

    const coupon = await Coupon.create({
      shop: shopId,
      code: couponCode,
      description,
      descriptionBn,
      discountType: discountType || 'fixed',
      discountValue,
      minPurchase: minPurchase || 0,
      maxDiscount: maxDiscount || 0,
      validFrom: validFrom || new Date(),
      validUntil,
      usageLimit: usageLimit || 0,
      createdBy: userId,
    });

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'coupon_create',
      actionBn: 'নতুন কুপন তৈরি',
      description: `Created coupon: ${couponCode}`,
      descriptionBn: `নতুন কুপন তৈরি করা হয়েছে: ${couponCode}`,
      entity: { type: 'coupon', id: coupon._id, name: couponCode },
    });

    return coupon;
  }

  // Get all coupons
  async getCoupons(shopId, options = {}) {
    const { page = 1, limit = 20, status, search } = options;

    const query = { shop: shopId };

    if (status === 'active') {
      query.isActive = true;
      query.$or = [
        { validUntil: { $exists: false } },
        { validUntil: null },
        { validUntil: { $gte: new Date() } },
      ];
    } else if (status === 'expired') {
      query.validUntil = { $lt: new Date() };
    } else if (status === 'inactive') {
      query.isActive = false;
    }

    if (search) {
      query.code = { $regex: search, $options: 'i' };
    }

    const skip = (page - 1) * limit;

    const [coupons, total] = await Promise.all([
      Coupon.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean({ virtuals: true }),
      Coupon.countDocuments(query),
    ]);

    return {
      data: coupons,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get single coupon
  async getCouponById(shopId, couponId) {
    const coupon = await Coupon.findOne({ _id: couponId, shop: shopId }).lean({ virtuals: true });
    if (!coupon) {
      throw new AppError('কুপন পাওয়া যায়নি', 'Coupon not found', 404);
    }
    return coupon;
  }

  // Update coupon
  async updateCoupon(shopId, userId, couponId, updateData) {
    const coupon = await Coupon.findOne({ _id: couponId, shop: shopId });
    if (!coupon) {
      throw new AppError('কুপন পাওয়া যায়নি', 'Coupon not found', 404);
    }

    const allowedFields = [
      'description', 'descriptionBn', 'discountType', 'discountValue',
      'minPurchase', 'maxDiscount', 'validFrom', 'validUntil',
      'usageLimit', 'isActive',
    ];

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        coupon[field] = updateData[field];
      }
    }

    await coupon.save();
    return coupon;
  }

  // Delete (deactivate) coupon
  async deleteCoupon(shopId, userId, couponId) {
    const coupon = await Coupon.findOne({ _id: couponId, shop: shopId });
    if (!coupon) {
      throw new AppError('কুপন পাওয়া যায়নি', 'Coupon not found', 404);
    }

    coupon.isActive = false;
    await coupon.save();

    return { success: true };
  }

  // Validate coupon for a sale
  async validateCoupon(shopId, code, cartTotal) {
    const coupon = await Coupon.findOne({
      shop: shopId,
      code: code.toUpperCase().trim(),
    });

    if (!coupon) {
      throw new AppError('কুপন কোড সঠিক নয়', 'Invalid coupon code', 404);
    }

    if (!coupon.isActive) {
      throw new AppError('এই কুপন নিষ্ক্রিয়', 'This coupon is inactive', 400);
    }

    if (coupon.validUntil && new Date() > coupon.validUntil) {
      throw new AppError('এই কুপনের মেয়াদ শেষ হয়ে গেছে', 'This coupon has expired', 400);
    }

    if (coupon.validFrom && new Date() < coupon.validFrom) {
      throw new AppError('এই কুপন এখনো কার্যকর হয়নি', 'This coupon is not active yet', 400);
    }

    if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
      throw new AppError('এই কুপনের ব্যবহার সীমা শেষ', 'Usage limit reached', 400);
    }

    if (cartTotal < coupon.minPurchase) {
      throw new AppError(
        `সর্বনিম্ন ৳${coupon.minPurchase} ক্রয় করতে হবে`,
        `Minimum purchase of ৳${coupon.minPurchase} required`,
        400
      );
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
      discountAmount = (cartTotal * coupon.discountValue) / 100;
      if (coupon.maxDiscount > 0 && discountAmount > coupon.maxDiscount) {
        discountAmount = coupon.maxDiscount;
      }
    } else {
      discountAmount = coupon.discountValue;
    }

    // Discount cannot exceed cart total
    discountAmount = Math.min(discountAmount, cartTotal);

    return {
      valid: true,
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        description: coupon.description,
        descriptionBn: coupon.descriptionBn,
      },
      discountAmount: Math.round(discountAmount),
    };
  }

  // Redeem coupon (called after sale is created)
  async redeemCoupon(shopId, couponId, redemptionData) {
    const { customerId, customerName, saleId, invoiceNo, amount } = redemptionData;

    const coupon = await Coupon.findOne({ _id: couponId, shop: shopId });
    if (!coupon) return; // silently fail if coupon not found

    coupon.redemptions.push({
      customer: customerId,
      customerName,
      sale: saleId,
      invoiceNo,
      amount,
    });
    coupon.usageCount += 1;
    await coupon.save();
  }
}

module.exports = new CouponService();

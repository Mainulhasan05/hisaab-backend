const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

class ProductService {
  // Get all products with filtering, searching, pagination
  async getProducts(shopId, options = {}) {
    const {
      page,
      limit,
      search,
      category,
      status,
      lowStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    // Ensure valid integers with proper defaults (handles 'null', undefined, NaN)
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;

    const query = { shop: shopId };

    // Search by name or code
    const searchOr = search ? [
      { name: { $regex: search, $options: 'i' } },
      { code: { $regex: search, $options: 'i' } },
      { 'variants.sku': { $regex: search, $options: 'i' } },
      { 'variants.barcode': { $regex: search, $options: 'i' } },
    ] : null;

    // Filter by category
    if (category) {
      query.category = category;
    }

    // Filter by status
    if (status === 'active') {
      query.isActive = true;
    } else if (status === 'inactive') {
      query.isActive = false;
    }

    // Filter low stock items (works for both non-variant and variant products)
    const lowStockOr = (lowStock === 'true' || lowStock === true) ? [
      { hasVariants: { $ne: true }, $expr: { $lt: ['$stock', '$minStock'] } },
      { hasVariants: true, 'variants.stock': { $lt: 5 } },
    ] : null;

    // Combine search and lowStock filters — use $and when both are active to avoid $or overwrite
    if (searchOr && lowStockOr) {
      query.$and = [{ $or: searchOr }, { $or: lowStockOr }];
    } else if (searchOr) {
      query.$or = searchOr;
    } else if (lowStockOr) {
      query.$or = lowStockOr;
    }

    const skip = (pageNum - 1) * limitNum;
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate('category', 'name nameBn')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(query),
    ]);

    return {
      data: products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };
  }

  // Get single product by ID
  async getProductById(shopId, productId) {
    const product = await Product.findOne({ _id: productId, shop: shopId })
      .populate('category', 'name nameBn')
      .populate('createdBy', 'name phone');

    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    return product;
  }

  // Get product by barcode/code
  async getProductByCode(shopId, code) {
    const product = await Product.findOne({
      shop: shopId,
      $or: [
        { code: code },
        { 'variants.sku': code },
        { 'variants.barcode': code },
      ],
    }).populate('category', 'name nameBn');

    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    return product;
  }

  // Create new product
  async createProduct(shopId, userId, productData) {
    const { code, name, category, variants, ...rest } = productData;

    // Check if code already exists
    const existingProduct = await Product.findOne({ shop: shopId, code });
    if (existingProduct) {
      throw new AppError('এই কোড দিয়ে ইতিমধ্যে পণ্য আছে', 'Product with this code already exists', 400);
    }

    // Validate category if provided
    if (category) {
      const categoryExists = await Category.findOne({ _id: category, $or: [{ shop: shopId }, { shop: null }] });
      if (!categoryExists) {
        throw new AppError('ক্যাটাগরি পাওয়া যায়নি', 'Category not found', 404);
      }
    }

    const product = await Product.create({
      shop: shopId,
      code,
      name,
      category,
      variants: variants || [],
      hasVariants: variants && variants.length > 0,
      createdBy: userId,
      ...rest,
    });

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_create',
      actionBn: 'নতুন পণ্য যোগ',
      description: `Created product: ${name}`,
      descriptionBn: `নতুন পণ্য যোগ করা হয়েছে: ${name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: name,
      },
      changes: {
        after: product.toObject(),
      },
    });

    return product;
  }

  // Update product
  async updateProduct(shopId, userId, productId, updateData) {
    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const beforeData = product.toObject();

    // Separate stock from other update data so we can handle it via updateStock
    const { stock, variants: variantsWithStock, ...safeUpdateData } = updateData;

    // If variants are being updated, preserve existing stock for each variant
    if (variantsWithStock && Array.isArray(variantsWithStock)) {
      safeUpdateData.variants = variantsWithStock.map(variant => {
        const { stock: variantStock, ...safeVariant } = variant;
        // Preserve existing stock for this variant if it exists
        const existingVariant = product.variants?.find(v =>
          v._id?.toString() === variant._id?.toString() || v.sku === variant.sku
        );
        return {
          ...safeVariant,
          stock: existingVariant?.stock ?? 0, // Keep existing stock or default to 0 for new variants
        };
      });
    }

    // Check if code is being changed and if it conflicts
    if (safeUpdateData.code && safeUpdateData.code !== product.code) {
      const existingProduct = await Product.findOne({ shop: shopId, code: safeUpdateData.code, _id: { $ne: productId } });
      if (existingProduct) {
        throw new AppError('এই কোড দিয়ে ইতিমধ্যে পণ্য আছে', 'Product with this code already exists', 400);
      }
    }

    // Update product with safe data (stock handled separately below)
    Object.assign(product, safeUpdateData);
    if (safeUpdateData.variants) {
      product.hasVariants = safeUpdateData.variants.length > 0;
    }
    await product.save();

    // Create audit log for general product update
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_update',
      actionBn: 'পণ্য আপডেট',
      description: `Updated product: ${product.name}`,
      descriptionBn: `পণ্য আপডেট করা হয়েছে: ${product.name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: beforeData,
        after: product.toObject(),
      },
    });

    // If stock was provided and this is a non-variant product, update stock through
    // the proper channel so it's tracked in StockTransaction
    if (stock !== undefined && stock !== null && !product.hasVariants) {
      return await this.updateStock(shopId, userId, productId, {
        quantity: parseInt(stock) || 0,
        type: 'set',
        notes: 'পণ্য সম্পাদনা থেকে স্টক আপডেট',
      });
    }

    return product;
  }

  // Delete product (soft delete)
  async deleteProduct(shopId, userId, productId) {
    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    product.isActive = false;
    await product.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'product_delete',
      actionBn: 'পণ্য মুছে ফেলা',
      description: `Deleted product: ${product.name}`,
      descriptionBn: `পণ্য মুছে ফেলা হয়েছে: ${product.name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
    });

    return { success: true };
  }

  // Toggle product active status
  async toggleProductStatus(shopId, userId, productId, isActive) {
    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const previousStatus = product.isActive;
    product.isActive = isActive;
    await product.save();

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: isActive ? 'product_activate' : 'product_deactivate',
      actionBn: isActive ? 'পণ্য সক্রিয় করা' : 'পণ্য নিষ্ক্রিয় করা',
      description: `${isActive ? 'Activated' : 'Deactivated'} product: ${product.name}`,
      descriptionBn: `পণ্য ${isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে: ${product.name}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { isActive: previousStatus },
        after: { isActive },
      },
    });

    return product;
  }

  // Update stock
  async updateStock(shopId, userId, productId, stockData) {
    const { quantity, type, variantId, notes } = stockData;

    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    let previousStock, newStock;

    if (variantId) {
      // Update variant stock
      const variant = product.variants.id(variantId);
      if (!variant) {
        throw new AppError('ভেরিয়েন্ট পাওয়া যায়নি', 'Variant not found', 404);
      }
      previousStock = variant.stock;
      if (type === 'set') {
        variant.stock = quantity;
      } else if (type === 'subtract') {
        variant.stock = variant.stock - quantity;
      } else {
        variant.stock = variant.stock + quantity;
      }
      newStock = variant.stock;
    } else {
      // Update main product stock
      previousStock = product.stock;
      if (type === 'set') {
        product.stock = quantity;
      } else if (type === 'subtract') {
        product.stock = product.stock - quantity;
      } else {
        product.stock = product.stock + quantity;
      }
      newStock = product.stock;
    }

    await product.save();

    // Create stock transaction
    await StockTransaction.create({
      shop: shopId,
      product: productId,
      productName: product.name,
      productCode: product.code,
      variantId: variantId || null,
      type: type === 'set' ? 'adjustment' : (quantity > 0 ? 'purchase' : 'adjustment'),
      quantity: type === 'set' ? newStock - previousStock : quantity,
      previousStock,
      newStock,
      reference: {
        type: 'manual',
      },
      notes,
      createdBy: userId,
    });

    // Create audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'stock_update',
      actionBn: 'স্টক আপডেট',
      description: `Updated stock for ${product.name}: ${previousStock} → ${newStock}`,
      descriptionBn: `${product.name} এর স্টক আপডেট: ${previousStock} → ${newStock}`,
      entity: {
        type: 'product',
        id: product._id,
        name: product.name,
      },
      changes: {
        before: { stock: previousStock },
        after: { stock: newStock },
      },
    });

    return product;
  }

  // Get low stock products
  async getLowStockProducts(shopId, limit = 10) {
    const products = await Product.find({
      shop: shopId,
      isActive: true,
      $expr: { $lt: ['$stock', '$minStock'] },
    })
      .sort({ stock: 1 })
      .limit(limit)
      .lean();

    return products;
  }

  // Get stock transactions
  async getStockTransactions(shopId, productId, options = {}) {
    const { page = 1, limit = 20 } = options;

    const query = { shop: shopId };
    if (productId) {
      query.product = productId;
    }

    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      StockTransaction.find(query)
        .populate('product', 'name code')
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockTransaction.countDocuments(query),
    ]);

    return {
      data: transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Bulk update products
  async bulkUpdateStock(shopId, userId, updates) {
    const results = [];

    for (const update of updates) {
      try {
        const result = await this.updateStock(shopId, userId, update.productId, {
          quantity: update.quantity,
          type: update.type || 'add',
          variantId: update.variantId,
          notes: update.notes,
        });
        results.push({ productId: update.productId, success: true });
      } catch (error) {
        results.push({ productId: update.productId, success: false, error: error.message });
      }
    }

    return results;
  }
}

module.exports = new ProductService();

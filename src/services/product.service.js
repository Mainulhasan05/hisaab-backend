const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

class ProductService {
  // Get all products with filtering, searching, pagination
  async getProducts(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      category,
      status,
      lowStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    // Search by name or code
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'variants.sku': { $regex: search, $options: 'i' } },
        { 'variants.barcode': { $regex: search, $options: 'i' } },
      ];
    }

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

    // Filter low stock items
    if (lowStock === 'true' || lowStock === true) {
      query.$expr = {
        $lt: ['$stock', '$minStock'],
      };
    }

    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate('category', 'name nameBn')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(query),
    ]);

    return {
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
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

    // SECURITY: Prevent direct stock manipulation - must use updateStock endpoint
    // This ensures all stock changes are tracked in StockTransaction
    const { stock, ...safeUpdateData } = updateData;
    if (stock !== undefined) {
      console.warn(`[SECURITY] Blocked direct stock update attempt for product ${productId} by user ${userId}`);
    }

    // If variants are being updated, strip out stock from each variant
    if (safeUpdateData.variants && Array.isArray(safeUpdateData.variants)) {
      safeUpdateData.variants = safeUpdateData.variants.map(variant => {
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

    // Update product with safe data (stock fields excluded)
    Object.assign(product, safeUpdateData);
    if (safeUpdateData.variants) {
      product.hasVariants = safeUpdateData.variants.length > 0;
    }
    await product.save();

    // Create audit log
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

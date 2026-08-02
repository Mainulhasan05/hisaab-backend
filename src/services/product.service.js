const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const BranchStock = require('../models/BranchStock.model');
const { AppError } = require('../middleware/error.middleware');
const mongoose = require('mongoose');
const { getBranchForCreate } = require('../utils/branchScope.util');
const logger = require('../utils/logger.util');
const cacheService = require('./cache.service');

// Escape user input before embedding it in a $regex (prevents regex injection/ReDoS)
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Client-controllable sort fields must be whitelisted — arbitrary fields force
// unindexed in-memory sorts that hard-fail at 32MB on large collections
const PRODUCT_SORT_FIELDS = new Set(['createdAt', 'name', 'code', 'stock', 'sellingPrice', 'buyingPrice', 'updatedAt']);

class ProductService {
  // Get all products with filtering, searching, pagination
  async getProducts(shopId, options = {}, req = null) {
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

    // Search by name or code. Input is regex-escaped; each field carries a
    // {shop, field} compound index so the $or branches run as shop-bounded
    // index scans instead of full document scans.
    const searchRegex = search ? escapeRegex(search.trim()) : null;
    const searchOr = searchRegex ? [
      { name: { $regex: searchRegex, $options: 'i' } },
      { code: { $regex: searchRegex, $options: 'i' } },
      { 'variants.sku': { $regex: searchRegex, $options: 'i' } },
      { 'variants.barcode': { $regex: searchRegex, $options: 'i' } },
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

    // Filter by online availability
    if (options.isAvailableOnline === 'true' || options.isAvailableOnline === true) {
      query.isAvailableOnline = true;
    } else if (options.isAvailableOnline === 'false' || options.isAvailableOnline === false) {
      query.isAvailableOnline = false;
    }


    // Filter low stock items (works for both non-variant and variant products)
    let lowStockOr = null;
    const branchId = req?.branchId;
    if (lowStock === 'true' || lowStock === true) {
      if (branchId && req?.shop?.multiBranchEnabled) {
        const lowStockBranchRecords = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              branch: new mongoose.Types.ObjectId(branchId)
            }
          },
          {
            $lookup: {
              from: 'products',
              localField: 'product',
              foreignField: '_id',
              as: 'productDetails'
            }
          },
          { $unwind: '$productDetails' },
          {
            $match: {
              $or: [
                { variantId: null, $expr: { $lt: ['$stock', '$productDetails.minStock'] } },
                { variantId: { $ne: null }, stock: { $lt: 5 } }
              ]
            }
          },
          { $project: { product: 1 } }
        ]);

        const lowStockProductIds = lowStockBranchRecords.map(r => r.product);
        query._id = { $in: lowStockProductIds };
      } else {
        lowStockOr = [
          { hasVariants: { $ne: true }, $expr: { $lt: ['$stock', '$minStock'] } },
          { hasVariants: true, 'variants.stock': { $lt: 5 } },
        ];
      }
    }

    // Combine search and lowStock filters — use $and when both are active to avoid $or overwrite
    if (searchOr && lowStockOr) {
      query.$and = [{ $or: searchOr }, { $or: lowStockOr }];
    } else if (searchOr) {
      query.$or = searchOr;
    } else if (lowStockOr) {
      query.$or = lowStockOr;
    }

    const skip = (pageNum - 1) * limitNum;
    const sortField = PRODUCT_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    // Calculate total stock and stock values.
    // These are shop-wide (independent of search/pagination), so: skip entirely
    // for search requests (fired per keystroke from the POS picker) and cache
    // for 60s otherwise — previously this aggregate ran on every request.
    let inventoryStats = { totalStock: 0, totalBuyingValue: 0, totalSellingValue: 0 };
    const wantStats = !search;
    const statsCacheKey = `shop:${shopId}:invstats:${(branchId && req?.shop?.multiBranchEnabled) ? branchId : 'all'}`;
    let statsCached = null;
    if (wantStats) {
      statsCached = await cacheService.get(statsCacheKey);
      if (statsCached) inventoryStats = statsCached;
    }
    try {
      if (!wantStats || statsCached) {
        // skip aggregation
      } else if (branchId && req?.shop?.multiBranchEnabled) {
        const statsResult = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              branch: new mongoose.Types.ObjectId(branchId),
            }
          },
          {
            $lookup: {
              from: 'products',
              localField: 'product',
              foreignField: '_id',
              as: 'productDetails'
            }
          },
          { $unwind: '$productDetails' },
          {
            $match: { 'productDetails.isActive': true }
          },
          {
            $group: {
              _id: null,
              totalStock: { $sum: '$stock' },
              totalBuyingValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$productDetails.buyingPrice', 0] }] } },
              totalSellingValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$productDetails.sellingPrice', 0] }] } }
            }
          }
        ]);
        if (statsResult.length > 0) {
          inventoryStats = {
            totalStock: statsResult[0].totalStock || 0,
            totalBuyingValue: statsResult[0].totalBuyingValue || 0,
            totalSellingValue: statsResult[0].totalSellingValue || 0,
          };
        }
      } else {
        const statsResult = await Product.aggregate([
          { $match: { shop: new mongoose.Types.ObjectId(shopId), isActive: true } },
          {
            $group: {
              _id: null,
              totalStock: { $sum: '$stock' },
              totalBuyingValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$buyingPrice', 0] }] } },
              totalSellingValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$sellingPrice', 0] }] } }
            }
          }
        ]);
        if (statsResult.length > 0) {
          inventoryStats = {
            totalStock: statsResult[0].totalStock || 0,
            totalBuyingValue: statsResult[0].totalBuyingValue || 0,
            totalSellingValue: statsResult[0].totalSellingValue || 0,
          };
        }
      }
      if (wantStats && !statsCached) {
        cacheService.set(statsCacheKey, inventoryStats, 60).catch(() => {});
      }
    } catch (err) {
      logger.warn('Failed to calculate inventory stats:', err.message);
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .populate('category', 'name')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Product.countDocuments(query),
    ]);

    // Integrate BranchStock if in multi-branch mode
    if (req?.shop?.multiBranchEnabled) {
      const productIds = products.map(p => p._id);
      const stockMap = {};

      if (branchId) {
        // Specific branch selected
        const branchStocks = await BranchStock.find({
          shop: shopId,
          branch: branchId,
          product: { $in: productIds }
        }).lean();

        branchStocks.forEach(bs => {
          const key = bs.variantId ? `${bs.product}_${bs.variantId}` : `${bs.product}`;
          stockMap[key] = bs.stock;
        });
      } else {
        // "All Branches" view: aggregate stock across all branches
        const branchStocks = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              product: { $in: productIds.map(id => new mongoose.Types.ObjectId(id)) }
            }
          },
          {
            $group: {
              _id: { product: '$product', variantId: '$variantId' },
              totalStock: { $sum: '$stock' }
            }
          }
        ]);

        branchStocks.forEach(bs => {
          const key = bs._id.variantId ? `${bs._id.product}_${bs._id.variantId}` : `${bs._id.product}`;
          stockMap[key] = bs.totalStock;
        });
      }

      products.forEach(p => {
        if (p.hasVariants && p.variants) {
          p.variants.forEach(v => {
            v.stock = stockMap[`${p._id}_${v._id}`] ?? v.stock ?? 0;
          });
          p.stock = p.variants.reduce((sum, v) => sum + v.stock, 0);
        } else {
          p.stock = stockMap[`${p._id}`] ?? p.stock ?? 0;
        }
      });
    }

    return {
      data: products.map(p => this._transformProduct(p)),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      inventoryStats,
    };
  }

  // Search products for POS/sale item picker.
  async searchProductsForSale(shopId, options = {}, req = null) {
    const result = await this.getProducts(shopId, {
      ...options,
      status: 'active',
      page: options.page || 1,
      limit: options.limit || 30,
    }, req);

    return {
      data: result.data.map((product) => ({
        _id: product._id,
        name: product.name,
        code: product.code,
        barcode: product.barcode,
        hasVariants: product.hasVariants,
        buyingPrice: product.buyingPrice,
        sellingPrice: product.sellingPrice,
        stock: product.stock,
        minStock: product.minStock,
        unit: product.unit,
        category: product.category,
        variants: (product.variants || [])
          .filter((variant) => variant.isActive !== false)
          .map((variant) => ({
            _id: variant._id,
            sku: variant.sku,
            barcode: variant.barcode,
            attributes: variant.attributes,
            size: variant.size,
            color: variant.color,
            buyingPrice: variant.buyingPrice,
            sellingPrice: variant.sellingPrice,
            stock: variant.stock,
            isActive: variant.isActive,
          })),
      })),
      pagination: result.pagination,
    };
  }

  // Get single product by ID
  async getProductById(shopId, productId, req = null) {
    const product = await Product.findOne({ _id: productId, shop: shopId })
      .populate('category', 'name')
      .populate('createdBy', 'name phone');

    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const branchId = req?.branchId;
    if (req?.shop?.multiBranchEnabled) {
      const stockMap = {};

      if (branchId) {
        const branchStocks = await BranchStock.find({
          shop: shopId,
          branch: branchId,
          product: productId
        }).lean();

        branchStocks.forEach(bs => {
          const key = bs.variantId ? bs.variantId.toString() : 'base';
          stockMap[key] = bs.stock;
        });
      } else {
        // "All Branches" view: aggregate stock across all branches
        const branchStocks = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              product: new mongoose.Types.ObjectId(productId)
            }
          },
          {
            $group: {
              _id: '$variantId',
              totalStock: { $sum: '$stock' }
            }
          }
        ]);

        branchStocks.forEach(bs => {
          const key = bs._id ? bs._id.toString() : 'base';
          stockMap[key] = bs.totalStock;
        });
      }

      if (product.hasVariants && product.variants) {
        product.variants.forEach(v => {
          v.stock = stockMap[v._id.toString()] ?? v.stock ?? 0;
        });
        product.stock = product.variants.reduce((sum, v) => sum + v.stock, 0);
      } else {
        product.stock = stockMap['base'] ?? product.stock ?? 0;
      }
    }

    return this._transformProduct(product);
  }

  // Get product by barcode/code
  async getProductByCode(shopId, code, req = null) {
    const product = await Product.findOne({
      shop: shopId,
      $or: [
        { code: code },
        { 'variants.sku': code },
        { 'variants.barcode': code },
      ],
    }).populate('category', 'name');

    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const branchId = req?.branchId;
    if (req?.shop?.multiBranchEnabled) {
      const stockMap = {};

      if (branchId) {
        const branchStocks = await BranchStock.find({
          shop: shopId,
          branch: branchId,
          product: product._id
        }).lean();

        branchStocks.forEach(bs => {
          const key = bs.variantId ? bs.variantId.toString() : 'base';
          stockMap[key] = bs.stock;
        });
      } else {
        // "All Branches" view: aggregate stock across all branches
        const branchStocks = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              product: new mongoose.Types.ObjectId(product._id)
            }
          },
          {
            $group: {
              _id: '$variantId',
              totalStock: { $sum: '$stock' }
            }
          }
        ]);

        branchStocks.forEach(bs => {
          const key = bs._id ? bs._id.toString() : 'base';
          stockMap[key] = bs.totalStock;
        });
      }

      if (product.hasVariants && product.variants) {
        product.variants.forEach(v => {
          v.stock = stockMap[v._id.toString()] ?? v.stock ?? 0;
        });
        product.stock = product.variants.reduce((sum, v) => sum + v.stock, 0);
      } else {
        product.stock = stockMap['base'] ?? product.stock ?? 0;
      }
    }

    return this._transformProduct(product);
  }

  // Create new product
  async createProduct(shopId, userId, productData, req = null) {
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

    const formattedVariants = this._formatVariants(variants);
    const product = await Product.create({
      shop: shopId,
      code,
      name,
      category,
      variants: formattedVariants,
      hasVariants: formattedVariants.length > 0,
      createdBy: userId,
      ...rest,
    });

    // If multi-branch is enabled, initialize BranchStock for the selected branch.
    if (req?.shop?.multiBranchEnabled) {
      const targetBranchId = getBranchForCreate(req);
      const branchStockDocs = [];

      if (product.hasVariants && product.variants) {
        for (const variant of product.variants) {
          branchStockDocs.push({
            shop: shopId,
            branch: targetBranchId,
            product: product._id,
            variantId: variant._id,
            stock: variant.stock || 0,
          });
        }
      } else {
        branchStockDocs.push({
          shop: shopId,
          branch: targetBranchId,
          product: product._id,
          variantId: null,
          stock: product.stock || 0,
        });
      }

      if (branchStockDocs.length > 0) {
        await BranchStock.insertMany(branchStockDocs);
      }
    }

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

    return this._transformProduct(product);
  }

  // Update product
  async updateProduct(shopId, userId, productId, updateData, req = null) {
    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    const beforeData = product.toObject();

    // Separate stock from other update data so we can handle it via updateStock
    const { stock, variants: variantsWithStock, ...safeUpdateData } = updateData;

    // Resolve target branch for updates
    const targetBranchId = req?.shop?.multiBranchEnabled ? getBranchForCreate(req) : null;

    // Process variant updates and handle variant stock changes
    if (variantsWithStock && Array.isArray(variantsWithStock)) {
      const formattedInputVariants = this._formatVariants(variantsWithStock);
      const updatedVariants = [];

      for (const variant of formattedInputVariants) {
        const existingVariant = product.variants?.find(v =>
          v._id?.toString() === variant._id?.toString() || v.sku === variant.sku
        );

        let inputStock = variant.stock ?? 0;
        let currentStock = 0;
        let variantId = variant._id;

        if (existingVariant) {
          // Keep existing variant's ID
          variantId = existingVariant._id;
          variant._id = existingVariant._id;
          
          if (req?.shop?.multiBranchEnabled && targetBranchId) {
            const bs = await BranchStock.findOne({
              shop: shopId,
              branch: targetBranchId,
              product: product._id,
              variantId: existingVariant._id
            });
            currentStock = bs ? bs.stock : 0;
          } else {
            currentStock = existingVariant.stock || 0;
          }
        }

        // If the stock is different, we must update it
        if (inputStock !== currentStock) {
          if (req?.shop?.multiBranchEnabled && targetBranchId) {
            // Update or create BranchStock record
            await BranchStock.findOneAndUpdate(
              { shop: shopId, branch: targetBranchId, product: product._id, variantId: variantId },
              { $set: { stock: inputStock } },
              { upsert: true }
            );
          } else {
            // In single-branch mode, the stock is stored directly on the variant object
            variant.stock = inputStock;
          }

          // Create stock transaction for this variant stock adjustment
          await StockTransaction.create({
            shop: shopId,
            branch: req?.shop?.multiBranchEnabled ? targetBranchId : null,
            product: product._id,
            productName: product.name,
            productCode: product.code,
            variantId: variantId,
            type: 'adjustment',
            quantity: inputStock - currentStock,
            previousStock: currentStock,
            newStock: inputStock,
            reference: { type: 'manual' },
            notes: 'পণ্য সম্পাদনা থেকে ভ্যারিয়েন্ট স্টক আপডেট',
            createdBy: userId,
          });
        }

        updatedVariants.push({
          ...variant,
          stock: req?.shop?.multiBranchEnabled ? currentStock : inputStock // Will be populated from BranchStock anyway, but preserve for single-branch
        });
      }

      safeUpdateData.variants = updatedVariants;
    }

    // Check if code is being changed and if it conflicts
    if (safeUpdateData.code && safeUpdateData.code !== product.code) {
      const existingProduct = await Product.findOne({ shop: shopId, code: safeUpdateData.code, _id: { $ne: productId } });
      if (existingProduct) {
        throw new AppError('এই কোড দিয়ে ইতিমধ্যে পণ্য আছে', 'Product with this code already exists', 400);
      }
    }

    // Update product with safe data
    Object.assign(product, safeUpdateData);
    if (safeUpdateData.variants) {
      product.hasVariants = safeUpdateData.variants.length > 0;
    }
    await product.save();

    // If multi-branch is enabled, make sure all variants have BranchStock records
    if (req?.shop?.multiBranchEnabled) {
      const stockOps = [];
      if (product.hasVariants && product.variants) {
        for (const variant of product.variants) {
          stockOps.push({
            updateOne: {
              filter: { shop: shopId, branch: targetBranchId, product: product._id, variantId: variant._id },
              update: { $setOnInsert: { stock: variant.stock || 0 } },
              upsert: true,
            },
          });
        }
      } else {
        stockOps.push({
          updateOne: {
            filter: { shop: shopId, branch: targetBranchId, product: product._id, variantId: null },
            update: { $setOnInsert: { stock: product.stock || 0 } },
            upsert: true,
          },
        });
      }

      if (stockOps.length > 0) {
        await BranchStock.bulkWrite(stockOps);
      }
    }

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
      const updatedProduct = await this.updateStock(shopId, userId, productId, {
        quantity: parseInt(stock) || 0,
        type: 'set',
        notes: 'পণ্য সম্পাদনা থেকে স্টক আপডেট',
      }, req);
      return this._transformProduct(updatedProduct);
    }

    // Integrate and aggregate BranchStock for the returned product
    if (req?.shop?.multiBranchEnabled) {
      const stockMap = {};
      const branchId = req?.branchId;

      if (branchId) {
        const branchStocks = await BranchStock.find({
          shop: shopId,
          branch: branchId,
          product: product._id
        }).lean();

        branchStocks.forEach(bs => {
          const key = bs.variantId ? bs.variantId.toString() : 'base';
          stockMap[key] = bs.stock;
        });
      } else {
        const branchStocks = await BranchStock.aggregate([
          {
            $match: {
              shop: new mongoose.Types.ObjectId(shopId),
              product: new mongoose.Types.ObjectId(product._id)
            }
          },
          {
            $group: {
              _id: '$variantId',
              totalStock: { $sum: '$stock' }
            }
          }
        ]);

        branchStocks.forEach(bs => {
          const key = bs._id ? bs._id.toString() : 'base';
          stockMap[key] = bs.totalStock;
        });
      }

      if (product.hasVariants && product.variants) {
        product.variants.forEach(v => {
          v.stock = stockMap[v._id.toString()] ?? v.stock ?? 0;
        });
        product.stock = product.variants.reduce((sum, v) => sum + v.stock, 0);
      } else {
        product.stock = stockMap['base'] ?? product.stock ?? 0;
      }
    }

    return this._transformProduct(product);
  }

  // Delete product (soft delete)
  async deleteProduct(shopId, userId, productId, req = null) {
    if (req?.shop?.multiBranchEnabled) {
      getBranchForCreate(req);
    }

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
  async updateStock(shopId, userId, productId, stockData, req = null) {
    const { quantity, type, variantId, notes } = stockData;

    const product = await Product.findOne({ _id: productId, shop: shopId });
    if (!product) {
      throw new AppError('পণ্যটি পাওয়া যায়নি', 'Product not found', 404);
    }

    let previousStock, newStock;
    const branchId = req ? getBranchForCreate(req) : null;

    if (branchId && req?.shop?.multiBranchEnabled) {
      const bsRecord = await BranchStock.getOrCreate(shopId, branchId, productId, variantId || null);
      previousStock = bsRecord.stock;
      if (type === 'set') {
        bsRecord.stock = quantity;
      } else if (type === 'subtract') {
        bsRecord.stock = Math.max(0, bsRecord.stock - quantity);
      } else {
        bsRecord.stock = bsRecord.stock + quantity;
      }
      newStock = bsRecord.stock;
      await bsRecord.save();

      const totalStock = await BranchStock.getTotalStock(shopId, productId, variantId || null);
      if (variantId) {
        const variant = product.variants.id(variantId);
        if (variant) {
          variant.stock = totalStock;
        }
      } else {
        product.stock = totalStock;
      }
      await product.save();
    } else {
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
    }

    // Create stock transaction
    await StockTransaction.create({
      shop: shopId,
      branch: branchId,
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
      description: `Updated stock for ${product.name}: ${previousStock} → ${newStock}${branchId ? ` (Branch: ${branchId})` : ''}`,
      descriptionBn: `${product.name} এর স্টক আপডেট: ${previousStock} → ${newStock}${branchId ? ` (শাখা: ${branchId})` : ''}`,
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

    if (branchId && req?.shop?.multiBranchEnabled) {
      if (product.hasVariants && product.variants) {
        const allBranchStocks = await BranchStock.find({ shop: shopId, branch: branchId, product: productId }).lean();
        const stockMap = {};
        allBranchStocks.forEach(bs => { stockMap[bs.variantId ? bs.variantId.toString() : 'base'] = bs.stock; });
        product.variants.forEach(v => { v.stock = stockMap[v._id.toString()] ?? 0; });
        product.stock = product.variants.reduce((sum, v) => sum + v.stock, 0);
      } else {
        product.stock = newStock;
      }
    }

    return this._transformProduct(product);
  }

  // Get low stock products
  async getLowStockProducts(shopId, limit = 10, req = null) {
    const branchId = req?.branchId;
    if (branchId && req?.shop?.multiBranchEnabled) {
      const lowStockRecords = await BranchStock.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            branch: new mongoose.Types.ObjectId(branchId)
          }
        },
        {
          $lookup: {
            from: 'products',
            localField: 'product',
            foreignField: '_id',
            as: 'productDetails'
          }
        },
        { $unwind: '$productDetails' },
        {
          $match: {
            'productDetails.isActive': true,
            $expr: { $lt: ['$stock', '$productDetails.minStock'] }
          }
        },
        {
          $project: {
            _id: '$productDetails._id',
            name: '$productDetails.name',
            code: '$productDetails.code',
            stock: '$stock',
            minStock: '$productDetails.minStock',
            sellingPrice: '$productDetails.sellingPrice'
          }
        },
        { $sort: { stock: 1 } },
        { $limit: limit }
      ]);
      return lowStockRecords;
    }

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
  async getStockTransactions(shopId, productId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;

    const { scopeByBranch } = require('../utils/branchScope.util');
    const query = req ? scopeByBranch(req, { shop: shopId }) : { shop: shopId };
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
  async bulkUpdateStock(shopId, userId, updates, req = null) {
    const results = [];

    for (const update of updates) {
      try {
        const result = await this.updateStock(shopId, userId, update.productId, {
          quantity: update.quantity,
          type: update.type || 'add',
          variantId: update.variantId,
          notes: update.notes,
        }, req);
        results.push({ productId: update.productId, success: true });
      } catch (error) {
        results.push({ productId: update.productId, success: false, error: error.message });
      }
    }

    return results;
  }

  /**
   * Helper to format variant arrays from client flat structure to DB nested attributes structure.
   */
  _formatVariants(variants) {
    if (!variants || !Array.isArray(variants)) return [];

    return variants.map(v => {
      const attributes = {};
      const knownKeys = ['size', 'color', 'weight', 'material', 'style'];
      
      if (v.attributes) {
        Object.assign(attributes, v.attributes);
      }

      knownKeys.forEach(key => {
        if (v[key] !== undefined && v[key] !== null) {
          attributes[key] = v[key];
        }
      });

      const customKeys = Object.keys(v).filter(k => 
        !['id', '_id', 'sku', 'barcode', 'buyingPrice', 'sellingPrice', 'stock', 'image', 'isActive', 'attributes'].includes(k) &&
        !knownKeys.includes(k)
      );

      if (customKeys.length > 0) {
        if (!attributes.custom) attributes.custom = {};
        customKeys.forEach(k => {
          attributes.custom[k] = v[k];
        });
      }

      const idVal = v._id || v.id;
      const isValidId = idVal && mongoose.Types.ObjectId.isValid(idVal);
      const variantId = isValidId ? new mongoose.Types.ObjectId(idVal) : new mongoose.Types.ObjectId();

      return {
        _id: variantId,
        sku: v.sku,
        barcode: v.barcode,
        buyingPrice: v.buyingPrice,
        sellingPrice: v.sellingPrice,
        stock: v.stock || 0,
        image: v.image,
        isActive: v.isActive !== false,
        attributes
      };
    });
  }

  /**
   * Helper to transform product variants from DB nested attributes structure to client flat structure.
   */
  _transformProduct(product) {
    if (!product) return null;
    const p = typeof product.toObject === 'function' ? product.toObject() : product;

    if (p.hasVariants && p.variants && Array.isArray(p.variants)) {
      p.variants = p.variants.map(v => {
        const transformed = { ...v };
        if (v.attributes) {
          Object.entries(v.attributes).forEach(([key, val]) => {
            if (key === 'custom' && val && typeof val === 'object') {
              Object.entries(val).forEach(([ckey, cval]) => {
                transformed[ckey] = cval;
              });
            } else {
              transformed[key] = val;
            }
          });
        }
        return transformed;
      });
    }

    return p;
  }

  // Bulk import products from array (e.g. CSV/Excel upload)
  async bulkImportProducts(shopId, userId, productsArray, req = null) {
    const results = {
      total: productsArray.length,
      importedCount: 0,
      skippedCount: 0,
      errors: [],
      importedProducts: [],
    };

    // Pre-fetch categories for this shop or global
    const categories = await Category.find({ $or: [{ shop: shopId }, { shop: null }] });
    const categoryMap = new Map();
    categories.forEach(c => {
      if (c.name) categoryMap.set(c.name.toLowerCase().trim(), c._id);
    });

    // Fetch existing product codes & barcodes for this shop to prevent duplicates
    const existingProducts = await Product.find({ shop: shopId }, { code: 1, barcode: 1 });
    const existingCodes = new Set();
    existingProducts.forEach(p => {
      if (p.code) existingCodes.add(p.code.toUpperCase().trim());
      if (p.barcode) existingCodes.add(p.barcode.trim());
    });

    for (let i = 0; i < productsArray.length; i++) {
      const item = productsArray[i];
      const rowNumber = i + 1;

      try {
        const name = item.name ? String(item.name).trim() : '';
        if (!name) {
          results.skippedCount++;
          results.errors.push({ row: rowNumber, reason: 'পণ্য নাম (Name) আবশ্যক' });
          continue;
        }

        let code = item.code ? String(item.code).trim().toUpperCase() : '';
        const barcode = item.barcode ? String(item.barcode).trim() : (item.code ? String(item.code).trim() : '');

        if (code && existingCodes.has(code)) {
          results.skippedCount++;
          results.errors.push({ row: rowNumber, code, name, reason: 'কোড ইতিমধ্যে বিদ্যমান' });
          continue;
        }

        if (!code) {
          code = `PRD-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
        }

        let categoryId = null;
        if (item.categoryName && String(item.categoryName).trim()) {
          const catNameClean = String(item.categoryName).trim();
          const catLower = catNameClean.toLowerCase();
          if (categoryMap.has(catLower)) {
            categoryId = categoryMap.get(catLower);
          } else {
            const newCat = await Category.create({
              shop: shopId,
              name: catNameClean,
              slug: catNameClean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || `cat-${Date.now()}`,
              createdBy: userId,
            });
            categoryId = newCat._id;
            categoryMap.set(catLower, newCat._id);
          }
        }

        const buyingPrice = Number(item.buyingPrice ?? item.costPrice ?? 0);
        const sellingPrice = Number(item.sellingPrice ?? 0);
        const stock = Number(item.stock ?? 0);
        const minStock = Number(item.minStock ?? 5);
        const unit = item.unit ? String(item.unit).trim() : 'piece';
        const trackBatches = Boolean(item.trackBatches);

        const batches = [];
        if (trackBatches && item.batchNumber && stock > 0) {
          batches.push({
            batchNumber: String(item.batchNumber).trim(),
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
            quantity: stock,
            costPrice: buyingPrice,
          });
        }

        const product = await Product.create({
          shop: shopId,
          code,
          barcode,
          name,
          category: categoryId,
          buyingPrice,
          sellingPrice,
          stock,
          minStock,
          unit,
          description: item.description || '',
          trackBatches,
          batches,
          createdBy: userId,
        });

        if (req?.shop?.multiBranchEnabled) {
          const targetBranchId = getBranchForCreate(req);
          if (targetBranchId) {
            await BranchStock.create({
              shop: shopId,
              branch: targetBranchId,
              product: product._id,
              stock,
            });
          }
        }

        existingCodes.add(code);
        if (barcode) existingCodes.add(barcode);

        results.importedCount++;
        results.importedProducts.push({ _id: product._id, name: product.name, code: product.code });
      } catch (err) {
        results.skippedCount++;
        results.errors.push({ row: rowNumber, name: item.name, reason: err.message });
      }
    }

    if (results.importedCount > 0) {
      await AuditLog.log({
        shop: shopId,
        user: userId,
        action: 'product_bulk_import',
        description: `Bulk imported ${results.importedCount} products (${results.skippedCount} skipped)`,
        entity: { type: 'product', id: null, name: 'Bulk Product Import' },
        req,
      });
    }

    return results;
  }
}

module.exports = new ProductService();

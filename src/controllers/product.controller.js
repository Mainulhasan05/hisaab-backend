const productService = require('../services/product.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizeProducts, sanitizeReport, sanitizeBatches } = require('../utils/dataSanitizer.util');

// Get all products
exports.getProducts = asyncHandler(async (req, res) => {
  const result = await productService.getProducts(req.shop._id, req.query, req);
  result.data = sanitizeProducts(result.data, req);
  // inventoryStats (total buying value) sits outside `data` — sanitize it too
  if (result.inventoryStats) {
    result.inventoryStats = sanitizeReport(result.inventoryStats, req);
  }
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Products retrieved successfully',
    messageBn: 'পণ্য তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single product
exports.getProduct = asyncHandler(async (req, res) => {
  const product = await productService.getProductById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: sanitizeProducts(product, req),
    message: 'Product retrieved successfully',
    messageBn: 'পণ্য সফলভাবে লোড হয়েছে',
  });
});

// Search products for POS/sale item picker
exports.searchProductsForSale = asyncHandler(async (req, res) => {
  const result = await productService.searchProductsForSale(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: sanitizeProducts(result.data, req),
    message: 'Products searched successfully',
    messageBn: 'পণ্য খোঁজা সম্পন্ন হয়েছে',
  });
});

// Get product by barcode/code
exports.getProductByCode = asyncHandler(async (req, res) => {
  const product = await productService.getProductByCode(req.shop._id, req.params.code, req);
  return ApiResponse.success(res, {
    data: sanitizeProducts(product, req),
    message: 'Product retrieved successfully',
    messageBn: 'পণ্য সফলভাবে লোড হয়েছে',
  });
});

// Create product
exports.createProduct = asyncHandler(async (req, res) => {
  const product = await productService.createProduct(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.success(res, {
    data: product,
    message: 'Product created successfully',
    messageBn: 'পণ্য সফলভাবে যোগ করা হয়েছে',
    statusCode: 201,
  });
});

// Update product
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: product,
    message: 'Product updated successfully',
    messageBn: 'পণ্য সফলভাবে আপডেট করা হয়েছে',
  });
});

// Delete product
exports.deleteProduct = asyncHandler(async (req, res) => {
  await productService.deleteProduct(req.shop._id, req.user._id, req.params.id, req);
  return ApiResponse.success(res, {
    message: 'Product deleted successfully',
    messageBn: 'পণ্য সফলভাবে মুছে ফেলা হয়েছে',
  });
});

// Update stock
exports.updateStock = asyncHandler(async (req, res) => {
  const product = await productService.updateStock(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: product,
    message: 'Stock updated successfully',
    messageBn: 'স্টক সফলভাবে আপডেট করা হয়েছে',
  });
});

// ── Batch / expiry ──────────────────────────────────────────────────────────
//
// All four go through `sanitizeBatches`, which strips `costPrice` from anyone
// without `products.view_cost` — a batch's cost price is the same confidential
// figure as a product's `buyingPrice`, just reached by a different route.

// List a product's batches, grouped by variant
exports.getProductBatches = asyncHandler(async (req, res) => {
  const result = await productService.getProductBatches(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: sanitizeBatches(result, req),
    message: 'Batches retrieved successfully',
    messageBn: 'ব্যাচ তালিকা লোড হয়েছে',
  });
});

// Add a batch to a product or one of its variants
exports.addProductBatch = asyncHandler(async (req, res) => {
  const result = await productService.addProductBatch(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: sanitizeBatches(result, req),
    message: 'Batch added successfully',
    messageBn: 'ব্যাচ যোগ করা হয়েছে',
    statusCode: 201,
  });
});

// Correct a batch (expiry date, quantity, number)
exports.updateProductBatch = asyncHandler(async (req, res) => {
  const result = await productService.updateProductBatch(
    req.shop._id, req.user._id, req.params.id, req.params.batchId, req.body, req
  );
  return ApiResponse.success(res, {
    data: sanitizeBatches(result, req),
    message: 'Batch updated successfully',
    messageBn: 'ব্যাচ আপডেট হয়েছে',
  });
});

// Remove a batch (does NOT change stock)
exports.deleteProductBatch = asyncHandler(async (req, res) => {
  const result = await productService.deleteProductBatch(
    req.shop._id, req.user._id, req.params.id, req.params.batchId, req
  );
  return ApiResponse.success(res, {
    data: sanitizeBatches(result, req),
    message: 'Batch deleted successfully',
    messageBn: 'ব্যাচ মুছে ফেলা হয়েছে',
  });
});

// Batches expiring within N days — one row per batch, soonest first
exports.getExpiringBatches = asyncHandler(async (req, res) => {
  const result = await productService.getExpiringBatches(req.shop._id, req.query, req);
  return ApiResponse.paginated(res, {
    ...sanitizeBatches(result, req),
    message: 'Expiring batches retrieved successfully',
    messageBn: 'মেয়াদ শেষ হতে যাওয়া পণ্য লোড হয়েছে',
  });
});

// Get low stock products
exports.getLowStock = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const products = await productService.getLowStockProducts(req.shop._id, limit, req);
  return ApiResponse.success(res, {
    data: sanitizeProducts(products, req),
    message: 'Low stock products retrieved successfully',
    messageBn: 'কম স্টক পণ্য সফলভাবে লোড হয়েছে',
  });
});

// Get stock transactions
exports.getStockTransactions = asyncHandler(async (req, res) => {
  const result = await productService.getStockTransactions(req.shop._id, req.params.id, req.query, req);
  result.data = sanitizeReport(result.data, req); // strips unitCost/totalCost without view_cost
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Stock transactions retrieved successfully',
    messageBn: 'স্টক লেনদেন সফলভাবে লোড হয়েছে',
  });
});

// Bulk update stock
exports.bulkUpdateStock = asyncHandler(async (req, res) => {
  const results = await productService.bulkUpdateStock(req.shop._id, req.user._id, req.body.updates, req);
  return ApiResponse.success(res, {
    data: results,
    message: 'Bulk stock update completed',
    messageBn: 'বাল্ক স্টক আপডেট সম্পন্ন হয়েছে',
  });
});

// Put products online / take them off, in bulk. The online catalogue screen's
// only write path — see productService.bulkSetOnlineStatus for why bulk is
// load-bearing here rather than a convenience.
exports.bulkSetOnlineStatus = asyncHandler(async (req, res) => {
  const result = await productService.bulkSetOnlineStatus(
    req.shop._id,
    req.user._id,
    req,
    req.body
  );

  // The skipped count is the whole reason this returns a summary rather than a
  // bare 204: a shopkeeper who put 80 products online and got 74 needs to be
  // told why, in the same breath, or they will assume it failed.
  const messageBn = result.skippedNoPhoto
    ? `${result.modified}টি পণ্য হালনাগাদ হয়েছে। ${result.skippedNoPhoto}টি পণ্যে ছবি না থাকায় অনলাইনে দেওয়া যায়নি।`
    : `${result.modified}টি পণ্য হালনাগাদ হয়েছে`;

  return ApiResponse.success(res, {
    data: result,
    message: 'Online catalogue updated',
    messageBn,
  });
});

// Toggle product status
exports.toggleStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;
  if (isActive === undefined) {
    return ApiResponse.badRequest(res, {
      message: 'isActive field is required',
      messageBn: 'স্ট্যাটাস দিন',
    });
  }
  const product = await productService.toggleProductStatus(
    req.shop._id,
    req.user._id,
    req.params.id,
    isActive
  );
  return ApiResponse.success(res, {
    data: product,
    message: isActive ? 'Product activated' : 'Product deactivated',
    messageBn: isActive ? 'পণ্য সক্রিয় হয়েছে' : 'পণ্য নিষ্ক্রিয় হয়েছে',
  });
});

// Bulk import products
exports.bulkImport = asyncHandler(async (req, res) => {
  const results = await productService.bulkImportProducts(
    req.shop._id,
    req.user._id,
    req.body.products,
    req
  );
  return ApiResponse.success(res, {
    data: results,
    message: 'Bulk import completed',
    messageBn: 'বাল্ক পণ্য ইম্পোর্ট সম্পন্ন হয়েছে',
  });
});

// Upload product catalog images (supports multiple files via Promise.all)
exports.uploadProductImages = asyncHandler(async (req, res) => {
  const imageUploadService = require('../services/imageUpload.service');
  const Product = require('../models/Product.model');

  if (!imageUploadService.isConfigured()) {
    return ApiResponse.error(res, {
      statusCode: 503,
      message: 'Image upload service is not configured on this server.',
      messageBn: 'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
    });
  }

  const productId = req.params.id;
  const product = await Product.findOne({ _id: productId, shop: req.shop._id });
  if (!product) {
    return ApiResponse.notFound(res, {
      message: 'Product not found',
      messageBn: 'পণ্য পাওয়া যায়নি',
    });
  }

  const files = req.files || (req.file ? [req.file] : []);
  if (files.length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'Please provide at least one image file to upload',
      messageBn: 'অন্তত একটি ছবি দিন',
    });
  }

  // Upload all images in parallel using Promise.all
  const uploadResults = await Promise.all(
    files.map((file) => imageUploadService.uploadFromMulter(file))
  );

  const newCatalogImages = uploadResults.map((result, index) => ({
    url: result.url,
    thumbnail: result.thumbnail,
    isPrimary: (product.catalogImages?.length || 0) === 0 && index === 0,
  }));

  const imageUrls = uploadResults.map((r) => r.url);

  product.catalogImages = [...(product.catalogImages || []), ...newCatalogImages];
  product.images = [...(product.images || []), ...imageUrls];
  await product.save();

  return ApiResponse.success(res, {
    data: {
      product,
      uploadedImages: newCatalogImages,
    },
    message: `${uploadResults.length} catalog image(s) uploaded successfully`,
    messageBn: `${uploadResults.length}টি ক্যাটালগ ছবি আপলোড হয়েছে`,
  });
});


const productService = require('../services/product.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizeProducts, sanitizeReport } = require('../utils/dataSanitizer.util');

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

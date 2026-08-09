const supplierService = require('../services/supplier.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get all suppliers
exports.getSuppliers = asyncHandler(async (req, res) => {
  const result = await supplierService.getSuppliers(req.shop._id, req.query, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Suppliers retrieved successfully',
    messageBn: 'সরবরাহকারীর তালিকা লোড হয়েছে',
  });
});

// Get single supplier
exports.getSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.getSupplierById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: supplier,
    message: 'Supplier retrieved',
    messageBn: 'সরবরাহকারীর তথ্য লোড হয়েছে',
  });
});

// Create supplier
exports.createSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.createSupplier(req.shop._id, req.user._id, req.body);
  return ApiResponse.created(res, {
    data: supplier,
    message: 'Supplier added successfully',
    messageBn: 'সরবরাহকারী সফলভাবে যোগ হয়েছে',
  });
});

// Update supplier
exports.updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.updateSupplier(req.shop._id, req.user._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: supplier,
    message: 'Supplier updated successfully',
    messageBn: 'সরবরাহকারী সফলভাবে আপডেট হয়েছে',
  });
});

// Delete supplier
exports.deleteSupplier = asyncHandler(async (req, res) => {
  await supplierService.deleteSupplier(req.shop._id, req.user._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Supplier deleted successfully',
    messageBn: 'সরবরাহকারী সফলভাবে মুছে ফেলা হয়েছে',
  });
});

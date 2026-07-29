const serviceService = require('../services/service.service');
const { asyncHandler } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/response.util');

/**
 * @route   GET /api/services
 * @desc    Get all services for the shop
 */
exports.getServices = asyncHandler(async (req, res) => {
  const result = await serviceService.getServices(req.shop._id, req.query);
  return ApiResponse.paginated(res, {
    data: result.services,
    page: result.pagination.page,
    limit: result.pagination.limit,
    total: result.pagination.total,
  });
});

/**
 * @route   GET /api/services/billing
 * @desc    Get services for POS/billing (active only, minimal fields)
 */
exports.getServicesForBilling = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const services = await serviceService.getServicesForBilling(req.shop._id, search);
  return ApiResponse.success(res, { data: services });
});

/**
 * @route   GET /api/services/:id
 * @desc    Get a single service
 */
exports.getService = asyncHandler(async (req, res) => {
  const service = await serviceService.getService(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data: service });
});

/**
 * @route   POST /api/services
 * @desc    Create a new service
 */
exports.createService = asyncHandler(async (req, res) => {
  const service = await serviceService.createService(req.shop._id, req.body, req.user._id);
  return ApiResponse.created(res, {
    data: service,
    message: 'সেবা সফলভাবে তৈরি হয়েছে',
  });
});

/**
 * @route   PUT /api/services/:id
 * @desc    Update a service
 */
exports.updateService = asyncHandler(async (req, res) => {
  const service = await serviceService.updateService(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: service,
    message: 'সেবা সফলভাবে আপডেট হয়েছে',
  });
});

/**
 * @route   DELETE /api/services/:id
 * @desc    Delete (soft) a service
 */
exports.deleteService = asyncHandler(async (req, res) => {
  await serviceService.deleteService(req.shop._id, req.params.id);
  return ApiResponse.success(res, { message: 'সেবা সফলভাবে মুছে ফেলা হয়েছে' });
});

/**
 * @route   PATCH /api/services/:id/status
 * @desc    Toggle service active status
 */
exports.toggleStatus = asyncHandler(async (req, res) => {
  const service = await serviceService.toggleStatus(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    data: service,
    message: service.isActive ? 'সেবা সক্রিয় করা হয়েছে' : 'সেবা নিষ্ক্রিয় করা হয়েছে',
  });
});

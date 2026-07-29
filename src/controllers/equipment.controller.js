const equipmentService = require('../services/equipment.service');
const { asyncHandler } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/response.util');

exports.getEquipment = asyncHandler(async (req, res) => {
  const result = await equipmentService.getEquipment(req.shop._id, req.query);
  return ApiResponse.success(res, { data: result.equipment, pagination: result.pagination });
});

exports.getActiveEquipment = asyncHandler(async (req, res) => {
  const equipment = await equipmentService.getActiveForSession(req.shop._id);
  return ApiResponse.success(res, { data: equipment });
});

exports.getOne = asyncHandler(async (req, res) => {
  const eq = await equipmentService.getOne(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data: eq });
});

exports.create = asyncHandler(async (req, res) => {
  const eq = await equipmentService.create(req.shop._id, req.body, req.user._id);
  return ApiResponse.created(res, { data: eq, message: 'যন্ত্রপাতি সফলভাবে যোগ হয়েছে' });
});

exports.update = asyncHandler(async (req, res) => {
  const eq = await equipmentService.update(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, { data: eq, message: 'যন্ত্রপাতি আপডেট হয়েছে' });
});

exports.remove = asyncHandler(async (req, res) => {
  await equipmentService.remove(req.shop._id, req.params.id);
  return ApiResponse.success(res, { message: 'যন্ত্রপাতি অবসরপ্রাপ্ত হয়েছে' });
});

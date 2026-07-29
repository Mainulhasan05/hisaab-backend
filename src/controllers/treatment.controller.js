const treatmentService = require('../services/treatment.service');
const { asyncHandler } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/response.util');

exports.getTreatments = asyncHandler(async (req, res) => {
  const result = await treatmentService.getTreatments(req.shop._id, req.query);
  return ApiResponse.success(res, { data: result.treatments, pagination: result.pagination });
});

exports.getTreatment = asyncHandler(async (req, res) => {
  const treatment = await treatmentService.getTreatment(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data: treatment });
});

exports.createTreatment = asyncHandler(async (req, res) => {
  const treatment = await treatmentService.createTreatment(req.shop._id, req.body, req.user._id);
  return ApiResponse.created(res, { data: treatment, message: 'ট্রিটমেন্ট সফলভাবে তৈরি হয়েছে' });
});

exports.updateTreatment = asyncHandler(async (req, res) => {
  const treatment = await treatmentService.updateTreatment(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, { data: treatment, message: 'ট্রিটমেন্ট আপডেট হয়েছে' });
});

exports.addSession = asyncHandler(async (req, res) => {
  const treatment = await treatmentService.addSession(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, { data: treatment, message: 'সেশন যোগ হয়েছে' });
});

exports.updateSession = asyncHandler(async (req, res) => {
  const treatment = await treatmentService.updateSession(req.shop._id, req.params.id, req.params.sessionId, req.body);
  return ApiResponse.success(res, { data: treatment, message: 'সেশন আপডেট হয়েছে' });
});

exports.deleteTreatment = asyncHandler(async (req, res) => {
  await treatmentService.deleteTreatment(req.shop._id, req.params.id);
  return ApiResponse.success(res, { message: 'ট্রিটমেন্ট মুছে ফেলা হয়েছে' });
});

exports.getCustomerTreatments = asyncHandler(async (req, res) => {
  const treatments = await treatmentService.getCustomerTreatments(req.shop._id, req.params.customerId);
  return ApiResponse.success(res, { data: treatments });
});

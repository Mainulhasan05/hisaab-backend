const appointmentService = require('../services/appointment.service');
const { asyncHandler } = require('../middleware/error.middleware');
const ApiResponse = require('../utils/response.util');

/**
 * @route   GET /api/appointments
 * @desc    Get appointments with filters
 */
exports.getAppointments = asyncHandler(async (req, res) => {
  const result = await appointmentService.getAppointments(req.shop._id, req.query);
  return ApiResponse.success(res, {
    data: result.appointments,
    pagination: result.pagination,
  });
});

/**
 * @route   GET /api/appointments/today-summary
 * @desc    Get today's appointment summary for dashboard
 */
exports.getTodaySummary = asyncHandler(async (req, res) => {
  const summary = await appointmentService.getTodaySummary(req.shop._id);
  return ApiResponse.success(res, { data: summary });
});

/**
 * @route   GET /api/appointments/provider/:providerId/schedule
 * @desc    Get a provider's schedule for a date
 */
exports.getProviderSchedule = asyncHandler(async (req, res) => {
  const { providerId } = req.params;
  const { date } = req.query;
  const schedule = await appointmentService.getProviderSchedule(req.shop._id, providerId, date || new Date());
  return ApiResponse.success(res, { data: schedule });
});

/**
 * @route   GET /api/appointments/:id
 * @desc    Get a single appointment
 */
exports.getAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.getAppointment(req.shop._id, req.params.id);
  return ApiResponse.success(res, { data: appointment });
});

/**
 * @route   POST /api/appointments
 * @desc    Create a new appointment
 */
exports.createAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.createAppointment(req.shop._id, req.body, req.user._id);
  return ApiResponse.created(res, {
    data: appointment,
    message: 'অ্যাপয়েন্টমেন্ট সফলভাবে তৈরি হয়েছে',
  });
});

/**
 * @route   PUT /api/appointments/:id
 * @desc    Update an appointment
 */
exports.updateAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.updateAppointment(req.shop._id, req.params.id, req.body);
  return ApiResponse.success(res, {
    data: appointment,
    message: 'অ্যাপয়েন্টমেন্ট আপডেট হয়েছে',
  });
});

/**
 * @route   PATCH /api/appointments/:id/status
 * @desc    Update appointment status
 */
exports.updateStatus = asyncHandler(async (req, res) => {
  const { status, cancellationReason } = req.body;
  const appointment = await appointmentService.updateStatus(req.shop._id, req.params.id, status, cancellationReason);
  return ApiResponse.success(res, {
    data: appointment,
    message: 'স্ট্যাটাস আপডেট হয়েছে',
  });
});

/**
 * @route   DELETE /api/appointments/:id
 * @desc    Delete an appointment
 */
exports.deleteAppointment = asyncHandler(async (req, res) => {
  await appointmentService.deleteAppointment(req.shop._id, req.params.id);
  return ApiResponse.success(res, { message: 'অ্যাপয়েন্টমেন্ট মুছে ফেলা হয়েছে' });
});

/**
 * @route   PATCH /api/appointments/:id/link-sale
 * @desc    Link an appointment to a sale
 */
exports.linkSale = asyncHandler(async (req, res) => {
  const { saleId } = req.body;
  const appointment = await appointmentService.linkSale(req.shop._id, req.params.id, saleId);
  return ApiResponse.success(res, {
    data: appointment,
    message: 'বিক্রয় লিংক করা হয়েছে',
  });
});

/**
 * @route   GET /api/appointments/dashboard-summary
 * @desc    Get today's dashboard summary
 */
exports.getDashboardSummary = asyncHandler(async (req, res) => {
  const summary = await appointmentService.getTodaySummaryForDashboard(req.shop._id);
  return ApiResponse.success(res, { data: summary });
});

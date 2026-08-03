const StaffService = require('../services/staff.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

const checkPhone = asyncHandler(async (req, res) => {
  const result = await StaffService.checkPhone(req.shop._id, req.query.phone);
  return ApiResponse.success(res, { data: result, message: 'Phone checked', messageBn: 'নম্বর যাচাই হয়েছে' });
});

const getStaff = asyncHandler(async (req, res) => {
  const staff = await StaffService.getStaff(req.shop._id);
  return ApiResponse.success(res, { data: { staff }, message: 'Staff retrieved', messageBn: 'কর্মচারী তালিকা' });
});

const getStaffMember = asyncHandler(async (req, res) => {
  const staff = await StaffService.getStaffMember(req.params.id, req.shop._id);
  return ApiResponse.success(res, { data: { staff }, message: 'Staff member retrieved', messageBn: 'কর্মচারী পাওয়া গেছে' });
});

const createStaff = asyncHandler(async (req, res) => {
  const staff = await StaffService.createStaff(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.created(res, { data: { staff }, message: 'Staff member created', messageBn: 'কর্মচারী যোগ হয়েছে' });
});

const updateStaff = asyncHandler(async (req, res) => {
  const staff = await StaffService.updateStaff(req.params.id, req.shop._id, req.user._id, req.body, req);
  return ApiResponse.success(res, { data: { staff }, message: 'Staff member updated', messageBn: 'কর্মচারী আপডেট হয়েছে' });
});

const deactivateStaff = asyncHandler(async (req, res) => {
  const result = await StaffService.deactivateStaff(req.params.id, req.shop._id, req.user._id, req);
  return ApiResponse.success(res, { message: 'Staff member deactivated', messageBn: 'কর্মচারী নিষ্ক্রিয় করা হয়েছে' });
});

module.exports = { getStaff, getStaffMember, createStaff, updateStaff, deactivateStaff, checkPhone };

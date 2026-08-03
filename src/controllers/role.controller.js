const RoleService = require('../services/role.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

const getRoles = asyncHandler(async (req, res) => {
  const roles = await RoleService.getRoles(req.shop._id);
  return ApiResponse.success(res, { data: { roles }, message: 'Roles retrieved', messageBn: 'ভূমিকা তালিকা' });
});

const getRole = asyncHandler(async (req, res) => {
  const role = await RoleService.getRole(req.params.id, req.shop._id);
  return ApiResponse.success(res, { data: { role }, message: 'Role retrieved', messageBn: 'ভূমিকা পাওয়া গেছে' });
});

const createRole = asyncHandler(async (req, res) => {
  const role = await RoleService.createRole(req.shop._id, req.body);
  return ApiResponse.created(res, { data: { role }, message: 'Role created', messageBn: 'ভূমিকা তৈরি হয়েছে' });
});

const updateRole = asyncHandler(async (req, res) => {
  const role = await RoleService.updateRole(req.params.id, req.shop._id, req.body);
  return ApiResponse.success(res, { data: { role }, message: 'Role updated', messageBn: 'ভূমিকা আপডেট হয়েছে' });
});

const deleteRole = asyncHandler(async (req, res) => {
  const result = await RoleService.deleteRole(req.params.id, req.shop._id);
  return ApiResponse.success(res, { message: 'Role deleted', messageBn: 'ভূমিকা মুছে ফেলা হয়েছে' });
});

const getPresets = asyncHandler(async (req, res) => {
  const presets = RoleService.getPresets();
  return ApiResponse.success(res, { data: { presets }, message: 'Role presets', messageBn: 'প্রিসেট ভূমিকা' });
});

const getMatrix = asyncHandler(async (req, res) => {
  const matrix = RoleService.getMatrix();
  return ApiResponse.success(res, { data: { matrix }, message: 'Permission matrix', messageBn: 'অনুমতি তালিকা' });
});

module.exports = { getRoles, getRole, createRole, updateRole, deleteRole, getPresets, getMatrix };

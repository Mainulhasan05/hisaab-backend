const auditService = require('../services/audit.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

// Get audit logs
exports.getAuditLogs = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const result = await auditService.getAuditLogs(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Audit logs retrieved successfully',
    messageBn: 'অডিট লগ সফলভাবে লোড হয়েছে',
  });
});

// Get single audit log
exports.getAuditLog = asyncHandler(async (req, res) => {
  const log = await auditService.getAuditLogById(req.shop._id, req.params.id, req);
  return ApiResponse.success(res, {
    data: log,
    message: 'Audit log retrieved successfully',
    messageBn: 'অডিট লগ সফলভাবে লোড হয়েছে',
  });
});

// Get activity summary
exports.getActivitySummary = asyncHandler(async (req, res) => {
  const summary = await auditService.getActivitySummary(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Activity summary retrieved successfully',
    messageBn: 'কার্যকলাপ সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get user activity
exports.getUserActivity = asyncHandler(async (req, res) => {
  const result = await auditService.getUserActivity(req.shop._id, req.params.userId, req.query, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'User activity retrieved successfully',
    messageBn: 'ব্যবহারকারীর কার্যকলাপ সফলভাবে লোড হয়েছে',
  });
});

// Get entity history
exports.getEntityHistory = asyncHandler(async (req, res) => {
  const { entityType, entityId } = req.params;
  const logs = await auditService.getEntityHistory(req.shop._id, entityType, entityId, req);
  return ApiResponse.success(res, {
    data: logs,
    message: 'Entity history retrieved successfully',
    messageBn: 'ইতিহাস সফলভাবে লোড হয়েছে',
  });
});

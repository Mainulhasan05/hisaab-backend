/**
 * Heartbeat Controller
 * Handles user presence/online tracking
 */

const onlineTrackingService = require('../services/onlineTracking.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/**
 * @desc    Record heartbeat from client
 * @route   POST /api/heartbeat
 * @access  Private
 */
const recordHeartbeat = asyncHandler(async (req, res) => {
  const userId = req.user._id.toString();
  const shopId = req.shop?._id?.toString();

  // Get client info from request context
  const metadata = {
    ip: req.context?.ip || req.ip,
    browser: req.context?.browser,
    os: req.context?.os,
    device: req.context?.device,
    isMobile: req.context?.isMobile,
    page: req.body.page || null, // Current page user is viewing
    timezone: req.body.timezone || null
  };

  const result = await onlineTrackingService.recordHeartbeat(userId, shopId, metadata);

  return ApiResponse.success(res, {
    data: {
      timestamp: result.timestamp,
      recorded: result.success
    }
  });
});

/**
 * @desc    Get shop's online users
 * @route   GET /api/heartbeat/shop/online
 * @access  Private (Owner/Manager)
 */
const getShopOnlineUsers = asyncHandler(async (req, res) => {
  const shopId = req.shop._id.toString();
  const onlineUsers = await onlineTrackingService.getShopOnlineUsers(shopId);

  return ApiResponse.success(res, {
    data: {
      count: onlineUsers.length,
      users: onlineUsers
    },
    messageBn: `${onlineUsers.length} জন অনলাইনে আছেন`
  });
});

/**
 * @desc    Get specific user's status
 * @route   GET /api/heartbeat/user/:userId
 * @access  Private (Owner/Manager)
 */
const getUserStatus = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const status = await onlineTrackingService.getUserStatus(userId);

  return ApiResponse.success(res, {
    data: status
  });
});

/**
 * @desc    Mark user offline (on logout)
 * @route   POST /api/heartbeat/offline
 * @access  Private
 */
const markOffline = asyncHandler(async (req, res) => {
  const userId = req.user._id.toString();
  const shopId = req.shop?._id?.toString();

  await onlineTrackingService.markOffline(userId, shopId);

  return ApiResponse.success(res, {
    message: 'Marked offline',
    messageBn: 'অফলাইন চিহ্নিত'
  });
});

/**
 * @desc    Get online statistics (Admin only)
 * @route   GET /api/admin/heartbeat/stats
 * @access  Admin
 */
const getOnlineStats = asyncHandler(async (req, res) => {
  const stats = await onlineTrackingService.getOnlineStats();

  return ApiResponse.success(res, {
    data: stats
  });
});

/**
 * @desc    Get multiple users' status
 * @route   POST /api/heartbeat/users/status
 * @access  Private (Owner/Manager)
 */
const bulkGetUserStatus = asyncHandler(async (req, res) => {
  const { userIds } = req.body;

  if (!userIds || !Array.isArray(userIds)) {
    return ApiResponse.badRequest(res, {
      message: 'userIds array is required',
      messageBn: 'userIds অ্যারে আবশ্যক'
    });
  }

  const statuses = await onlineTrackingService.bulkGetStatus(userIds);

  return ApiResponse.success(res, {
    data: statuses
  });
});

module.exports = {
  recordHeartbeat,
  getShopOnlineUsers,
  getUserStatus,
  markOffline,
  getOnlineStats,
  bulkGetUserStatus
};

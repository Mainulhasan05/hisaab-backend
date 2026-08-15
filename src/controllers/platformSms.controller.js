/**
 * Platform → shopkeeper messaging, admin endpoints.
 *
 * Thin, like `billing.controller`: audience resolution, pricing, the compliance
 * route choice and the audit entry all live in `platformSms.service`, because
 * the panel must not be able to reach the gateway by any path that skips them.
 */

const platformSmsService = require('../services/platformSms.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

/** Who pressed send, in the shape the service stores on the log and the audit. */
const actorOf = (req) => ({ id: req.admin?._id, name: req.admin?.name });

/** The audience list, with live counts — everything the composer needs to open. */
exports.getAudiences = asyncHandler(async (req, res) => {
  const data = await platformSmsService.getAudienceCounts();
  return ApiResponse.success(res, {
    data,
    message: 'Audiences retrieved',
    messageBn: 'প্রাপক তালিকা লোড হয়েছে',
  });
});

/** Reach, cost and the exact body — before anything is sent. */
exports.previewBroadcast = asyncHandler(async (req, res) => {
  const { audience, message, shopId, includeStaff, phones } = req.body;
  const data = await platformSmsService.preview(audience, {
    message,
    shopId,
    includeStaff,
    phones,
  });
  return ApiResponse.success(res, {
    data,
    message: 'Preview ready',
    messageBn: 'প্রিভিউ প্রস্তুত',
  });
});

exports.sendBroadcast = asyncHandler(async (req, res) => {
  const data = await platformSmsService.send(actorOf(req), req.body);
  return ApiResponse.success(res, {
    data,
    message: data.queued ? 'Broadcast queued' : 'Broadcast sent',
    messageBn: data.queued ? 'এসএমএস পাঠানো শুরু হয়েছে' : 'এসএমএস পাঠানো হয়েছে',
  });
});

/** Progress of a running broadcast. Polled, so it stays outside the limiter. */
exports.getBroadcast = asyncHandler(async (req, res) => {
  const data = await platformSmsService.getCampaign(req.params.id);
  if (!data) {
    return ApiResponse.error(res, {
      message: 'Broadcast not found',
      messageBn: 'পাওয়া যায়নি',
      statusCode: 404,
    });
  }
  return ApiResponse.success(res, { data, message: 'Broadcast status retrieved' });
});

exports.getBroadcastHistory = asyncHandler(async (req, res) => {
  const result = await platformSmsService.history(req.query);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Broadcast history retrieved',
    messageBn: 'পাঠানো এসএমএসের তালিকা লোড হয়েছে',
  });
});

/**
 * The platform's own float at MimSMS.
 *
 * Never 500s on a gateway outage — the service returns `{ available: false }`
 * and the dashboard renders "unknown". A balance widget that can take the SMS
 * page down with it is worse than no balance widget.
 */
exports.getGatewayBalance = asyncHandler(async (req, res) => {
  const data = await platformSmsService.gatewayBalance();
  return ApiResponse.success(res, {
    data,
    message: 'Gateway balance retrieved',
    messageBn: 'গেটওয়ে ব্যালেন্স লোড হয়েছে',
  });
});

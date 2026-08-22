/**
 * SMS gateway administration — the operator's control surface.
 *
 * Thin, like the other admin controllers: every decision (validation, cache
 * write-through, the audit entry) lives in the service, so the panel cannot
 * reach the routing configuration by a path that skips them.
 */

const smsProviderService = require('../services/smsProvider.service');
const smsEarnings = require('../services/sms/earnings');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

const actorOf = (req) => ({ id: req.admin?._id, name: req.admin?.name });

/**
 * Every registered gateway: credentials present, live balance, and which one is
 * currently routing. The balance calls run concurrently and never reject, so one
 * unreachable gateway does not blank the screen.
 */
exports.listProviders = asyncHandler(async (req, res) => {
  const data = await smsProviderService.overview({ withBalance: req.query.balance !== 'false' });
  return ApiResponse.success(res, {
    data,
    message: 'SMS providers retrieved',
    messageBn: 'এসএমএস গেটওয়ে তালিকা লোড হয়েছে',
  });
});

/** The routing configuration alone — no balance calls, for polling dashboards. */
exports.getRouting = asyncHandler(async (req, res) => {
  const data = await smsProviderService.getRouting();
  return ApiResponse.success(res, {
    data,
    message: 'SMS routing retrieved',
    messageBn: 'রাউটিং সেটিংস লোড হয়েছে',
  });
});

/**
 * Change which gateway sends and which catches it.
 *
 * A MERGE, not a replace: a body naming only `primaryProvider` must leave the
 * failover settings alone. See the service for why that distinction matters.
 */
exports.updateRouting = asyncHandler(async (req, res) => {
  const { primaryProvider, failoverProvider, failoverEnabled } = req.body;
  const data = await smsProviderService.updateRouting(
    { primaryProvider, failoverProvider, failoverEnabled },
    actorOf(req)
  );
  return ApiResponse.success(res, {
    data,
    message: 'SMS routing updated',
    messageBn: 'রাউটিং সেটিংস সংরক্ষিত হয়েছে',
  });
});

/** What each gateway charges us per segment. */
exports.updateCosts = asyncHandler(async (req, res) => {
  const data = await smsProviderService.updateCosts(req.body?.costs || {}, actorOf(req));
  return ApiResponse.success(res, {
    data,
    message: 'Gateway costs updated',
    messageBn: 'গেটওয়ে খরচ সংরক্ষিত হয়েছে',
  });
});

/**
 * Send one real message through a NAMED gateway, with failover switched off.
 *
 * Failover off is the entire point: a test that silently succeeds on the other
 * gateway tells the operator the opposite of what they asked.
 */
exports.testProvider = asyncHandler(async (req, res) => {
  const data = await smsProviderService.testProvider(
    req.params.name,
    { phone: req.body?.phone, message: req.body?.message },
    actorOf(req)
  );
  return ApiResponse.success(res, {
    data,
    message: `Test message sent via ${req.params.name}`,
    messageBn: 'টেস্ট মেসেজ পাঠানো হয়েছে',
  });
});

/**
 * The earnings report: revenue, gateway cost and margin, by period and gateway.
 */
exports.getEarnings = asyncHandler(async (req, res) => {
  const { from, to, shopId, provider, groupBy } = req.query;
  const data = await smsEarnings.report({
    from: from || null,
    to: to || null,
    shopId: shopId || null,
    provider: provider || null,
    groupBy: groupBy || 'period',
  });
  return ApiResponse.success(res, {
    data,
    message: 'SMS earnings retrieved',
    messageBn: 'এসএমএস আয়ের হিসাব লোড হয়েছে',
  });
});

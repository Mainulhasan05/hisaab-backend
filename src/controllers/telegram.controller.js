const TelegramLink = require('../models/TelegramLink.model');
const AuditLog = require('../models/AuditLog.model');
const telegramService = require('../services/telegram.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AUDIT_ACTIONS } = require('../config/constants');

/**
 * Owner-facing Telegram endpoints.
 *
 * Every route is behind `ownerOnly`. Staff never link: the digest carries
 * shop-wide revenue and profit, which the RBAC matrix deliberately gates
 * behind `view_profit`, and a notification channel must not become a way
 * around the permission layer.
 */

/**
 * Mint a deep link. The owner taps it, Telegram opens on `/start <token>`,
 * and the bot completes the link — no chat id to copy, nothing to configure.
 */
exports.getLinkToken = asyncHandler(async (req, res) => {
  if (!telegramService.isEnabled()) {
    return ApiResponse.serverError(res, {
      message: 'Telegram is not configured on this server',
      messageBn: 'টেলিগ্রাম এখনও চালু করা হয়নি। সাপোর্টে যোগাযোগ করুন।',
    });
  }

  const result = await telegramService.createLinkToken(req.user._id, req.shop._id);

  return ApiResponse.success(res, {
    data: result,
    message: 'Telegram link token created',
    messageBn: 'টেলিগ্রাম লিংক তৈরি হয়েছে',
  });
});

/**
 * Connection state. Polled every few seconds by the dashboard while a link is
 * in progress, so it stays deliberately cheap and never mutates anything.
 */
exports.getStatus = asyncHandler(async (req, res) => {
  const link = await TelegramLink.findOne({ shop: req.shop._id, user: req.user._id }).lean();

  return ApiResponse.success(res, {
    data: {
      available: telegramService.isEnabled(),
      botUsername: telegramService.getBotUsername(),
      isLinked: Boolean(link && link.isActive),
      telegramUsername: link?.telegramUsername || null,
      telegramFirstName: link?.telegramFirstName || null,
      linkedAt: link?.linkedAt || null,
      unlinkedAt: link?.unlinkedAt || null,
      preferences: link?.preferences || { dailySummary: true, digestTime: '22:00' },
      lastDigestSentFor: link?.lastDigestSentFor || null,
    },
    message: 'Telegram status retrieved',
    messageBn: 'টেলিগ্রাম স্ট্যাটাস লোড হয়েছে',
  });
});

exports.unlink = asyncHandler(async (req, res) => {
  const removed = await telegramService.unlink(req.user._id, req.shop._id);

  if (removed) {
    // Fire-and-forget: an audit write must not fail a disconnect the owner
    // has already been told succeeded.
    AuditLog.log({
      shop: req.shop._id,
      user: req.user._id,
      action: AUDIT_ACTIONS.TELEGRAM_UNLINK.en,
      description: 'টেলিগ্রাম নোটিফিকেশন সংযোগ বন্ধ করা হয়েছে',
      req,
    }).catch(() => {});
  }

  return ApiResponse.success(res, {
    data: { isLinked: false },
    message: removed ? 'Telegram disconnected' : 'No active Telegram link',
    messageBn: removed ? 'টেলিগ্রাম সংযোগ বন্ধ হয়েছে' : 'কোনো সক্রিয় সংযোগ নেই',
  });
});

/**
 * Update digest preferences.
 *
 * Fields are read individually rather than spread from the body — `req.body`
 * reaching a document is how `isActive` or `telegramChatId` gets overwritten
 * by a crafted request.
 */
exports.updatePreferences = asyncHandler(async (req, res) => {
  const { dailySummary, digestTime } = req.body;
  const update = {};

  if (dailySummary !== undefined) {
    if (typeof dailySummary !== 'boolean') {
      return ApiResponse.badRequest(res, {
        message: 'dailySummary must be a boolean',
        messageBn: 'অবৈধ মান',
      });
    }
    update['preferences.dailySummary'] = dailySummary;
  }

  if (digestTime !== undefined) {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(digestTime))) {
      return ApiResponse.badRequest(res, {
        message: 'digestTime must be HH:MM (24-hour)',
        messageBn: 'সময় HH:MM ফরম্যাটে দিন (যেমন 22:00)',
      });
    }
    update['preferences.digestTime'] = digestTime;
  }

  if (Object.keys(update).length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'Nothing to update',
      messageBn: 'পরিবর্তনের কিছু নেই',
    });
  }

  const link = await TelegramLink.findOneAndUpdate(
    { shop: req.shop._id, user: req.user._id, isActive: true },
    { $set: update },
    { new: true, runValidators: true }
  ).lean();

  if (!link) {
    return ApiResponse.notFound(res, {
      message: 'No active Telegram link',
      messageBn: 'টেলিগ্রাম সংযুক্ত নেই',
    });
  }

  return ApiResponse.success(res, {
    data: { preferences: link.preferences },
    message: 'Telegram preferences updated',
    messageBn: 'সেটিংস সংরক্ষিত হয়েছে',
  });
});

/**
 * Send the digest right now, using today's figures so far.
 *
 * This is the "did it actually work?" button. It deliberately does NOT touch
 * `lastDigestSentFor`, so testing at 3 PM does not cancel the real 10 PM one.
 */
exports.sendTest = asyncHandler(async (req, res) => {
  const link = await TelegramLink.findOne({
    shop: req.shop._id,
    user: req.user._id,
    isActive: true,
  }).lean();

  if (!link) {
    return ApiResponse.notFound(res, {
      message: 'No active Telegram link',
      messageBn: 'টেলিগ্রাম সংযুক্ত নেই',
    });
  }

  const reportService = require('../services/report.service');
  const { buildMessage } = require('../jobs/dailyDigest.job');
  const { getBangladeshTodayStr, getBangladeshTimeStr } = require('../utils/bdTime.util');

  const dateStr = getBangladeshTodayStr();
  const multiBranch = req.shop.multiBranchEnabled === true;
  const totals = await reportService.getDigestTotals(req.shop._id, dateStr, { multiBranch });

  const message = buildMessage({
    shopName: req.shop.name,
    totals,
    asOfTime: getBangladeshTimeStr(),
    multiBranch,
  });

  const messageId = await telegramService.safeSend(link.telegramChatId, message, {
    eventType: 'daily_summary',
    shopId: req.shop._id,
    userId: req.user._id,
  });

  if (!messageId) {
    return ApiResponse.serverError(res, {
      message: 'Telegram delivery failed',
      messageBn: 'পাঠানো যায়নি। টেলিগ্রামে বটটি ব্লক করা আছে কিনা দেখুন।',
    });
  }

  return ApiResponse.success(res, {
    data: { sent: true },
    message: 'Test digest sent',
    messageBn: 'টেস্ট রিপোর্ট পাঠানো হয়েছে',
  });
});

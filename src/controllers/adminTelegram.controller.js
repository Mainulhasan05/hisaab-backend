const AdminTelegramLink = require('../models/AdminTelegramLink.model');
const { ALERT_KEYS } = require('../models/AdminTelegramLink.model');
const AuditLog = require('../models/AuditLog.model');
const telegramService = require('../services/telegram.service');
const platformNotify = require('../services/platformNotify.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AUDIT_ACTIONS } = require('../config/constants');
const { getBangladeshTimeStr } = require('../utils/bdTime.util');

/**
 * The operator's own Telegram channel — link, preferences, test.
 *
 * Mounted under the admin router, which is already behind `protect` +
 * `adminOnly`, so `req.admin` is present on every handler here. This channel
 * receives every shop's signup and login traffic and the whole platform's
 * takings, so it is deliberately not reachable by anything below an admin
 * session.
 */

/** The switches a client may set, and how each is validated. */
const BOOLEAN_PREFERENCES = [
  ALERT_KEYS.NEW_SHOP,
  ALERT_KEYS.USER_LOGIN,
  ALERT_KEYS.SECURITY,
  ALERT_KEYS.ADMIN_ACTIVITY,
  ALERT_KEYS.DAILY_PULSE,
];

/**
 * Mint a deep link. The operator taps it, Telegram opens on `/start <token>`,
 * and the bot completes the link — no chat id to copy anywhere.
 */
exports.getLinkToken = asyncHandler(async (req, res) => {
  if (!telegramService.isEnabled()) {
    return ApiResponse.serverError(res, {
      message: 'Telegram is not configured on this server',
      messageBn: 'সার্ভারে টেলিগ্রাম চালু করা নেই (TELEGRAM_BOT_TOKEN)।',
    });
  }

  const result = await telegramService.createAdminLinkToken(req.admin._id);

  return ApiResponse.success(res, {
    data: result,
    message: 'Admin Telegram link token created',
    messageBn: 'টেলিগ্রাম লিংক তৈরি হয়েছে',
  });
});

/**
 * Connection state and current preferences.
 *
 * Polled every few seconds by the console while a link is in progress, so it
 * stays cheap and never mutates anything.
 */
exports.getStatus = asyncHandler(async (req, res) => {
  const link = await AdminTelegramLink.findOne({ admin: req.admin._id }).lean();

  return ApiResponse.success(res, {
    data: {
      available: telegramService.isEnabled(),
      botUsername: telegramService.getBotUsername(),
      isLinked: Boolean(link && link.isActive),
      telegramUsername: link?.telegramUsername || null,
      telegramFirstName: link?.telegramFirstName || null,
      linkedAt: link?.linkedAt || null,
      unlinkedAt: link?.unlinkedAt || null,
      preferences: link?.preferences || {
        [ALERT_KEYS.NEW_SHOP]: true,
        [ALERT_KEYS.USER_LOGIN]: true,
        [ALERT_KEYS.SECURITY]: true,
        [ALERT_KEYS.ADMIN_ACTIVITY]: true,
        [ALERT_KEYS.DAILY_PULSE]: true,
        pulseTime: '09:00',
        loginCooldownMinutes: 60,
      },
      lastPulseSentFor: link?.lastPulseSentFor || null,
    },
    message: 'Admin Telegram status retrieved',
    messageBn: 'টেলিগ্রাম স্ট্যাটাস লোড হয়েছে',
  });
});

exports.unlink = asyncHandler(async (req, res) => {
  const removed = await telegramService.unlinkAdmin(req.admin._id);

  // The notifier caches "is anyone listening" for a minute. Without this drop,
  // alerts keep being composed for up to a minute after a disconnect.
  await platformNotify.invalidateCache();

  if (removed) {
    AuditLog.log({
      admin: req.admin._id,
      action: AUDIT_ACTIONS.ADMIN_TELEGRAM_UNLINK.en,
      description: 'প্ল্যাটফর্ম অ্যালার্ট চ্যানেল বন্ধ করা হয়েছে',
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
 * Update alert preferences.
 *
 * Fields are read individually rather than spread from the body — `req.body`
 * reaching a document is how `isActive` or `telegramChatId` gets overwritten by
 * a crafted request.
 */
exports.updatePreferences = asyncHandler(async (req, res) => {
  const update = {};

  for (const key of BOOLEAN_PREFERENCES) {
    const value = req.body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return ApiResponse.badRequest(res, {
        message: `${key} must be a boolean`,
        messageBn: 'অবৈধ মান',
      });
    }
    update[`preferences.${key}`] = value;
  }

  if (req.body.pulseTime !== undefined) {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(req.body.pulseTime))) {
      return ApiResponse.badRequest(res, {
        message: 'pulseTime must be HH:MM (24-hour)',
        messageBn: 'সময় HH:MM ফরম্যাটে দিন (যেমন 09:00)',
      });
    }
    update['preferences.pulseTime'] = req.body.pulseTime;
  }

  if (req.body.loginCooldownMinutes !== undefined) {
    const minutes = Number(req.body.loginCooldownMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      return ApiResponse.badRequest(res, {
        message: 'loginCooldownMinutes must be between 0 and 1440',
        messageBn: 'সময় ০ থেকে ১৪৪০ মিনিটের মধ্যে দিন',
      });
    }
    update['preferences.loginCooldownMinutes'] = Math.round(minutes);
  }

  if (Object.keys(update).length === 0) {
    return ApiResponse.badRequest(res, {
      message: 'Nothing to update',
      messageBn: 'পরিবর্তনের কিছু নেই',
    });
  }

  const link = await AdminTelegramLink.findOneAndUpdate(
    { admin: req.admin._id, isActive: true },
    { $set: update },
    { new: true, runValidators: true }
  ).lean();

  if (!link) {
    return ApiResponse.notFound(res, {
      message: 'No active Telegram link',
      messageBn: 'টেলিগ্রাম সংযুক্ত নেই',
    });
  }

  // The cooldown is cached for a minute; a change the operator just made must
  // take effect now, not eventually.
  await platformNotify.invalidateCache();

  AuditLog.log({
    admin: req.admin._id,
    action: AUDIT_ACTIONS.ADMIN_ALERT_PREFS_UPDATE.en,
    description: `অ্যালার্ট সেটিংস পরিবর্তন: ${Object.keys(update).join(', ')}`,
    req,
  }).catch(() => {});

  return ApiResponse.success(res, {
    data: { preferences: link.preferences },
    message: 'Alert preferences updated',
    messageBn: 'সেটিংস সংরক্ষিত হয়েছে',
  });
});

/**
 * Send a sample alert right now.
 *
 * The "did it actually work?" button. It sends directly to this operator's own
 * chat rather than through `broadcastToAdmins`, so the test still proves the
 * channel works when every alert class happens to be switched off — which is
 * exactly the state someone testing their setup is most likely to be in.
 */
exports.sendTest = asyncHandler(async (req, res) => {
  const link = await AdminTelegramLink.findOne({ admin: req.admin._id, isActive: true }).lean();

  if (!link) {
    return ApiResponse.notFound(res, {
      message: 'No active Telegram link',
      messageBn: 'টেলিগ্রাম সংযুক্ত নেই',
    });
  }

  const messageId = await telegramService.safeSend(
    link.telegramChatId,
    '🔔 <b>টেস্ট অ্যালার্ট</b>\n\n' +
    'প্ল্যাটফর্ম অ্যালার্ট ঠিকভাবে কাজ করছে ✅\n\n' +
    'আসল অ্যালার্টগুলো এই রকম দেখাবে:\n' +
    '🎉 নতুন দোকান রেজিস্ট্রেশন\n' +
    '🔑 ইউজার লগইন\n' +
    '🚨 নতুন ডিভাইস / ভুল পাসওয়ার্ড\n' +
    '📊 দৈনিক প্ল্যাটফর্ম রিপোর্ট\n\n' +
    `🕒 ${getBangladeshTimeStr()}`,
    { eventType: 'platform_alert', adminId: req.admin._id }
  );

  if (!messageId) {
    return ApiResponse.serverError(res, {
      message: 'Telegram delivery failed',
      messageBn: 'পাঠানো যায়নি। টেলিগ্রামে বটটি ব্লক করা আছে কিনা দেখুন।',
    });
  }

  return ApiResponse.success(res, {
    data: { sent: true },
    message: 'Test alert sent',
    messageBn: 'টেস্ট অ্যালার্ট পাঠানো হয়েছে',
  });
});

/**
 * Send the daily pulse on demand.
 *
 * Deliberately does NOT claim today's date, so previewing the report at 3 PM
 * does not cancel the scheduled one. Same rule the shop digest's test button
 * follows, and for the same reason.
 */
exports.sendPulseNow = asyncHandler(async (req, res) => {
  const link = await AdminTelegramLink.findOne({ admin: req.admin._id, isActive: true }).lean();

  if (!link) {
    return ApiResponse.notFound(res, {
      message: 'No active Telegram link',
      messageBn: 'টেলিগ্রাম সংযুক্ত নেই',
    });
  }

  const { buildPulseMessage } = require('../jobs/platformPulse.job');
  const message = await buildPulseMessage();

  const messageId = await telegramService.safeSend(link.telegramChatId, message, {
    eventType: 'platform_pulse',
    adminId: req.admin._id,
  });

  if (!messageId) {
    return ApiResponse.serverError(res, {
      message: 'Telegram delivery failed',
      messageBn: 'পাঠানো যায়নি। টেলিগ্রামে বটটি ব্লক করা আছে কিনা দেখুন।',
    });
  }

  return ApiResponse.success(res, {
    data: { sent: true },
    message: 'Platform pulse sent',
    messageBn: 'প্ল্যাটফর্ম রিপোর্ট পাঠানো হয়েছে',
  });
});

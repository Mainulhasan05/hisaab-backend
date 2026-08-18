/**
 * The daily platform pulse — the operator's own digest.
 *
 * One message a day to every linked admin: how many shops signed up, how many
 * traded, what the platform turned over, what came in as subscription money,
 * and who is about to expire. The point is the same as the shop digest's: the
 * founder should not have to open the console to know how the business did.
 *
 * ── BUILT ON THE SAME BONES AS `dailyDigest.job` ────────────────────────────
 *
 * Ticks every minute, sends at each operator's configured Bangladesh local
 * time, claims the date atomically before composing so a restart inside the
 * window cannot deliver two contradictory reports, and gives up past a
 * catch-up window rather than landing a "daily" report in the middle of the
 * night. Those decisions are argued in that file; they are not re-argued here.
 *
 * ── WHY IT DOES NOT REUSE `adminService.getStats()` ─────────────────────────
 *
 * `getStats` already computes most of these numbers and is cached, so reusing
 * it looks free. It is not: its day boundaries are `new Date(y, m, d)` — SERVER
 * local midnight — which on a UTC host is 06:00 in Dhaka. That is tolerable for
 * a dashboard someone is watching change, and wrong for a report headed
 * "আজ" that gets filed and compared. Every figure here is cut on Bangladesh
 * calendar boundaries via `bdTime.util`, which is the one definition of "today"
 * the rest of the reporting layer uses.
 */

const AdminTelegramLink = require('../models/AdminTelegramLink.model');
const { ALERT_KEYS } = require('../models/AdminTelegramLink.model');
const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const Sale = require('../models/Sale.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const telegramService = require('../services/telegram.service');
const logger = require('../utils/logger.util');
const {
  getBangladeshTodayStr,
  getBangladeshDayRange,
  getBangladeshTimeStr,
  minutesOfDay,
} = require('../utils/bdTime.util');
const { formatMoney, formatCount, formatDate } = require('../utils/telegramFormat.util');

const TICK_INTERVAL_MS = 60 * 1000;

/**
 * How late a pulse may still go out. Down at 09:00 and back at 10:30? Still
 * worth sending. Past this it is skipped — yesterday's numbers arriving at
 * 4 PM are noise, and today's will be on time.
 */
const CATCHUP_MINUTES = 180;

/** Telegram's ceiling is ~30 msg/s. A handful of operators needs nothing near it. */
const SEND_GAP_MS = 100;

/** Shops expiring within this many days get named in the pulse. */
const EXPIRY_HORIZON_DAYS = 7;

let timerHandle = null;
let running = false;

/**
 * Gather every figure the pulse reports, on Bangladesh calendar boundaries.
 *
 * One `Promise.all`. Each query is independent and each is a platform-wide
 * scan, so running them sequentially would pay a full round trip per figure for
 * no reason.
 */
async function collectPulseData(dateStr = getBangladeshTodayStr()) {
  const { startOfDay, endOfDay } = getBangladeshDayRange(dateStr);

  // Yesterday, for the comparison line. Derived from the same helper rather
  // than by subtracting 24h from `startOfDay`, so it stays correct across the
  // day boundary regardless of host timezone.
  const yesterdayStr = new Date(startOfDay.getTime() - 12 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const yesterday = getBangladeshDayRange(yesterdayStr);

  const expiryHorizon = new Date(Date.now() + EXPIRY_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const [
    totalShops,
    newShopsToday,
    newUsersToday,
    activeSubs,
    expiredSubs,
    salesFacet,
    platformIncomeToday,
    expiringSoon,
  ] = await Promise.all([
    Shop.countDocuments({}),
    Shop.countDocuments({ createdAt: { $gte: startOfDay, $lte: endOfDay } }),
    User.countDocuments({ createdAt: { $gte: startOfDay, $lte: endOfDay } }),
    Shop.countDocuments({ 'subscription.status': 'active' }),
    Shop.countDocuments({ 'subscription.status': 'expired' }),

    // Today and yesterday in one pass. The outer $match covers the earlier of
    // the two boundaries — matching on today's alone would make the comparison
    // line permanently read "+100%".
    Sale.aggregate([
      {
        $match: {
          createdAt: { $gte: yesterday.startOfDay, $lte: endOfDay },
          status: { $ne: 'cancelled' },
        },
      },
      {
        $facet: {
          today: [
            { $match: { createdAt: { $gte: startOfDay, $lte: endOfDay } } },
            {
              $group: {
                _id: null,
                invoices: { $sum: 1 },
                revenue: { $sum: '$total' },
                shops: { $addToSet: '$shop' },
              },
            },
          ],
          yesterday: [
            { $match: { createdAt: { $gte: yesterday.startOfDay, $lte: yesterday.endOfDay } } },
            { $group: { _id: null, invoices: { $sum: 1 }, revenue: { $sum: '$total' } } },
          ],
        },
      },
    ]),

    // The platform's OWN income — subscription money in, not shops' takings.
    // Dated by `receivedAt` (when the money arrived) rather than `createdAt`
    // (when someone keyed it in), which is the same rule getStats follows.
    PlatformPayment.aggregate([
      { $match: { type: 'subscription', receivedAt: { $gte: startOfDay, $lte: endOfDay } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // The call list. Named, not just counted — a number tells the operator
    // there is work; the names ARE the work.
    Shop.find({
      isActive: true,
      'subscription.status': { $in: ['active', 'trial'] },
      'subscription.expiresAt': { $gte: new Date(), $lte: expiryHorizon },
    })
      .select('name subscription.expiresAt')
      .sort({ 'subscription.expiresAt': 1 })
      .limit(8)
      .lean(),
  ]);

  const today = salesFacet[0]?.today?.[0] || {};
  const prior = salesFacet[0]?.yesterday?.[0] || {};

  return {
    dateStr,
    totalShops,
    newShopsToday,
    newUsersToday,
    activeSubs,
    expiredSubs,
    invoices: today.invoices || 0,
    revenue: today.revenue || 0,
    tradingShops: (today.shops || []).length,
    priorInvoices: prior.invoices || 0,
    priorRevenue: prior.revenue || 0,
    platformIncome: platformIncomeToday[0]?.amount || 0,
    platformIncomeCount: platformIncomeToday[0]?.count || 0,
    expiringSoon,
  };
}

/**
 * Day-over-day movement as a short, signed string.
 *
 * Returns null when yesterday was zero rather than "+100%": a platform's first
 * day of trading is not a hundred percent improvement on nothing, and a growth
 * figure that is structurally meaningless teaches the reader to skip the line.
 */
function deltaLabel(current, previous) {
  if (!previous || previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return '±0%';
  return pct > 0 ? `▲ ${pct}%` : `▼ ${Math.abs(pct)}%`;
}

/**
 * Compose the pulse.
 *
 * Returns HTML for parse_mode: 'HTML'. Shop names are owner-entered free text
 * and are escaped; every other value here is a number this process computed.
 *
 * Exported because the console's "send now" button renders the same report —
 * a preview that composes its message differently from the scheduled one is a
 * preview of something else.
 */
async function buildPulseMessage(dateStr = getBangladeshTodayStr()) {
  const { escapeHtml } = require('../utils/telegramFormat.util');
  const data = await collectPulseData(dateStr);

  const revenueDelta = deltaLabel(data.revenue, data.priorRevenue);
  const invoiceDelta = deltaLabel(data.invoices, data.priorInvoices);

  const lines = [
    '📊 <b>হিসাব — প্ল্যাটফর্ম রিপোর্ট</b>',
    `📅 ${formatDate(data.dateStr)} · ${getBangladeshTimeStr()} পর্যন্ত`,
    '',
    '<b>আজকের বৃদ্ধি</b>',
    `🆕 নতুন দোকান: <b>${formatCount(data.newShopsToday)}</b>`,
    `👥 নতুন ইউজার: <b>${formatCount(data.newUsersToday)}</b>`,
    '',
    '<b>আজকের লেনদেন</b>',
    `🏪 সক্রিয় দোকান: <b>${formatCount(data.tradingShops)}</b> / ${formatCount(data.totalShops)}`,
    `🧾 ইনভয়েস: <b>${formatCount(data.invoices)}</b>${invoiceDelta ? ` <i>${invoiceDelta}</i>` : ''}`,
    `💰 মোট বিক্রয়: <b>${formatMoney(data.revenue)}</b>${revenueDelta ? ` <i>${revenueDelta}</i>` : ''}`,
    '',
    '<b>প্ল্যাটফর্মের আয়</b>',
    `💵 আজ জমা: <b>${formatMoney(data.platformIncome)}</b>` +
      `${data.platformIncomeCount ? ` (${formatCount(data.platformIncomeCount)} টি)` : ''}`,
    `✅ চালু সাবস্ক্রিপশন: <b>${formatCount(data.activeSubs)}</b>`,
    `⛔ মেয়াদ শেষ: <b>${formatCount(data.expiredSubs)}</b>`,
  ];

  if (data.expiringSoon.length) {
    lines.push('', `<b>⏳ ${EXPIRY_HORIZON_DAYS} দিনের মধ্যে মেয়াদ শেষ</b>`);
    for (const shop of data.expiringSoon) {
      const on = shop.subscription?.expiresAt
        ? formatDate(new Date(shop.subscription.expiresAt).toISOString().slice(0, 10))
        : '—';
      lines.push(`• ${escapeHtml(shop.name)} — ${on}`);
    }
  }

  return lines.join('\n');
}

/** Bangladesh minutes-since-midnight, right now. */
function currentBdMinutes() {
  return minutesOfDay(getBangladeshTimeStr());
}

/**
 * One tick. Finds the operators whose send time has arrived, claims the date
 * for each, and sends.
 */
async function tick() {
  // Overlap guard. A slow tick must not have the next one start on top of it —
  // the claim makes a duplicate send impossible, but two overlapping sweeps
  // would still double the queries.
  if (running) return;
  if (!telegramService.isEnabled()) return;

  running = true;
  try {
    const nowMinutes = currentBdMinutes();
    const dateStr = getBangladeshTodayStr();

    const links = await AdminTelegramLink.find({
      isActive: true,
      [`preferences.${ALERT_KEYS.DAILY_PULSE}`]: true,
      lastPulseSentFor: { $ne: dateStr },
    })
      .select('admin telegramChatId preferences.pulseTime')
      .lean();

    // Filtered in memory rather than in the query: the audience is a handful of
    // operators, and expressing "within the catch-up window, wrapping at
    // midnight" as a Mongo predicate would be far harder to read than this is.
    const due = links.filter((link) => {
      const scheduled = minutesOfDay(link.preferences?.pulseTime || '09:00');
      if (scheduled === null) return false;
      const elapsed = nowMinutes - scheduled;
      return elapsed >= 0 && elapsed <= CATCHUP_MINUTES;
    });

    if (!due.length) return;

    // Composed once, outside the loop. Every operator gets the same platform
    // figures, so building it per-link would run the whole aggregation N times
    // to produce N identical strings.
    const message = await buildPulseMessage(dateStr);

    for (const link of due) {
      // Claim BEFORE sending. A failed send is recorded in the notification log
      // and visible in the console; a duplicate is two different reports.
      const claimed = await AdminTelegramLink.claimPulse(link._id, dateStr);
      if (!claimed) continue;

      await telegramService.safeSend(link.telegramChatId, message, {
        eventType: 'platform_pulse',
        adminId: link.admin,
      });

      await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
    }

    logger.info(`Platform pulse: sent for ${dateStr} to ${due.length} operator(s)`);
  } catch (error) {
    logger.error(`Platform pulse job error — ${error.message}`);
  } finally {
    running = false;
  }
}

function startPulseJob() {
  if (timerHandle) return;
  timerHandle = setInterval(() => { tick(); }, TICK_INTERVAL_MS);
  // Do not hold the event loop open on this alone — the HTTP server is what
  // keeps the process alive, and an interval that prevents exit turns a clean
  // shutdown into a forced kill.
  timerHandle.unref?.();
  logger.info('Platform pulse job started (ticks every minute)');
}

function stopPulseJob() {
  if (!timerHandle) return;
  clearInterval(timerHandle);
  timerHandle = null;
}

module.exports = {
  startPulseJob,
  stopPulseJob,
  buildPulseMessage,
  collectPulseData,
};

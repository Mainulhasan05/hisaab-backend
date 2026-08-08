/**
 * Daily sales digest over Telegram.
 *
 * Ticks every minute and sends each connected owner one message at their
 * configured Bangladesh local time (22:00 by default): today's invoice count,
 * total sales and total profit, broken down by branch for multi-branch shops.
 *
 * The point of the feature is that the owner does not have to open the app —
 * the cashier runs the till, the owner gets the numbers. So the job is built
 * around never sending a wrong or duplicate figure: the date is claimed
 * atomically before the message is composed, and a failed send is recorded
 * rather than retried into a second delivery.
 */

const TelegramLink = require('../models/TelegramLink.model');
const Shop = require('../models/Shop.model');
const reportService = require('../services/report.service');
const telegramService = require('../services/telegram.service');
const logger = require('../utils/logger.util');
const {
  getBangladeshTodayStr,
  getBangladeshTimeStr,
  minutesOfDay,
} = require('../utils/bdTime.util');
const {
  escapeHtml,
  formatMoney,
  formatCount,
  formatDate,
  formatTime,
} = require('../utils/telegramFormat.util');

const TICK_INTERVAL_MS = 60 * 1000;

/**
 * How late a digest may still go out. If the process was down at 22:00 and
 * comes back at 22:40 the owner should still get their day. Past this window
 * the message is skipped entirely — a sales report landing at 2 AM is noise,
 * and tomorrow's will arrive on time.
 */
const CATCHUP_MINUTES = 180;

// Telegram's global ceiling is ~30 messages/second. 10/s leaves generous
// headroom, and a nightly sweep has no reason to run near a rate limit.
const SEND_GAP_MS = 100;

let timerHandle = null;
let running = false;

/**
 * Compose the digest for one shop.
 *
 * Returns HTML for parse_mode: 'HTML'. Every interpolated shop and branch name
 * is escaped — these are owner-entered free text.
 */
function buildMessage({ shopName, totals, asOfTime, multiBranch }) {
  const header =
    `🏪 <b>${escapeHtml(shopName)}</b> — দৈনিক হিসাব\n` +
    `📅 ${formatDate(totals.date)} · ${formatTime(asOfTime)} পর্যন্ত`;

  if (totals.total.count === 0) {
    // A zero day is information, not a reason to stay silent: an owner who was
    // away needs to know the till did not ring.
    return `${header}\n\n🧾 আজ কোনো বিক্রয় হয়নি।`;
  }

  const summary =
    `🧾 মোট ইনভয়েস: <b>${formatCount(totals.total.count)}</b>\n` +
    `💰 মোট বিক্রয়: <b>${formatMoney(totals.total.revenue)}</b>\n` +
    `📈 মোট লাভ: <b>${formatMoney(totals.total.profit)}</b>`;

  if (!multiBranch || totals.byBranch.length <= 1) {
    return `${header}\n\n${summary}`;
  }

  const branchLines = totals.byBranch
    .map(
      (b) =>
        `• ${escapeHtml(b.name)} — ${formatCount(b.count)} · ` +
        `${formatMoney(b.revenue)} · ${formatMoney(b.profit)}`
    )
    .join('\n');

  return (
    `${header}\n\n${summary}\n\n` +
    '🏬 <b>শাখা অনুযায়ী</b>\n' +
    '<i>(ইনভয়েস · বিক্রয় · লাভ)</i>\n' +
    branchLines
  );
}

/** True when `now` has passed `digestTime` but is still inside the catch-up window. */
function isDue(digestTime, nowMinutes) {
  // Fall back rather than bail out: a link whose digestTime is somehow missing
  // should still get its digest at the default hour, not silently never again.
  const scheduled = minutesOfDay(digestTime || '22:00');
  if (scheduled === null) return false;
  const elapsed = nowMinutes - scheduled;
  return elapsed >= 0 && elapsed <= CATCHUP_MINUTES;
}

async function sendDigestForLink(link, shop, dateStr, asOfTime) {
  const totals = await reportService.getDigestTotals(shop._id, dateStr, {
    multiBranch: shop.multiBranchEnabled === true,
  });

  const message = buildMessage({
    shopName: shop.name,
    totals,
    asOfTime,
    multiBranch: shop.multiBranchEnabled === true,
  });

  await telegramService.safeSend(link.telegramChatId, message, {
    eventType: 'daily_summary',
    shopId: shop._id,
    userId: link.user,
  });
}

async function runTick() {
  if (running) return; // a slow sweep must not overlap the next tick
  if (!telegramService.isEnabled()) return;

  running = true;
  try {
    const dateStr = getBangladeshTodayStr();
    const nowTime = getBangladeshTimeStr();
    const nowMinutes = minutesOfDay(nowTime);

    // ── Narrow by send window BEFORE querying ────────────────────────────────
    //
    // This used to fetch every active link with `lastDigestSentFor: { $ne }`
    // and filter in memory. `$ne` is not selectively indexable, so the index on
    // {isActive, preferences.dailySummary} narrowed only the first two terms
    // and the tick read every linked shop on the platform — once a minute,
    // around the clock, to send a few hundred messages a day
    // (PERFORMANCE_AUDIT.md M-5).
    //
    // Only a link whose digestTime falls inside the catch-up window can be due,
    // and digestTime is a fixed 'HH:MM' string. Enumerating the minutes in that
    // window and matching with `$in` is an indexable predicate that cuts the
    // candidate set to the shops that could actually fire on this tick.
    //
    // `isDue` still runs below and remains the authority — this is a
    // pre-filter, not a reimplementation of the rule.
    //
    // Deliberately does NOT wrap backwards over midnight, because `isDue` does
    // not either: its `elapsed >= 0` test means a 23:30 digest is simply missed
    // if the process was down until 00:15, rather than going out in the small
    // hours ("never treats a pre-midnight time as due from the small hours" —
    // telegramDigest.test.js). Wrapping here would only fetch candidates that
    // `isDue` then discards.
    const dueTimes = [];
    for (let elapsed = 0; elapsed <= CATCHUP_MINUTES; elapsed++) {
      const scheduled = nowMinutes - elapsed;
      if (scheduled < 0) break;
      dueTimes.push(
        `${String(Math.floor(scheduled / 60)).padStart(2, '0')}:${String(scheduled % 60).padStart(2, '0')}`
      );
    }

    // A link with NO digestTime still gets its digest at the default hour —
    // `isDue` does `minutesOfDay(digestTime || '22:00')` for documents that
    // predate the field, and dropping them here would silently retire them.
    // So when 22:00 is inside the window, the query has to reach the missing
    // ones too. `{ $in: [null] }` matches null AND absent in MongoDB.
    const timeClauses = [{ 'preferences.digestTime': { $in: dueTimes } }];
    if (dueTimes.includes('22:00')) {
      timeClauses.push({ 'preferences.digestTime': { $in: [null, ''] } });
    }

    const candidates = await TelegramLink.find({
      isActive: true,
      'preferences.dailySummary': true,
      lastDigestSentFor: { $ne: dateStr },
      $or: timeClauses,
    }).lean();

    const due = candidates.filter((link) => isDue(link.preferences?.digestTime, nowMinutes));
    if (due.length === 0) return;

    // One query for every shop involved, rather than one per link.
    const shopIds = [...new Set(due.map((l) => String(l.shop)))];
    const shops = await Shop.find({ _id: { $in: shopIds } })
      .select('name multiBranchEnabled isActive')
      .lean();
    const shopById = new Map(shops.map((s) => [String(s._id), s]));

    let sent = 0;
    let skipped = 0;

    for (const link of due) {
      const shop = shopById.get(String(link.shop));

      // A shop switched off by the platform admin stops receiving everything.
      // An *expired* shop still gets its digest — the data is real and the
      // message is the cheapest renewal reminder there is.
      if (!shop || shop.isActive === false) {
        skipped++;
        continue;
      }

      // Claim first. If another tick (or a restart mid-sweep) already took
      // today, this returns null and we move on rather than sending twice.
      const claimed = await TelegramLink.claimDigest(link._id, dateStr);
      if (!claimed) {
        skipped++;
        continue;
      }

      try {
        await sendDigestForLink(link, shop, dateStr, nowTime);
        sent++;
      } catch (error) {
        // safeSend never throws, so reaching here means the aggregation failed.
        // The day stays claimed: re-running would risk a second message, and a
        // missing digest is recoverable while contradictory figures are not.
        logger.error(`DailyDigest: shop ${shop._id} failed — ${error.message}`);
      }

      if (SEND_GAP_MS) {
        await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
      }
    }

    if (sent || skipped) {
      logger.info(`DailyDigest: ${sent} sent, ${skipped} skipped (${dateStr} ${nowTime})`);
    }
  } catch (error) {
    logger.error(`DailyDigest: tick failed — ${error.message}`);
  } finally {
    running = false;
  }
}

function startDigestJob() {
  if (timerHandle) return;
  logger.info('Initializing Telegram daily digest job (1-minute tick)...');
  timerHandle = setInterval(runTick, TICK_INTERVAL_MS);
  timerHandle.unref();
}

function stopDigestJob() {
  if (!timerHandle) return;
  clearInterval(timerHandle);
  timerHandle = null;
}

module.exports = {
  startDigestJob,
  stopDigestJob,
  // Exported for tests and for the "send me a test digest" admin action.
  runTick,
  buildMessage,
  isDue,
};

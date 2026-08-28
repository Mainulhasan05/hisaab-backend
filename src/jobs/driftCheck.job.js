/**
 * Nightly rollup drift check — the third part of the F4 fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every stored rollup in this system has a hand-run repair script:
 *
 *   recalc-account-balances.js     PaymentAccount.balance
 *   recalc-customer-balances.js    Customer / CustomerBalance
 *   recalc-supplier-balances.js    Supplier / SupplierBalance
 *
 * Each one derives its figures from source documents — Sale, Payment,
 * SalesReturn, DueAdjustment, Purchase — rather than from the rollup it is
 * checking, so each is a genuine second opinion. And each already exits non-zero
 * when the invariant is broken.
 *
 * All of which was only useful to someone who remembered to run them. The
 * ৳17,920 supplier overstatement in হিসাব ফ্যাশন গ্যালারী was found by a person
 * reading a statement, not by the system — and by then it had been wrong for
 * long enough that nobody could say which write path did it.
 *
 * Drift is silent by nature: every screen agrees with the rollup, because every
 * screen READS the rollup. The only thing that disagrees is arithmetic nobody
 * runs. This runs it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFY ONLY — IT NEVER WRITES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No `--apply`, ever, and that is not caution for its own sake. A mismatch means
 * a WRITE PATH updates one book and not the other; rewriting the rollup would
 * hide the bug and leave it to keep producing new drift every day. Both scripts
 * say so in their own headers, and `--repair-customers` is off by default for
 * exactly this reason.
 *
 * So this job's whole job is to notice and to tell someone. The repair stays a
 * deliberate human act, taken after reading what drifted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CHILD PROCESS RATHER THAN AN IMPORT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The scripts are CLI programs: they open their own Mongoose connection, print a
 * report, close it, and `process.exit()` with the verdict. Requiring one into
 * this process would kill the API server on the first drift found.
 *
 * Spawning is also what keeps the check honest. The thing being scheduled is
 * exactly the command an operator would type, so a fix verified by hand and a
 * fix verified nightly cannot drift apart — which is the failure this file is
 * about, applied to itself.
 */

const path = require('path');
const { execFile } = require('child_process');
const logger = require('../utils/logger.util');
const platformNotify = require('../services/platformNotify.service');
const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

/** Tick every minute, like the digest and pulse jobs, and act on the hour. */
const TICK_INTERVAL_MS = 60 * 1000;

/**
 * 03:00 Bangladesh time.
 *
 * After midnight, so a day's trading is complete and the figures are settled;
 * well before the 09:00 platform pulse, so an operator reading their morning
 * report has already been told if something is wrong. It is also the quietest
 * hour on the cluster, which matters because each script walks every shop.
 */
const RUN_AT_HOUR_BD = 3;

/**
 * Each script gets its own ceiling. They are full-collection walks and the
 * platform grows; a hung one must not sit on a Mongo cursor until the next
 * restart.
 */
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The three, with the flags that make each read-only.
 *
 * `recalc-account-balances` has no `--verify-only` switch — its dry-run IS the
 * verification, and it exits non-zero on drift either way. Passing a flag it
 * does not know would be silently ignored rather than refused, so it is left
 * off with the reason written down instead.
 */
const CHECKS = [
  { name: 'account balances', script: 'recalc-account-balances.js', args: [] },
  { name: 'customer balances', script: 'recalc-customer-balances.js', args: ['--verify-only'] },
  { name: 'supplier balances', script: 'recalc-supplier-balances.js', args: ['--verify-only'] },
];

let timerHandle = null;
/** The BD date string of the last run, so a restart cannot re-run the same night. */
let lastRunDate = null;

/**
 * Run one script and report how it went.
 *
 * Never rejects. A check that could throw would abandon the two after it, and
 * "the supplier check did not run" is precisely the state this job exists to
 * make impossible.
 */
function runCheck({ name, script, args }) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', script);

    execFile(
      process.execPath,
      [scriptPath, ...args],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Exit 0 = the invariant holds.
        if (!error) return resolve({ name, ok: true });

        // `killed` means the timeout fired. Distinguished from real drift
        // because the answer is different: one is a data problem, the other is
        // a "this script now takes more than ten minutes" problem.
        if (error.killed) {
          return resolve({ name, ok: false, timedOut: true, detail: `timed out after ${SCRIPT_TIMEOUT_MS / 60000}m` });
        }

        // The scripts print their findings to stdout and a one-line verdict to
        // stderr. The last few lines of each carry the counts, which is what an
        // operator needs to decide whether to look now or after breakfast.
        const tail = (text) => String(text || '').trim().split('\n').slice(-6).join('\n');
        resolve({
          name,
          ok: false,
          detail: [tail(stderr), tail(stdout)].filter(Boolean).join('\n') || `exit ${error.code}`,
        });
      }
    );
  });
}

/**
 * One nightly pass over all three.
 *
 * Sequential, not parallel. Each script walks every shop's sales history, and
 * three of those at once on the same cluster at 3am is how a nightly check
 * becomes the reason the morning is slow.
 *
 * Exported for the tests and for an operator who wants to trigger it by hand.
 */
async function runDriftCheck() {
  logger.info('[DriftCheck] Starting nightly rollup verification...');

  const results = [];
  for (const check of CHECKS) {
    results.push(await runCheck(check));
  }

  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    // Info, not silence: "the check ran and found nothing" and "the check did
    // not run" have to be distinguishable in the logs, or a job that quietly
    // stopped firing looks exactly like a clean bill of health.
    logger.info('[DriftCheck] All rollups reconcile.');
    return { ok: true, results };
  }

  for (const f of failed) {
    logger.error(`[DriftCheck] ${f.name} FAILED:\n${f.detail}`);
  }

  /**
   * Tell the founder channel.
   *
   * `urgent: true` so it rides the SECURITY switch rather than the routine
   * activity one — an operator who muted admin chatter still needs to hear that
   * the shop ledgers stopped adding up. Money that has silently drifted is not
   * a thing to find out about at the end of the month.
   */
  platformNotify.adminActivity({
    title: 'Rollup drift detected',
    lines: [
      ...failed.map((f) => `❌ <b>${f.name}</b>${f.timedOut ? ' — ' + f.detail : ''}`),
      '',
      'Run the matching <code>scripts/recalc-*.js</code> to see what drifted.',
      'Do NOT --apply before finding the write path that caused it.',
    ],
    urgent: true,
  });

  return { ok: false, results };
}

/** Has the 03:00 BD slot passed today, and have we not run for it yet? */
function shouldRunNow(now = new Date()) {
  const today = getBangladeshTodayStr();
  if (lastRunDate === today) return false;

  const { startOfDay } = getBangladeshDayRange(today);
  const dueAt = startOfDay.getTime() + RUN_AT_HOUR_BD * 60 * 60 * 1000;
  return now.getTime() >= dueAt;
}

async function tick() {
  if (!shouldRunNow()) return;

  // Claimed BEFORE the work, not after. A pass takes minutes; marking it done
  // afterwards would let the next tick start a second one on top of the first.
  lastRunDate = getBangladeshTodayStr();

  try {
    await runDriftCheck();
  } catch (err) {
    logger.error(`[DriftCheck] Pass failed: ${err.message}`);
  }
}

/**
 * Start the nightly check.
 *
 * Primary worker only, like every other job here — and here the reason has
 * teeth rather than being merely wasteful: N workers would each spawn three
 * full-history walks against the same cluster at the same minute.
 */
function startDriftCheckJob() {
  if (timerHandle) return;

  // A process that boots AFTER 03:00 must not immediately run yesterday's
  // check, so the first slot is treated as already served. Otherwise every
  // afternoon deploy would kick off three collection walks during trading.
  lastRunDate = getBangladeshTodayStr();

  logger.info(`Initializing nightly rollup drift check (0${RUN_AT_HOUR_BD}:00 BD)...`);
  timerHandle = setInterval(() => { tick(); }, TICK_INTERVAL_MS);
  timerHandle.unref();
}

function stopDriftCheckJob() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    logger.info('Stopped nightly rollup drift check.');
  }
}

module.exports = {
  startDriftCheckJob,
  stopDriftCheckJob,
  runDriftCheck,
  shouldRunNow,
  CHECKS,
  RUN_AT_HOUR_BD,
  // Test seam: `shouldRunNow` reads module state, and a test that could not
  // reset it would pass or fail depending on the order the suite ran in.
  _setLastRunDate: (d) => { lastRunDate = d; },
};

/**
 * The nightly rollup drift check.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * Every stored rollup here has a repair script that derives its figures from
 * source documents rather than from the rollup, and each already exits non-zero
 * when the invariant breaks. All of which only helped someone who remembered to
 * run them — the ৳17,920 supplier overstatement was found by a person reading a
 * statement, by which time nobody could say which write path caused it.
 *
 * Drift is silent by construction: every screen agrees with the rollup because
 * every screen READS the rollup. The only thing that disagrees is arithmetic
 * nobody runs.
 *
 * ── What these tests pin ────────────────────────────────────────────────────
 *
 *   A. IT NEVER WRITES — no `--apply` reaches any script, ever. A repair would
 *      hide the write-path bug that caused the drift.
 *   B. IT ALWAYS FINISHES — one failing check must not abandon the two after it.
 *   C. IT TELLS SOMEONE — silence on drift is the whole failure being fixed.
 *   D. THE SCHEDULE — once per Bangladesh day, and a mid-afternoon deploy must
 *      not kick off three full-history walks during trading.
 */

jest.mock('../services/platformNotify.service', () => ({
  adminActivity: jest.fn(),
}));

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const { execFile } = require('child_process');
const platformNotify = require('../services/platformNotify.service');
const {
  runDriftCheck,
  shouldRunNow,
  CHECKS,
  RUN_AT_HOUR_BD,
  _setLastRunDate,
} = require('../jobs/driftCheck.job');
const { getBangladeshTodayStr, getBangladeshDayRange } = require('../utils/bdTime.util');

/**
 * Make every spawned script answer a given way.
 *
 * `verdicts` maps a script filename fragment to `null` (exit 0) or an Error
 * shaped like the one `execFile` hands back on a non-zero exit.
 */
const stubScripts = (verdicts = {}) => {
  execFile.mockImplementation((_node, argv, _opts, cb) => {
    const scriptPath = argv[0];
    const key = Object.keys(verdicts).find((k) => scriptPath.includes(k));
    const verdict = key ? verdicts[key] : null;
    // Async, like the real thing — a synchronous callback would let a bug in
    // the sequencing pass unnoticed.
    setImmediate(() => cb(verdict, 'stdout tail\nDrifted: 3', verdict ? 'Balances drifted.' : ''));
  });
};

const exitErr = (code = 1) => Object.assign(new Error(`exit ${code}`), { code });

afterEach(() => jest.clearAllMocks());

// ── A. It never writes ──────────────────────────────────────────────────────

describe('A · the check is read-only, always', () => {
  it('passes --apply to nothing', async () => {
    // THE ONE THAT MATTERS. A mismatch means a write path updates one book and
    // not the other. Rewriting the rollup would hide that bug and leave it
    // producing fresh drift every day — which is why both scripts default
    // `--repair-customers` off and say so in their own headers.
    stubScripts();
    await runDriftCheck();

    for (const call of execFile.mock.calls) {
      const argv = call[1];
      expect(argv).not.toContain('--apply');
      expect(argv).not.toContain('--repair-customers');
    }
  });

  it('runs all three rollup scripts', async () => {
    stubScripts();
    await runDriftCheck();

    const spawned = execFile.mock.calls.map((c) => c[1][0]);
    expect(spawned).toHaveLength(CHECKS.length);
    expect(spawned.some((p) => p.includes('recalc-account-balances.js'))).toBe(true);
    expect(spawned.some((p) => p.includes('recalc-customer-balances.js'))).toBe(true);
    expect(spawned.some((p) => p.includes('recalc-supplier-balances.js'))).toBe(true);
  });

  it('asks the two that support it for verify-only', async () => {
    stubScripts();
    await runDriftCheck();

    const argvFor = (frag) => execFile.mock.calls.find((c) => c[1][0].includes(frag))[1];
    expect(argvFor('recalc-customer-balances.js')).toContain('--verify-only');
    expect(argvFor('recalc-supplier-balances.js')).toContain('--verify-only');
    // `recalc-account-balances` has no such switch — its dry-run IS the check,
    // and an unknown flag would be silently ignored rather than refused.
    expect(argvFor('recalc-account-balances.js')).toEqual([expect.any(String)]);
  });
});

// ── B. It always finishes ───────────────────────────────────────────────────

describe('B · one bad check never abandons the rest', () => {
  it('runs every script even when the first one fails', async () => {
    // "The supplier check did not run" is precisely the state this job exists
    // to make impossible, so a failure must not short-circuit the loop.
    stubScripts({ 'recalc-account-balances.js': exitErr() });

    const { ok, results } = await runDriftCheck();

    expect(ok).toBe(false);
    expect(results).toHaveLength(3);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('reports a timeout differently from drift', async () => {
    // Different problems, different answers: one is bad data, the other is
    // "this script now takes more than ten minutes". Collapsing them would send
    // an operator hunting for a write-path bug that does not exist.
    stubScripts({
      'recalc-supplier-balances.js': Object.assign(new Error('killed'), { killed: true, code: null }),
    });

    const { results } = await runDriftCheck();
    const supplier = results.find((r) => r.name === 'supplier balances');

    expect(supplier.ok).toBe(false);
    expect(supplier.timedOut).toBe(true);
  });

  it('runs them one at a time, not three at once', async () => {
    // Each walks every shop's history. Three concurrently on the same cluster
    // at 3am is how a nightly check becomes the reason the morning is slow.
    let inFlight = 0;
    let peak = 0;
    execFile.mockImplementation((_node, _argv, _opts, cb) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setImmediate(() => { inFlight -= 1; cb(null, '', ''); });
    });

    await runDriftCheck();
    expect(peak).toBe(1);
  });
});

// ── C. It tells someone ─────────────────────────────────────────────────────

describe('C · drift is announced, not just logged', () => {
  it('alerts the founder channel, urgently', async () => {
    stubScripts({ 'recalc-supplier-balances.js': exitErr() });

    await runDriftCheck();

    expect(platformNotify.adminActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/drift/i),
        // Rides the SECURITY switch rather than routine admin chatter — an
        // operator who muted the latter still needs to hear that the ledgers
        // stopped adding up.
        urgent: true,
      })
    );
    const { lines } = platformNotify.adminActivity.mock.calls[0][0];
    expect(lines.join('\n')).toContain('supplier balances');
    // The alert must say what NOT to do, because --apply is the tempting move
    // and it is the wrong one.
    expect(lines.join('\n')).toMatch(/do not --apply/i);
  });

  it('stays quiet when everything reconciles', async () => {
    stubScripts();

    const { ok } = await runDriftCheck();

    expect(ok).toBe(true);
    expect(platformNotify.adminActivity).not.toHaveBeenCalled();
  });
});

// ── D. The schedule ─────────────────────────────────────────────────────────

describe('D · once per Bangladesh day, at 03:00', () => {
  const at = (hourBd) =>
    new Date(getBangladeshDayRange(getBangladeshTodayStr()).startOfDay.getTime() + hourBd * 3600 * 1000);

  it('does not run before the hour', () => {
    _setLastRunDate(null);
    expect(shouldRunNow(at(RUN_AT_HOUR_BD - 1))).toBe(false);
  });

  it('runs at the hour', () => {
    _setLastRunDate(null);
    expect(shouldRunNow(at(RUN_AT_HOUR_BD))).toBe(true);
  });

  it('does not run twice in one day', () => {
    // The pass takes minutes and the tick is every minute, so the day is
    // claimed BEFORE the work — otherwise the second tick starts a second pass
    // on top of the first.
    _setLastRunDate(getBangladeshTodayStr());
    expect(shouldRunNow(at(RUN_AT_HOUR_BD + 5))).toBe(false);
  });

  it('a process booting after 03:00 does not immediately run', () => {
    // `startDriftCheckJob` claims today's slot at boot. Without that, every
    // afternoon deploy would kick off three full-history collection walks
    // during trading hours.
    _setLastRunDate(getBangladeshTodayStr());
    expect(shouldRunNow(at(15))).toBe(false);
  });
});

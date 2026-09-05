/**
 * PayStation preflight — prove the whole chain works BEFORE a real shop pays.
 *
 *   node scripts/paystation-preflight.js            # read-only checks
 *   node scripts/paystation-preflight.js --probe    # + a real ৳1 gateway call
 *   node scripts/paystation-preflight.js --enable   # + switch the feature on
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Self-serve billing has TWO switches, deliberately: the gateway credentials in
 * the environment, and `PlatformSetting.billingProvider` in the database. That
 * split is what lets the config be deployed on Monday and the feature turned on
 * on Tuesday — but it also means "I added the env values" is not the same as
 * "it works", and the difference is invisible from the outside. An owner would
 * simply keep seeing the "call us" card, with nothing anywhere saying why.
 *
 * There are four more things that are individually easy to miss and each of
 * which breaks the flow completely:
 *
 *   · the two public URLs must be reachable ORIGINS. PayStation resolves the
 *     callback from the public internet, so a localhost value means every
 *     payment succeeds at the bank and lands nowhere.
 *   · `PlatformOrder`'s indexes only exist in production once `sync-indexes`
 *     has run — autoIndex is off there.
 *   · the subscription packages have to actually be present, or the owner's
 *     page offers a single fallback month.
 *   · the SMS rate has to be set, or top-ups are refused at the last step.
 *
 * Read-only unless you pass `--enable`. Safe to run against production.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const results = [];
const record = (level, name, detail) => {
  results.push({ level, name, detail });
  const tag = level === 'ok' ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? `\n        ${detail}` : ''}`);
};
const ok = (n, d) => record('ok', n, d);
const warn = (n, d) => record('warn', n, d);
const fail = (n, d) => record('fail', n, d);

async function main() {
  const probe = process.argv.includes('--probe');
  const enable = process.argv.includes('--enable');
  // Enabling while pointed at the SANDBOX would let any shop renew for free:
  // sandbox checkouts complete without real money, and fulfilment cannot tell
  // the difference. So it takes a second, deliberate flag.
  const sandboxOverride = process.argv.includes('--i-know-its-sandbox');

  let pendingEnable = null;
  let alreadyEnabled = false;

  console.log('\nPayStation preflight\n' + '─'.repeat(60));

  /* ── 1. Environment ─────────────────────────────────────────────────────── */

  const env = process.env;
  const merchantId = env.PAYSTATION_MERCHANT_ID;
  const password = env.PAYSTATION_PASSWORD;

  if (!merchantId) {
    fail('PAYSTATION_MERCHANT_ID is not set',
      'Nothing else can work. The owner-facing checkout stays hidden and billing is keyed in by hand.');
  } else {
    ok('PAYSTATION_MERCHANT_ID is set', `${merchantId.slice(0, 4)}…${merchantId.slice(-4)}`);
  }
  if (!password) {
    fail('PAYSTATION_PASSWORD is not set',
      'The server boots and refuses to boot with a merchant id but no password — see config/env.js.');
  } else {
    ok('PAYSTATION_PASSWORD is set');
  }

  /* PayStation's public sandbox demo account, from their Postman collection.
   *
   * Checked explicitly because the mismatch it causes is silent until a real
   * customer hits it: `PAYSTATION_ENV=live` points the adapter at the
   * production host, which answers these credentials with `1001 Invalid
   * Credential.` — so every renewal fails at the gateway while the settings
   * screen shows the feature switched happily on. */
  const SANDBOX_DEMO_MERCHANT = '104-1653730183';

  const environment = env.PAYSTATION_ENV === 'live' ? 'live' : 'sandbox';

  if (merchantId === SANDBOX_DEMO_MERCHANT && environment === 'live') {
    fail('Sandbox demo credentials with PAYSTATION_ENV=live',
      `${SANDBOX_DEMO_MERCHANT} is PayStation's public demo account. Against the live host it returns `
      + '"1001 Invalid Credential." — every renewal would fail at the gateway. '
      + 'Use your own merchant id and password, or set PAYSTATION_ENV=sandbox for testing.');
  } else if (merchantId === SANDBOX_DEMO_MERCHANT) {
    warn('Using PayStation\'s sandbox demo credentials',
      'Fine for testing the flow; no real money moves. Swap in your own merchant account before going live.');
  }

  if (environment === 'sandbox' && enable && !sandboxOverride) {
    // The dangerous combination, and not an obvious one: a sandbox checkout
    // completes without money changing hands, and nothing downstream can tell a
    // sandbox success from a live one. Enabling here hands every shop on the
    // platform a free renewal.
    fail('Refusing to enable while PAYSTATION_ENV is sandbox',
      'Sandbox payments complete without real money, so this would let any shop renew for free. '
      + 'Set PAYSTATION_ENV=live, or pass --i-know-its-sandbox if this is a test environment.');
  } else if (environment === 'sandbox') {
    warn('PAYSTATION_ENV is sandbox', 'Real customers cannot pay. Set it to `live` when you are ready.');
  } else {
    ok('PAYSTATION_ENV is live');
  }

  for (const key of ['API_PUBLIC_URL', 'APP_PUBLIC_URL']) {
    const value = env[key];
    if (!value) {
      fail(`${key} is not set`,
        key === 'API_PUBLIC_URL'
          ? 'PayStation has nowhere to return the customer, so no payment can ever be confirmed from the browser.'
          : 'Customers would be redirected nowhere after paying.');
      continue;
    }
    if (!/^https?:\/\//i.test(value)) {
      fail(`${key} is not an absolute URL`, value);
    } else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value)) {
      // Fatal in production and the single easiest thing to leave behind.
      fail(`${key} points at localhost`,
        `${value} — PayStation resolves this from the public internet. Every payment would succeed at the bank and land nowhere.`);
    } else if (environment === 'live' && value.startsWith('http://')) {
      warn(`${key} is not HTTPS`, value);
    } else {
      ok(`${key} looks reachable`, value);
    }
  }

  if (env.SKIP_PAYMENTS === 'true') {
    fail('SKIP_PAYMENTS is true',
      'Every checkout is simulated and every lookup reports success — this GRANTS SUBSCRIPTIONS FOR FREE. Never set it outside development.');
  }

  /* ── 2. The adapter, as the app will build it ──────────────────────────── */

  const { getAdapter } = require('../src/services/payment/paystation.adapter');
  const adapter = getAdapter();
  if (adapter.isConfigured()) {
    ok('Adapter reports configured', `${adapter.name} · ${adapter.env} · ${adapter.baseUrl}`);
  } else {
    fail('Adapter reports NOT configured', 'Checkout endpoints will refuse with 503.');
  }

  /* ── 3. A real gateway round-trip ──────────────────────────────────────── */

  if (probe && adapter.isConfigured()) {
    // The only true test of the credentials. `transaction-status` cannot do it:
    // PayStation answers both "bad token" and "no such transaction" with 2001,
    // so a lookup proves nothing. This opens a genuine ৳1 session, which is why
    // it is opt-in — it leaves one abandoned order in the PayStation dashboard.
    const invoice = `PREFLIGHT${Date.now().toString(36).toUpperCase()}`;
    try {
      const session = await adapter.initiatePayment({
        invoiceNumber: invoice,
        amount: 1,
        callbackUrl: `${String(env.API_PUBLIC_URL).replace(/\/+$/, '')}/api/public/payments/paystation/return/000000000000000000000000`,
        customer: { name: 'Preflight', phone: '01700000000' },
        reference: 'preflight',
      });
      ok('Gateway accepted a live payment session', session.paymentUrl);

      const status = await adapter.getTransactionStatus(invoice);
      ok('Gateway answered a status lookup', `trx_status=${status.status} (unpaid, as expected)`);
      if (status.status === 'success') {
        fail('An UNPAID probe reported success',
          'Something is very wrong with the verdict reading — do not enable this.');
      }
    } catch (err) {
      fail('Gateway rejected the probe', `${err.message} (code ${err.gatewayCode || 'n/a'})`);
    }
  } else if (!probe) {
    warn('Gateway not probed', 'Re-run with --probe to open a real ৳1 session and confirm the credentials.');
  }

  /* ── 4. Database state ─────────────────────────────────────────────────── */

  if (!env.MONGODB_URI) {
    fail('MONGODB_URI is not set', 'Skipping every database check.');
  } else {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
    console.log(`\n        connected to ${mongoose.connection.host}\n`);

    require('../src/models');
    const PlatformSetting = mongoose.model('PlatformSetting');
    const PlatformOrder = mongoose.model('PlatformOrder');

    const settings = await PlatformSetting.current();

    // The second switch — the one people miss. Reported here; actually FLIPPED
    // at the very end, once every other check has had its say. Enabling first
    // and discovering a blocking problem afterwards would switch the feature on
    // for every shop and then tell you it cannot work.
    alreadyEnabled = settings.billingProvider === 'paystation';
    if (alreadyEnabled) {
      ok('billingProvider is paystation', 'Owners will see the renew and top-up buttons.');
    } else if (!enable) {
      warn(`billingProvider is '${settings.billingProvider}'`,
        'Credentials alone are not enough — owners still see the "call us" card. Re-run with --enable, or change it on the admin Platform settings page.');
    }
    pendingEnable = enable && !alreadyEnabled ? settings : null;

    const packages = settings.subscriptionPackages || [];
    if (packages.length) {
      ok(`${packages.length} subscription packages configured`,
        packages.map((p) => `${p.months}mo ৳${p.price}`).join('  ·  '));
    } else {
      warn('No subscription packages configured',
        'The owner page falls back to a single one-month option at the standard rate.');
    }

    const smsRate = settings.defaultSmsUnitPrice;
    if (smsRate > 0) {
      const min = settings.minSmsPurchaseAmount ?? 100;
      ok('SMS rate configured', `৳${smsRate}/SMS · minimum ৳${min} = ${Math.floor(min / smsRate)} messages`);
    } else {
      fail('defaultSmsUnitPrice is not set', 'Every SMS top-up would be refused at the last step.');
    }

    if (settings.platformSmsCost === null || settings.platformSmsCost === undefined) {
      warn('platformSmsCost is not set',
        'Not fatal — but SMS margin is reported as "unpriced" rather than as a number.');
    }

    // Indexes. autoIndex is off in production, so these exist only if
    // `sync-indexes` has been run since PlatformOrder was added.
    const existing = await PlatformOrder.collection.indexes().catch(() => []);
    const keys = existing.map((i) => JSON.stringify(i.key));
    const wanted = [
      { key: '{"invoiceNumber":1}', why: 'the unique guard that stops a mint collision becoming a gateway 1008' },
      { key: '{"status":1,"createdAt":1}', why: "the reconciliation sweep's only query — without it, a collection scan every 5 minutes" },
      { key: '{"shop":1,"createdAt":-1}', why: "the owner's own payment history" },
    ];
    const missing = wanted.filter((w) => !keys.includes(w.key));
    if (!existing.length) {
      warn('PlatformOrder collection does not exist yet',
        'Normal before the first checkout — but run `npm run sync-indexes:apply` so its indexes are in place first.');
    } else if (missing.length) {
      fail(`${missing.length} PlatformOrder index(es) missing`,
        missing.map((m) => `${m.key} — ${m.why}`).join('\n        ') +
        '\n        Fix: npm run sync-indexes:apply');
    } else {
      ok('PlatformOrder indexes are in place');
    }

    // How much is already in flight, so a re-run after go-live is informative.
    const stuck = await PlatformOrder.countDocuments({ status: 'paid', fulfilmentClaimedAt: null });
    if (stuck > 0) {
      fail(`${stuck} order(s) are PAID but not fulfilled`,
        'These shops have been charged and have nothing to show for it. Open the Checkout orders page in the admin console.');
    }
    // Deliberately NOT disconnecting here — the deferred enable below still
    // needs the connection. It is closed after the verdict.
  }

  /* ── Verdict ───────────────────────────────────────────────────────────── */

  const failures = results.filter((r) => r.level === 'fail');
  const warnings = results.filter((r) => r.level === 'warn');

  /* The switch is thrown LAST, and only if nothing is broken.
   *
   * Ordering matters more than it looks: every check above is cheap and
   * read-only, and this is the one irreversible-ish action in the script. Doing
   * it first — as the obvious reading of "--enable" would — means a run that
   * ends in "3 indexes missing" has already switched self-serve billing on for
   * every shop on the platform. */
  if (pendingEnable) {
    if (failures.length) {
      console.log('');
      warn('NOT enabling billingProvider',
        `${failures.length} blocking problem(s) above. Fix them and run again.`);
    } else {
      pendingEnable.billingProvider = 'paystation';
      await pendingEnable.save();
      ok('billingProvider switched to paystation', 'Self-serve billing is now LIVE for every shop.');
    }
  }

  console.log('─'.repeat(60));
  if (failures.length) {
    console.log(`\n${failures.length} blocking problem(s). Self-serve billing will NOT work:\n`);
    failures.forEach((f) => console.log(`  · ${f.name}`));
    console.log('');
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
  console.log(`\nNo blocking problems${warnings.length ? `, ${warnings.length} thing(s) worth reading above` : ''}.`);
  console.log('Self-serve billing is ready.\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nPreflight crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

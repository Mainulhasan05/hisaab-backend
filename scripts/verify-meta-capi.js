#!/usr/bin/env node
/**
 * Meta Conversions API preflight.
 *
 *   node scripts/verify-meta-capi.js              # checks config + token, sends nothing
 *   node scripts/verify-meta-capi.js --send       # also posts one real TestEvent
 *
 * Diagnoses the common failure: a token copied from the Diagnostics tab, which
 * only carries `read_ads_dataset_quality` and cannot write events.
 */

require('dotenv').config();
const axios = require('axios');

const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
const TEST_CODE = process.env.META_TEST_EVENT_CODE;
const SHOULD_SEND = process.argv.includes('--send');

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`  • ${m}`);

const errorOf = (e) => e.response?.data?.error || { message: e.message };

async function main() {
  console.log('\nMeta Conversions API preflight\n' + '='.repeat(46));

  console.log('\n[1] Configuration');
  if (!PIXEL_ID) return bad('META_PIXEL_ID is not set') || process.exit(1);
  ok(`META_PIXEL_ID = ${PIXEL_ID}`);
  if (!TOKEN) return bad('META_CAPI_ACCESS_TOKEN is not set') || process.exit(1);
  ok(`META_CAPI_ACCESS_TOKEN = ${TOKEN.slice(0, 12)}…${TOKEN.slice(-6)} (${TOKEN.length} chars)`);
  info(`Graph version ${VERSION}${TEST_CODE ? ` | test_event_code ${TEST_CODE}` : ''}`);

  console.log('\n[2] Token identity');
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${VERSION}/me`, {
      params: { access_token: TOKEN }, timeout: 15000
    });
    ok(`Token resolves to id ${data.id}${data.name ? ` (${data.name})` : ''}`);
  } catch (e) {
    bad(`Token rejected: ${errorOf(e).message}`);
    process.exit(1);
  }

  console.log('\n[3] Granted permissions');
  let perms = [];
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${VERSION}/me/permissions`, {
      params: { access_token: TOKEN }, timeout: 15000
    });
    perms = (data.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
    perms.length ? perms.forEach((p) => info(p)) : info('(none reported)');
  } catch (e) {
    info(`Could not read permissions: ${errorOf(e).message}`);
  }

  // Informational only. A pixel-scoped CAPI token grants write access on the
  // dataset itself, which never shows up in /me/permissions — a token listing
  // nothing but `read_ads_dataset_quality` can still post events fine. Step 4
  // is the only trustworthy check.
  info('(this list does not reflect pixel-scoped CAPI grants — see step 4)');

  console.log('\n[4] Write access to the pixel');
  const probe = {
    data: [{
      event_name: 'TestEvent',
      event_time: Math.floor(Date.now() / 1000),
      event_id: `preflight-${Date.now()}`,
      action_source: 'website',
      event_source_url: process.env.FRONTEND_URL || 'https://hisaab.bd/',
      user_data: { client_ip_address: '103.108.140.1', client_user_agent: 'hisaab-capi-preflight/1.0' }
    }]
  };
  if (TEST_CODE) probe.test_event_code = TEST_CODE;

  if (!SHOULD_SEND) {
    info('Skipped — re-run with --send to post a real TestEvent.');
    console.log('\nDone. Config and token checked; no event was sent.\n');
    return;
  }

  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${VERSION}/${PIXEL_ID}/events`,
      probe,
      { params: { access_token: TOKEN }, timeout: 20000 }
    );
    if (data.events_received > 0) {
      ok(`Meta accepted ${data.events_received} event (fbtrace ${data.fbtrace_id})`);
      console.log('\nCAPI is live. Check Events Manager > Test Events.\n');
    } else {
      bad(`Accepted but events_received=0 — ${JSON.stringify(data)}`);
      process.exit(1);
    }
  } catch (e) {
    const err = errorOf(e);
    bad(`Write failed: ${err.message}`);
    if (err.error_subcode === 33) {
      info('Subcode 33 = the token has no permission on this pixel, or the');
      info('pixel belongs to a different Business than the token.');
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

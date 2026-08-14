/**
 * Restore a backup produced by scripts/backup-db.js into another database.
 *
 *   node scripts/restore-db.js --from ./backups/hisaabDB-... --uri "<target>" --dry-run
 *   node scripts/restore-db.js --from ./backups/hisaabDB-... --uri "<target>" --drop
 *
 * The target may also come from RESTORE_MONGODB_URI instead of --uri.
 *
 * Guard rails, in the order they fire:
 *  1. The target is never MONGODB_URI. Restoring onto production is the one
 *     mistake this script exists to make impossible, so a match is a hard stop
 *     (override deliberately with --i-know-this-is-production).
 *  2. --dry-run is the default posture in the docs: it verifies checksums and
 *     reports what would be written without opening a write.
 *  3. A non-empty target collection aborts the run unless --drop is passed.
 *
 * Restore ORDER matters and is not arbitrary:
 *   documents first, indexes second.
 * Four collections carry TTL indexes (auditlogs 90d, smslogs 60d,
 * notificationlogs 90d, invoicecounters 30d, telegramlinktokens expiresAt:0).
 * Creating those indexes before loading would arm the TTL reaper against
 * documents whose timestamps are already old, and it would quietly delete a
 * slice of the restore within a minute of finishing. Loading first means the
 * reaper only ever sees a fully-populated collection, and whatever it then
 * expires is data production would have expired too.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { MongoClient } = require('mongodb');
// EJSON lives in `bson` (a driver dependency), not in `mongodb` itself, since driver v6.
const { EJSON } = require('bson');

const BATCH = 500;

function has(flag) {
  return process.argv.includes(`--${flag}`);
}
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '<unparseable uri>';
  }
}
/** Identity of a deployment for the "is this production?" check: host + db, credentials ignored. */
function uriIdentity(uri) {
  try {
    const u = new URL(uri);
    return `${u.host.toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    return uri;
  }
}

async function main() {
  const dryRun = has('dry-run');
  const drop = has('drop');
  const from = arg('from');
  if (!from) throw new Error('Missing --from <backup directory>.');

  const dir = path.resolve(from);
  const manifestPath = path.join(dir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No _manifest.json in ${dir} — not a backup directory.`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const indexSpecs = JSON.parse(fs.readFileSync(path.join(dir, '_indexes.json'), 'utf8'));

  const target = arg('uri', process.env.RESTORE_MONGODB_URI);
  if (!target) {
    throw new Error('No target. Pass --uri "<target>" or set RESTORE_MONGODB_URI in .env.');
  }

  // Guard 1 — refuse to write onto the backup's own source deployment.
  if (process.env.MONGODB_URI && uriIdentity(target) === uriIdentity(process.env.MONGODB_URI)) {
    if (!has('i-know-this-is-production')) {
      throw new Error(
        `Target is the same host+database as MONGODB_URI (${safeUri(target)}).\n` +
        '       Restoring onto production would overwrite live data. Point --uri at the\n' +
        '       new database, or pass --i-know-this-is-production if that is truly the intent.'
      );
    }
    console.warn('WARNING: restoring onto MONGODB_URI itself, as explicitly requested.\n');
  }

  const only = arg('only');
  const onlySet = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const entries = manifest.collections.filter((c) => !onlySet || onlySet.has(c.name));

  console.log(`Backup : ${dir}`);
  console.log(`         taken ${manifest.createdAt} from ${manifest.source} (MongoDB ${manifest.serverVersion})`);
  console.log(`Target : ${safeUri(target)}`);
  console.log(`Mode   : ${dryRun ? 'DRY RUN — nothing will be written' : drop ? 'RESTORE (--drop: target collections are dropped first)' : 'RESTORE (append into empty collections only)'}\n`);

  // Verify integrity before touching the target at all — a truncated backup
  // should be caught while the target is still untouched, not halfway in.
  console.log('Verifying backup integrity...');
  let bad = 0;
  for (const c of entries) {
    const file = path.join(dir, c.file);
    if (!fs.existsSync(file)) {
      console.error(`  MISSING  ${c.file}`);
      bad++;
      continue;
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (sha !== c.sha256) {
      console.error(`  CORRUPT  ${c.file} — checksum mismatch`);
      bad++;
    }
  }
  if (bad) throw new Error(`${bad} backup file(s) missing or corrupt. Refusing to restore.`);
  console.log(`  ${entries.length} file(s) verified.\n`);

  const client = new MongoClient(target, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();
  console.log(`Connected to target database "${db.databaseName}".\n`);

  // Guard 3 — inspect the target before writing anything.
  const existing = new Map(
    (await db.listCollections().toArray()).map((c) => [c.name, c])
  );
  const occupied = [];
  for (const c of entries) {
    if (!existing.has(c.name)) continue;
    const n = await db.collection(c.name).countDocuments({}, { limit: 1 });
    if (n > 0) occupied.push(c.name);
  }
  if (occupied.length && !drop && !dryRun) {
    throw new Error(
      `Target already has documents in: ${occupied.join(', ')}.\n` +
      '       Pass --drop to replace them, or restore into an empty database.'
    );
  }
  if (occupied.length) {
    console.log(`${dryRun ? 'Would affect' : 'Will drop'} ${occupied.length} non-empty target collection(s): ${occupied.join(', ')}\n`);
  }

  if (dryRun) {
    const total = entries.reduce((s, c) => s + c.count, 0);
    console.log('Would restore:');
    for (const c of entries) {
      console.log(`  ${c.name.padEnd(24)} ${String(c.count).padStart(7)} docs  ${String(c.indexCount).padStart(3)} indexes`);
    }
    console.log(`\n${entries.length} collections, ${total} documents. Re-run without --dry-run to apply.`);
    await client.close();
    return;
  }

  // ---- Pass 1: documents ------------------------------------------------
  console.log('Restoring documents...');
  const results = [];
  for (const c of entries) {
    const coll = db.collection(c.name);
    if (drop && existing.has(c.name)) await coll.drop().catch(() => {});

    let inserted = 0;
    let failed = 0;
    let buf = [];

    const flush = async () => {
      if (!buf.length) return;
      const docs = buf;
      buf = [];
      try {
        // ordered:false so one bad document cannot abort the rest of the batch.
        const r = await coll.insertMany(docs, { ordered: false });
        inserted += r.insertedCount;
      } catch (err) {
        inserted += err.result?.insertedCount ?? err.insertedCount ?? 0;
        const errs = err.writeErrors || [];
        failed += errs.length || docs.length;
        for (const e of errs.slice(0, 3)) console.error(`    ! ${c.name}: ${e.errmsg || e.message}`);
      }
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, c.file), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      buf.push(EJSON.parse(line, { relaxed: false }));
      if (buf.length >= BATCH) await flush();
    }
    await flush();

    results.push({ name: c.name, expected: c.count, inserted, failed });
    const flag = inserted === c.count ? ' ' : '!';
    console.log(`  ${flag} ${c.name.padEnd(24)} ${String(inserted).padStart(7)} / ${c.count}${failed ? `  (${failed} failed)` : ''}`);
  }

  // ---- Pass 2: indexes (deliberately after the data — see the header) ----
  console.log('\nCreating indexes...');
  let created = 0;
  let idxFailed = 0;
  for (const c of entries) {
    const spec = indexSpecs[c.name];
    if (!spec) continue;
    const coll = db.collection(c.name);
    // _id_ is created implicitly and cannot be created explicitly.
    const wanted = spec.indexes.filter((i) => i.name !== '_id_');
    for (const i of wanted) {
      const { key, name, v, ns, background, ...opts } = i;
      try {
        await coll.createIndex(key, { name, ...opts });
        created++;
      } catch (err) {
        idxFailed++;
        console.error(`  ! ${c.name}.${name}: ${err.message}`);
      }
    }
  }
  console.log(`  ${created} index(es) created${idxFailed ? `, ${idxFailed} failed` : ''}.`);

  // ---- Verification ------------------------------------------------------
  console.log('\nVerifying restored counts...');
  let mismatches = 0;
  for (const c of entries) {
    const actual = await db.collection(c.name).countDocuments();
    // A TTL collection can legitimately end up short: the reaper runs once a
    // minute and removes whatever aged out between backup and restore.
    const ttl = (indexSpecs[c.name]?.indexes || []).some((i) => i.expireAfterSeconds !== undefined);
    if (actual !== c.count) {
      mismatches += ttl ? 0 : 1;
      console.log(`  ${actual === c.count ? ' ' : '!'} ${c.name.padEnd(24)} ${actual} vs ${c.count} expected${ttl ? '  (TTL collection — shrinkage is expected)' : ''}`);
    }
  }

  const totalIn = results.reduce((s, r) => s + r.inserted, 0);
  const totalExp = results.reduce((s, r) => s + r.expected, 0);
  console.log(
    mismatches === 0
      ? `\nRestore complete: ${totalIn}/${totalExp} documents, ${created} indexes.`
      : `\nRestore finished with ${mismatches} unexplained count mismatch(es): ${totalIn}/${totalExp} documents.`
  );

  await client.close();
  if (mismatches > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nRESTORE FAILED: ${err.message}`);
  process.exit(1);
});

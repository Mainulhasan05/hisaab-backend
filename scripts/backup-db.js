/**
 * Full logical backup of the MongoDB database — no mongodump required.
 *
 * Uses the `mongodb` driver already in node_modules, so nothing has to be
 * installed. Every collection is written as newline-delimited **canonical**
 * EJSON, which round-trips ObjectId / Date / Decimal128 / Binary / Long
 * losslessly (relaxed EJSON does not — it degrades Long and Date).
 *
 *   node scripts/backup-db.js                    # back up MONGODB_URI
 *   node scripts/backup-db.js --out ./backups    # choose the parent directory
 *   node scripts/backup-db.js --uri "mongodb+srv://..."   # back up something else
 *   node scripts/backup-db.js --only sales,products       # subset
 *
 * Output layout:
 *   backups/<db>-<UTC timestamp>/
 *     _manifest.json        server version, source, per-collection counts, checksums
 *     _indexes.json         full index specs (unique, TTL, partial, collation)
 *     <collection>.jsonl    one canonical-EJSON document per line
 *
 * Caveats worth knowing:
 *  - This is NOT a point-in-time snapshot. Collections are read one after
 *    another, so a write landing mid-run can leave two collections skewed by a
 *    few seconds. At this database's size the window is ~seconds; for a true
 *    consistent snapshot use an Atlas cloud backup.
 *  - Collections carrying TTL indexes (auditlogs, smslogs, notificationlogs,
 *    invoicecounters, telegramlinktokens) are a moving window by design — a
 *    backup captures only what had not yet expired.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
// EJSON lives in `bson` (a driver dependency), not in `mongodb` itself, since driver v6.
const { EJSON } = require('bson');

const BATCH = 1000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Strip credentials so a URI is safe to print and to store in the manifest. */
function safeUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '<unparseable uri>';
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

async function main() {
  const uri = arg('uri', process.env.MONGODB_URI);
  if (!uri) throw new Error('No connection string. Set MONGODB_URI in .env or pass --uri.');

  const only = arg('only');
  const onlySet = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 20000,
    // A backup only reads; a secondary read keeps the load off the primary and
    // falls back to the primary automatically on a single-node deployment.
    readPreference: 'secondaryPreferred',
  });
  await client.connect();
  const db = client.db();

  const buildInfo = await db.admin().command({ buildInfo: 1 }).catch(() => ({}));
  // Timestamp is UTC and filename-safe: 2026-08-13T14-05-22Z
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
  const outParent = path.resolve(arg('out', path.join(__dirname, '..', 'backups')));
  const outDir = path.join(outParent, `${db.databaseName}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Source : ${safeUri(uri)}`);
  console.log(`Server : MongoDB ${buildInfo.version || 'unknown'}`);
  console.log(`Target : ${outDir}\n`);

  const all = (await db.listCollections().toArray()).filter((c) => c.type === 'collection');
  const collections = all
    .filter((c) => !onlySet || onlySet.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (onlySet) {
    const missing = [...onlySet].filter((n) => !all.some((c) => c.name === n));
    if (missing.length) console.warn(`WARNING: not found in source: ${missing.join(', ')}\n`);
  }

  const manifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    source: safeUri(uri),
    database: db.databaseName,
    serverVersion: buildInfo.version || null,
    partial: !!onlySet,
    collections: [],
  };
  const indexSpecs = {};

  let grandDocs = 0;
  let grandBytes = 0;

  for (const col of collections) {
    const name = col.name;
    const coll = db.collection(name);

    // Index specs are captured verbatim — unique, TTL (expireAfterSeconds),
    // partialFilterExpression, sparse and collation all matter on restore and
    // are silently lost by any "just recreate from the schema" approach.
    indexSpecs[name] = {
      options: col.options || {},
      indexes: await coll.indexes().catch(() => []),
    };

    const file = path.join(outDir, `${name}.jsonl`);
    const stream = fs.createWriteStream(file, { encoding: 'utf8' });
    const hash = crypto.createHash('sha256');

    let docs = 0;
    let bytes = 0;
    let buf = [];

    const flush = () =>
      new Promise((resolve, reject) => {
        if (!buf.length) return resolve();
        const chunk = buf.join('');
        buf = [];
        hash.update(chunk);
        bytes += Buffer.byteLength(chunk);
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });

    // Natural order is the cheapest full scan; sort order is irrelevant to a restore.
    const cursor = coll.find({}, { batchSize: BATCH, noCursorTimeout: false });
    for await (const doc of cursor) {
      // relaxed:false => canonical EJSON, the only mode that round-trips exactly.
      buf.push(EJSON.stringify(doc, { relaxed: false }) + '\n');
      docs++;
      if (buf.length >= BATCH) await flush();
    }
    await flush();
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

    manifest.collections.push({
      name,
      file: `${name}.jsonl`,
      count: docs,
      bytes,
      sha256: hash.digest('hex'),
      indexCount: indexSpecs[name].indexes.length,
    });

    grandDocs += docs;
    grandBytes += bytes;
    console.log(`  ${name.padEnd(24)} ${String(docs).padStart(7)} docs  ${fmtBytes(bytes).padStart(10)}`);
  }

  fs.writeFileSync(path.join(outDir, '_indexes.json'), JSON.stringify(indexSpecs, null, 2));
  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n${collections.length} collections, ${grandDocs} documents, ${fmtBytes(grandBytes)}`);
  console.log(`Backup written to ${outDir}`);
  console.log(`\nRestore with:\n  node scripts/restore-db.js --from "${outDir}" --uri "<target-uri>" --dry-run`);

  await client.close();
}

main().catch((err) => {
  console.error(`\nBACKUP FAILED: ${err.message}`);
  process.exit(1);
});

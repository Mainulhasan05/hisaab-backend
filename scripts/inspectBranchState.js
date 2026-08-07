/**
 * Multi-Branch State Inspection — READ ONLY.
 *
 * Phase 0 of FEATURE_PLAN.md. Answers the 8 questions in FEATURE_AUDIT.md §8 so
 * the Phase 3 migration can be written against what is actually in the database
 * rather than against assumptions.
 *
 *   node scripts/inspectBranchState.js              # cheap scan (default)
 *   node scripts/inspectBranchState.js --deep       # + exhaustive per-collection sweep
 *   node scripts/inspectBranchState.js --out report.json
 *
 * SAFETY
 * ------
 * This script performs NO writes. It uses only countDocuments / find().lean() /
 * distinct / aggregate (no $out, no $merge). autoIndex is off so connecting
 * cannot create an index. Reads prefer a secondary so production traffic is
 * unaffected. The connection string is never printed.
 *
 * Shop states (FEATURE_AUDIT.md §8):
 *   A  clean single-branch  — flag off, no branches, nothing tagged   → no migration
 *   B  cleanly migrated     — flag on, everything tagged              → simple migration
 *   C  partially tagged     — flag on, some rows still null           → needs remediation
 *   D  disabled after enable— flag off, but branches/tags remain      → needs remediation
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

// Guard: this script must never be handed a write-ish flag.
const FORBIDDEN = ['--apply', '--fix', '--write', '--migrate', '--repair'];
const bad = process.argv.filter((a) => FORBIDDEN.includes(a));
if (bad.length) {
  console.error(`Refusing to run: ${bad.join(', ')} — this script is read-only.`);
  process.exit(1);
}

const DEEP = process.argv.includes('--deep');
const outIdx = process.argv.indexOf('--out');
const OUT_FILE = outIdx !== -1 ? process.argv[outIdx + 1] : null;

// Collections that enableMultiBranch backfills, plus HeldCart which it misses (M-5).
const BRANCH_SCOPED = [
  'Sale', 'Purchase', 'Expense', 'CashRegister', 'StockTransaction',
  'Payment', 'SalesReturn', 'SMSLog', 'AuditLog', 'HeldCart',
];

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

async function main() {
  const started = Date.now();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
    readPreference: 'secondaryPreferred',
  });
  console.log(`Connected to ${mongoose.connection.host}  [READ-ONLY${DEEP ? ', DEEP' : ''}]\n`);

  // src/models/index.js doesn't export every model, so require the rest directly
  // rather than editing that file (nothing else in this change should touch it).
  const M = {
    ...require('../src/models'),
    Purchase: require('../src/models/Purchase.model'),
    Expense: require('../src/models/Expense.model'),
    CashRegister: require('../src/models/CashRegister.model'),
    SalesReturn: require('../src/models/SalesReturn.model'),
    HeldCart: require('../src/models/HeldCart.model'),
    StockTransfer: require('../src/models/StockTransfer.model'),
  };
  const { Shop, Branch, User, Product, StockTransfer } = M;

  // BranchStock was retired in Phase 3 (stock now lives on the per-branch
  // Product document). The collection may still hold legacy rows, so it is read
  // through the raw driver rather than a model.
  const legacyBranchStock = mongoose.connection.db.collection('branchstocks');

  const report = { generatedAt: new Date().toISOString(), deep: DEEP, shops: [], global: {} };

  // ── Q1 + Q3: candidate shops ────────────────────────────────────────────────
  // A shop can only hold branch-tagged rows if it has Branch documents, so the
  // candidate set is (flag on) ∪ (has ≥1 Branch). Everything outside it is
  // state A by construction — no need to scan the big collections for it.
  const [flagOnIds, shopIdsWithBranches, totalShops] = await Promise.all([
    Shop.distinct('_id', { multiBranchEnabled: true }),
    Branch.distinct('shop'),
    Shop.countDocuments({}),
  ]);

  const candidateIds = [
    ...new Map(
      [...flagOnIds, ...shopIdsWithBranches].map((id) => [String(id), id])
    ).values(),
  ];

  console.log('═'.repeat(78));
  console.log('OVERVIEW');
  console.log('═'.repeat(78));
  console.log(`  Total shops on the platform ......... ${totalShops}`);
  console.log(`  multiBranchEnabled = true ........... ${flagOnIds.length}`);
  console.log(`  Shops holding ≥1 Branch document .... ${shopIdsWithBranches.length}`);
  console.log(`  Candidate shops to inspect .......... ${candidateIds.length}`);
  console.log(`  Assumed clean single-branch (state A) ${totalShops - candidateIds.length}\n`);

  report.global = {
    totalShops,
    flagOn: flagOnIds.length,
    shopsWithBranchDocs: shopIdsWithBranches.length,
    candidates: candidateIds.length,
    assumedStateA: totalShops - candidateIds.length,
  };

  if (candidateIds.length === 0) {
    console.log('  No shop has ever enabled multi-branch and no Branch document exists.');
    console.log('  → Every shop is state A. The Phase 3 data migration is a NO-OP.\n');
  }

  // ── Per-shop inspection ─────────────────────────────────────────────────────
  const flagOnSet = new Set(flagOnIds.map(String));

  for (const shopId of candidateIds) {
    const shop = await Shop.findById(shopId).select('name phone multiBranchEnabled isActive').lean();
    if (!shop) continue;

    const flagOn = flagOnSet.has(String(shopId));

    // Q5: branches and their isDefault sanity
    const branches = await Branch.find({ shop: shopId })
      .select('name code isActive isDefault deletedAt createdAt')
      .sort({ createdAt: 1 })
      .lean();
    const activeBranches = branches.filter((b) => b.isActive);
    const defaultCount = branches.filter((b) => b.isDefault).length;

    // Q2 + Q4: tagged vs untagged per collection
    const perCollection = {};
    let totalTagged = 0;
    let totalUntagged = 0;

    for (const name of BRANCH_SCOPED) {
      const Model = M[name];
      if (!Model) { perCollection[name] = { error: 'model not exported' }; continue; }
      const [total, untagged] = await Promise.all([
        Model.countDocuments({ shop: shopId }),
        Model.countDocuments({ shop: shopId, branch: null }),
      ]);
      const tagged = total - untagged;
      perCollection[name] = { total, tagged, untagged };
      totalTagged += tagged;
      totalUntagged += untagged;
    }

    // Q7: staff with no branch in a multi-branch shop → hard 403 on every request
    const [staffTotal, staffUnassigned] = await Promise.all([
      User.countDocuments({ shop: shopId, isOwner: false }),
      User.countDocuments({ shop: shopId, isOwner: false, branch: null }),
    ]);

    // Q6: BranchStock coverage + orphans
    const branchIdSet = new Set(branches.map((b) => String(b._id)));
    const [productCount, bsCount, bsBranchIds] = await Promise.all([
      Product.countDocuments({ shop: shopId, isDeleted: { $ne: true } }),
      legacyBranchStock.countDocuments({ shop: shopId }),
      legacyBranchStock.distinct('branch', { shop: shopId }),
    ]);
    const bsOrphanBranches = bsBranchIds.filter((b) => !branchIdSet.has(String(b)));
    const bsInactiveBranches = bsBranchIds.filter((b) => {
      const br = branches.find((x) => String(x._id) === String(b));
      return br && !br.isActive;
    });
    // Variant-aware expectation: one row per (product-or-variant, active branch)
    const variantAgg = await Product.aggregate([
      { $match: { shop: new mongoose.Types.ObjectId(shopId), isDeleted: { $ne: true } } },
      {
        $group: {
          _id: null,
          units: {
            $sum: {
              $cond: [
                { $eq: ['$hasVariants', true] },
                { $max: [{ $size: { $ifNull: ['$variants', []] } }, 1] },
                1,
              ],
            },
          },
        },
      },
    ]);
    const stockUnits = variantAgg[0]?.units || 0;
    const bsExpected = stockUnits * Math.max(activeBranches.length, 0);

    // ── State classification ──────────────────────────────────────────────────
    let state, note;
    if (flagOn) {
      if (branches.length === 0) {
        state = 'C'; note = 'flag on but NO branch exists — owner has nothing to select';
      } else if (totalUntagged > 0) {
        state = 'C'; note = `${totalUntagged} untagged rows — invisible when a branch is selected`;
      } else {
        state = 'B'; note = 'fully tagged';
      }
    } else {
      if (branches.length > 0 || totalTagged > 0) {
        state = 'D'; note = 'flag off but branch data remains — re-enabling would crash (M-4)';
      } else {
        state = 'A'; note = 'clean';
      }
    }

    const problems = [];
    if (flagOn && defaultCount !== 1) problems.push(`isDefault count = ${defaultCount} (expected 1)`);
    if (flagOn && staffUnassigned > 0) problems.push(`${staffUnassigned} staff with no branch → 403 on every request`);
    if (perCollection.HeldCart?.untagged > 0) problems.push(`${perCollection.HeldCart.untagged} untagged held carts (M-5)`);
    if (bsOrphanBranches.length) problems.push(`BranchStock rows for ${bsOrphanBranches.length} non-existent branch(es)`);
    if (bsInactiveBranches.length) problems.push(`BranchStock rows for ${bsInactiveBranches.length} inactive branch(es)`);
    if (false) problems.push('no legacy BranchStock rows (expected after Phase 3)');
    if (bsCount > 0) problems.push(`${bsCount} legacy BranchStock row(s) remain — retired in Phase 3, safe to drop`);

    // ── Print ─────────────────────────────────────────────────────────────────
    console.log('─'.repeat(78));
    console.log(`SHOP  ${shop.name}   [${shopId}]`);
    console.log(`      state ${state} — ${note}`);
    console.log(`      multiBranchEnabled=${shop.multiBranchEnabled}  isActive=${shop.isActive}`);
    console.log('─'.repeat(78));

    console.log(`  Branches (${branches.length}, ${activeBranches.length} active):`);
    if (!branches.length) console.log('    (none)');
    branches.forEach((b) => {
      const flags = [b.isDefault ? 'DEFAULT' : null, b.isActive ? null : 'INACTIVE'].filter(Boolean);
      console.log(`    • ${pad(b.name, 24)} ${pad(b.code, 8)} ${flags.join(' ')}`);
    });

    console.log(`\n  Rows by collection:`);
    console.log(`    ${pad('collection', 20)}${padL('total', 10)}${padL('tagged', 10)}${padL('untagged', 10)}   tagged%`);
    for (const name of BRANCH_SCOPED) {
      const c = perCollection[name];
      if (!c || c.error) { console.log(`    ${pad(name, 20)}  ${c?.error || '?'}`); continue; }
      if (c.total === 0) continue;
      const warn = c.untagged > 0 && flagOn ? '  ⚠' : '';
      console.log(
        `    ${pad(name, 20)}${padL(c.total, 10)}${padL(c.tagged, 10)}${padL(c.untagged, 10)}   ${pct(c.tagged, c.total)}${warn}`
      );
    }

    console.log(`\n  Staff: ${staffTotal} total, ${staffUnassigned} with no branch assigned`);
    console.log(`  Products: ${productCount} active (${stockUnits} stock units incl. variants)`);
    console.log(`  Legacy BranchStock rows: ${bsCount} (collection retired in Phase 3)`);

    if (problems.length) {
      console.log(`\n  ⚠ Problems:`);
      problems.forEach((p) => console.log(`    - ${p}`));
    } else {
      console.log(`\n  ✓ No problems detected`);
    }
    console.log('');

    report.shops.push({
      shopId: String(shopId),
      name: shop.name,
      multiBranchEnabled: shop.multiBranchEnabled,
      isActive: shop.isActive,
      state,
      note,
      branches: branches.map((b) => ({
        _id: String(b._id), name: b.name, code: b.code,
        isActive: b.isActive, isDefault: b.isDefault,
      })),
      defaultBranchCount: defaultCount,
      perCollection,
      totalTagged,
      totalUntagged,
      staff: { total: staffTotal, unassigned: staffUnassigned },
      products: { active: productCount, stockUnits },
      branchStock: {
        rows: bsCount,
        expected: bsExpected,
        orphanBranches: bsOrphanBranches.map(String),
        inactiveBranches: bsInactiveBranches.map(String),
      },
      problems,
    });
  }

  // ── Q8: transferNo collisions across shops (global unique index, M-9) ───────
  const transferDupes = await StockTransfer.aggregate([
    { $group: { _id: '$transferNo', n: { $sum: 1 }, shops: { $addToSet: '$shop' } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 50 },
  ]);
  const crossShopDupes = transferDupes.filter((d) => d.shops.length > 1);
  report.global.transferNoCollisions = crossShopDupes.length;

  // Sanity: Product.branch should not exist yet (the field is added in Phase 3)
  const productsWithBranch = await Product.countDocuments({ branch: { $exists: true, $ne: null } });
  report.global.productsAlreadyCarryingBranch = productsWithBranch;

  // ── Deep sweep (optional): catch tagged rows whose Branch doc was hard-deleted
  if (DEEP) {
    console.log('═'.repeat(78));
    console.log('DEEP SWEEP — shops with tagged rows but no Branch document');
    console.log('═'.repeat(78));
    const candidateSet = new Set(candidateIds.map(String));
    const strays = {};
    const strayShopIds = new Set();
    for (const name of BRANCH_SCOPED) {
      const Model = M[name];
      if (!Model) continue;
      const shops = await Model.distinct('shop', { branch: { $ne: null } });
      const outside = shops.filter((s) => !candidateSet.has(String(s)));
      if (outside.length) {
        const rows = await Model.countDocuments({ shop: { $in: outside }, branch: { $ne: null } });
        strays[name] = { shops: outside.map(String), rows };
        outside.forEach((s) => strayShopIds.add(String(s)));
      }
      console.log(`  ${pad(name, 20)} ${padL(shops.length, 6)} shops tagged, ${outside.length} outside candidate set`);
    }
    report.global.deepStrays = strays;

    // A stray shop is either (a) a live shop whose Branch docs were hard-deleted
    // — real remediation work — or (b) a shop document that no longer exists,
    // i.e. orphan rows left by an incomplete purge. Very different problems.
    if (strayShopIds.size) {
      console.log(`\n  ⚠ ${strayShopIds.size} shop id(s) carry branch tags but own no Branch document:`);
      for (const sid of strayShopIds) {
        const exists = await Shop.exists({ _id: sid });
        const total = Object.entries(strays)
          .filter(([, v]) => v.shops.includes(sid))
          .map(([k, v]) => `${k}:${v.rows}`)
          .join(', ');
        console.log(`    ${sid}  shopDocExists=${!!exists}  →  ${total}`);
        console.log(`      ${exists
          ? 'LIVE SHOP — branch docs were deleted under it. Needs remediation.'
          : 'Shop document is gone — orphan rows from an incomplete purge, not a live shop.'}`);
      }
      report.global.strayShops = [...strayShopIds];
    }
    console.log('');
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const byState = report.shops.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] || 0) + 1 }), {});
  const needsMigration = report.shops.filter((s) => s.state === 'B' || s.state === 'C' || s.state === 'D');

  console.log('═'.repeat(78));
  console.log('VERDICT');
  console.log('═'.repeat(78));
  console.log(`  State A (clean single-branch) ....... ${report.global.assumedStateA + (byState.A || 0)}`);
  console.log(`  State B (cleanly migrated) .......... ${byState.B || 0}`);
  console.log(`  State C (partially tagged) .......... ${byState.C || 0}   ← needs remediation`);
  console.log(`  State D (disabled after enable) ..... ${byState.D || 0}   ← needs remediation`);
  console.log(`  Cross-shop transferNo collisions .... ${crossShopDupes.length}`);
  console.log(`  Products already carrying a branch .. ${productsWithBranch} (expected 0)`);
  console.log('');

  if (!DEEP) {
    console.log('  NOTE: run with --deep before trusting a clean verdict — the cheap scan');
    console.log('        cannot see branch tags whose Branch document was hard-deleted.\n');
  }

  if (needsMigration.length === 0) {
    console.log('  ✓ No LIVE shop holds multi-branch data.');
    console.log('    → Phase 3 data migration is a NO-OP for live shops. Schema change only.');
    if (report.global.strayShops?.length) {
      console.log(`    ⚠ but ${report.global.strayShops.length} stray shop id(s) carry branch tags —`);
      console.log('      see the deep sweep above for whether they are live or orphaned.');
    }
  } else {
    console.log(`  → ${needsMigration.length} shop(s) require the Phase 3 migration:`);
    needsMigration.forEach((s) => {
      console.log(`      ${pad(s.state, 3)} ${pad(s.name, 28)} ${s.branches.length} branch(es), ` +
        `${s.totalUntagged} untagged row(s), ${s.products.active} product(s)`);
    });
  }
  console.log('');

  if (OUT_FILE) {
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(`  Full report written to ${OUT_FILE}\n`);
  }

  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. No writes were performed.`);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('\nInspection failed:', err.message);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});

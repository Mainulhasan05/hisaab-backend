#!/usr/bin/env node
/**
 * Repair the branch backfill for shops that were switched to multi-branch
 * BEFORE `admin.service.enableMultiBranch` learned to carry everything over.
 *
 * ── What was being left behind ───────────────────────────────────────────────
 *
 * Enabling multi-branch is supposed to move a shop's entire history under its
 * default branch and change nothing else. Three things were not moved, and each
 * of them reads to the shopkeeper as data loss even though every document is
 * still in the database:
 *
 *  1. `SupplierBalance` was never seeded — not one row. `SupplierBalance` has no
 *     scope flag (unlike customers, the figures follow the active branch
 *     unconditionally) and `overlayBranchFigures` falls back to `|| 0` for a
 *     supplier with no row. So the instant the flag flipped, EVERY supplier's
 *     payable read ৳0 at branch level while the shop-wide rollup still held the
 *     real figure. The whole payables book vanished from the only view the
 *     staff use.
 *
 *  2. `CustomerBalance.openingDue` was seeded as 0. Not inert:
 *     `customer.service.setOpeningDue` measures its delta against the figure the
 *     owner is LOOKING AT, which under branch scope is this row — so an owner
 *     re-entering the true opening due computed `delta = target − 0` and added
 *     it a SECOND time, doubling both the opening due and the total due.
 *
 *  3. `DueAdjustment` and `SupplierDueAdjustment` kept `branch: null`. Both
 *     ledgers filter on `branch` once one is selected, so every "পূর্বের বাকি
 *     (খাতা থেকে)" line and every owner correction entered before enablement
 *     dropped out of the খতিয়ান — the money still counted in `totalDue`, with
 *     nothing left on the page to say where it came from.
 *
 * All three are fixed at the source in `enableMultiBranch`. This script is for
 * the shops that went through the old one.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *
 * Read-only unless `--apply` is passed. Writes nothing but the missing rows and
 * the missing branch tags: it never deletes, never reassigns a row that already
 * carries a branch, and never touches a `CustomerBalance` whose openingDue is
 * already non-zero. Re-running it is a no-op.
 *
 *   node scripts/repair-branch-backfill.js            # report only
 *   node scripts/repair-branch-backfill.js --apply
 *   node scripts/repair-branch-backfill.js --apply --shop <shopId>
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Shop = require('../src/models/Shop.model');
const Branch = require('../src/models/Branch.model');
const Customer = require('../src/models/Customer.model');
const CustomerBalance = require('../src/models/CustomerBalance.model');
const Supplier = require('../src/models/Supplier.model');
const SupplierBalance = require('../src/models/SupplierBalance.model');
const DueAdjustment = require('../src/models/DueAdjustment.model');
const SupplierDueAdjustment = require('../src/models/SupplierDueAdjustment.model');

const APPLY = process.argv.includes('--apply');
const shopArgIdx = process.argv.indexOf('--shop');
const ONLY_SHOP = shopArgIdx !== -1 ? process.argv[shopArgIdx + 1] : null;

const money = (n) => `৳${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;

/**
 * The branch a pre-enablement row belongs to: the shop's default.
 *
 * Same choice `enableMultiBranch` makes, and it has to be — those rows were
 * written when the shop had one counter, and that counter became the default
 * branch. Falls back to the oldest branch for a shop whose default flag was
 * lost, which is the same fallback the enable path uses.
 */
async function defaultBranchFor(shopId) {
  return (
    (await Branch.findOne({ shop: shopId, isDefault: true }).lean()) ||
    (await Branch.findOne({ shop: shopId }).sort({ createdAt: 1 }).lean())
  );
}

async function repairShop(shop) {
  const branch = await defaultBranchFor(shop._id);
  const report = { shop: shop.name, branch: branch?.name || null, actions: [] };

  if (!branch) {
    report.actions.push({ what: 'SKIPPED — shop has no branch to backfill into' });
    return report;
  }

  // ── 1. Untagged adjustment rows ────────────────────────────────────────────
  for (const [label, Model] of [['DueAdjustment', DueAdjustment], ['SupplierDueAdjustment', SupplierDueAdjustment]]) {
    const count = await Model.countDocuments({ shop: shop._id, branch: null });
    if (count === 0) continue;

    report.actions.push({ what: `${label}: tag ${count} untagged rows -> ${branch.name}` });
    if (APPLY) {
      await Model.updateMany({ shop: shop._id, branch: null }, { $set: { branch: branch._id } });
    }
  }

  // ── 2. CustomerBalance.openingDue ──────────────────────────────────────────
  //
  // Only ever applied when the branch rows sum to ZERO opening while the
  // customer carries one. A shop that has since entered opening dues through
  // `_applyDueAdjustment` already has correct rows on both sides, and
  // overwriting those would be the very double-count this exists to prevent.
  const openingFixes = await Customer.aggregate([
    { $match: { shop: shop._id, openingDue: { $gt: 0 } } },
    { $lookup: { from: 'customerbalances', localField: '_id', foreignField: 'customer', as: 'b' } },
    { $project: { openingDue: 1, name: 1, phone: 1, sumOpening: { $sum: '$b.openingDue' } } },
    { $match: { $expr: { $lt: ['$sumOpening', 0.01] } } },
  ]);

  if (openingFixes.length > 0) {
    const total = openingFixes.reduce((s, c) => s + c.openingDue, 0);
    report.actions.push({
      what: `CustomerBalance.openingDue: seed ${openingFixes.length} customers (${money(total)}) -> ${branch.name}`,
    });
    if (APPLY) {
      await CustomerBalance.bulkWrite(
        openingFixes.map((c) => ({
          updateOne: {
            filter: { shop: shop._id, customer: c._id, branch: branch._id },
            update: { $set: { openingDue: c.openingDue } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
  }

  // ── 3. SupplierBalance, which was never seeded at all ──────────────────────
  //
  // `totalPaid` is recovered from the identity `Supplier.model.js` documents:
  //     totalDue = max(0, totalAmount + openingDue − totalPaid)
  // inverted and clamped at zero — on an over-paid supplier the stored due is
  // the CLAMPED value, so the inversion can land negative, and a negative paid
  // figure would make `recomputeDue` overstate the debt on the next cancel.
  const suppliers = await Supplier.find({ shop: shop._id })
    .select('_id name totalAmount totalDue openingDue totalPurchases').lean();
  const existing = await SupplierBalance.find({ shop: shop._id }).select('supplier').lean();
  const seeded = new Set(existing.map((r) => String(r.supplier)));
  const missing = suppliers.filter((s) => !seeded.has(String(s._id)));

  if (missing.length > 0) {
    const total = missing.reduce((s, x) => s + (x.totalDue || 0), 0);
    report.actions.push({
      what: `SupplierBalance: seed ${missing.length} suppliers (${money(total)} payable) -> ${branch.name}`,
    });
    if (APPLY) {
      await SupplierBalance.bulkWrite(
        missing.map((s) => {
          const amount = s.totalAmount || 0;
          const opening = s.openingDue || 0;
          const due = s.totalDue || 0;
          return {
            updateOne: {
              filter: { shop: shop._id, supplier: s._id, branch: branch._id },
              update: {
                $set: {
                  totalAmount: amount,
                  totalPaid: Math.max(0, Math.round((amount + opening - due) * 100) / 100),
                  totalDue: due,
                  openingDue: opening,
                  // COUNT, not money — `Supplier.totalPurchases` is a count and
                  // its per-branch twin is named `purchaseCount`.
                  purchaseCount: s.totalPurchases || 0,
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false }
      );
    }
  }

  // ── 4. Customers with no ledger row at all ─────────────────────────────────
  //
  // Invisible under branch scope, which drives its list off `CustomerBalance`.
  const noRow = await Customer.aggregate([
    { $match: { shop: shop._id } },
    { $lookup: { from: 'customerbalances', localField: '_id', foreignField: 'customer', as: 'b' } },
    { $match: { b: { $size: 0 } } },
    { $project: { name: 1, phone: 1, totalPurchases: 1, totalPaid: 1, totalDue: 1, openingDue: 1, purchaseCount: 1, lastPurchase: 1 } },
  ]);

  if (noRow.length > 0) {
    report.actions.push({ what: `CustomerBalance: seed ${noRow.length} customers with NO row -> ${branch.name}` });
    if (APPLY) {
      await CustomerBalance.bulkWrite(
        noRow.map((c) => ({
          updateOne: {
            filter: { shop: shop._id, customer: c._id, branch: branch._id },
            update: {
              $set: {
                totalPurchases: c.totalPurchases || 0,
                totalPaid: c.totalPaid || 0,
                totalDue: c.totalDue || 0,
                openingDue: c.openingDue || 0,
                purchaseCount: c.purchaseCount || 0,
                lastPurchase: c.lastPurchase || null,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
  }

  return report;
}

/**
 * The Σ invariants both ledgers exist to hold, checked after any repair.
 *
 * REPORTS ONLY — it never repairs what it finds, deliberately. A gap here can
 * sit on either side, and this script cannot tell which without re-deriving
 * from source documents:
 *
 *   - branch rows short  → what this script's seeding steps fix;
 *   - rollup overstated  → a write path that moved one book and not the other,
 *     which writing MORE into the branch rows would bury rather than fix.
 *
 * Both live shops turned out to be the second kind (`Supplier.totalDue` ahead
 * of both the branch rows AND the purchases behind them), so the distinction is
 * not theoretical. `recalc-{customer,supplier}-balances.js` are the tools that
 * re-derive from Purchase/Payment/adjustments and can adjudicate.
 */
async function verify(shop) {
  const custDrift = await Customer.aggregate([
    { $match: { shop: shop._id } },
    { $lookup: { from: 'customerbalances', localField: '_id', foreignField: 'customer', as: 'b' } },
    {
      $project: {
        phone: 1, name: 1,
        dueGap: { $subtract: [{ $ifNull: ['$totalDue', 0] }, { $sum: '$b.totalDue' }] },
        openGap: { $subtract: [{ $ifNull: ['$openingDue', 0] }, { $sum: '$b.openingDue' }] },
      },
    },
    { $match: { $or: [{ dueGap: { $gt: 0.011 } }, { dueGap: { $lt: -0.011 } }, { openGap: { $gt: 0.011 } }, { openGap: { $lt: -0.011 } }] } },
  ]);

  const suppDrift = await Supplier.aggregate([
    { $match: { shop: shop._id } },
    { $lookup: { from: 'supplierbalances', localField: '_id', foreignField: 'supplier', as: 'b' } },
    {
      $project: {
        name: 1,
        dueGap: { $subtract: [{ $ifNull: ['$totalDue', 0] }, { $sum: '$b.totalDue' }] },
        openGap: { $subtract: [{ $ifNull: ['$openingDue', 0] }, { $sum: '$b.openingDue' }] },
      },
    },
    { $match: { $or: [{ dueGap: { $gt: 0.011 } }, { dueGap: { $lt: -0.011 } }, { openGap: { $gt: 0.011 } }, { openGap: { $lt: -0.011 } }] } },
  ]);

  return { custDrift, suppDrift };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  const filter = { multiBranchEnabled: true };
  if (ONLY_SHOP) filter._id = new mongoose.Types.ObjectId(ONLY_SHOP);

  const shops = await Shop.find(filter).select('name multiBranchEnabled customerScope').lean();
  if (shops.length === 0) console.log('No multi-branch shops matched.');

  for (const shop of shops) {
    const report = await repairShop(shop);
    console.log(`── ${report.shop}  (default branch: ${report.branch})`);
    if (report.actions.length === 0) {
      console.log('   nothing to repair');
    } else {
      report.actions.forEach((a) => console.log(`   • ${a.what}`));
    }

    const { custDrift, suppDrift } = await verify(shop);
    const verdict = APPLY ? 'after repair' : 'current';
    console.log(`   Σ check (${verdict}): ${custDrift.length} customer drift, ${suppDrift.length} supplier drift`);
    [...custDrift, ...suppDrift].slice(0, 10).forEach((d) =>
      console.log(`       ! ${d.name || d.phone}  dueGap=${money(d.dueGap)} openGap=${money(d.openGap)}`)
    );
    if (custDrift.length || suppDrift.length) {
      console.log('     ^ reported, NOT repaired — a positive gap means the shop-wide rollup is');
      console.log('       ahead of the branch books. Run recalc-{customer,supplier}-balances.js');
      console.log('       --verify-only to see which side the source documents agree with.');
    }
    console.log('');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const DueAdjustment = require('../models/DueAdjustment.model');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { branchFilter, requireBranch, isBranchCustomerScope } = require('../utils/branchScope.util');
const { normalizePhone } = require('../utils/phone.util');
const { runInTransaction } = require('../utils/transaction.util');
const paymentAccountService = require('./paymentAccount.service');
// The shared ledger write for "money reduces a customer's due". Shared with the
// POS checkout path, which settles dues out of surplus tendered at the till.
const dueSettlementService = require('./dueSettlement.service');
const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');
const { resolveWholesaleFlag } = require('../utils/pricing.util');
const { toMoney } = require('../utils/invoiceMath.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { resolvePaidAt } = require('../utils/paymentDate.util');
const { toBangladeshDateStr } = require('../utils/bdTime.util');
const mongoose = require('mongoose');

/** Escape user input before it reaches $regex — raw input is a ReDoS vector. */
const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The name/phone search clause, in the one shape every customer read uses.
 *
 * ── Why the phone gets its own term ──────────────────────────────────────────
 *
 * Phones are STORED normalised (`01792449180` — see `Customer.pre('save')`) and
 * were SEARCHED raw. So a shop whose staff have the number saved the way it is
 * printed on a card — `+880 1792-449180`, the form this bug was reported in —
 * matched nothing, and neither did `01792-449180` or `017 9244 9180`. The
 * customer was sitting in the list the whole time under a different spelling of
 * the same eleven digits.
 *
 * Both terms are emitted rather than one:
 *
 *   - the RAW text matches names, which `normalizePhone` would reduce to '' —
 *     it strips every non-digit, so "নাঈম" comes back empty;
 *   - the NORMALISED text matches phones, and is dropped when the query has no
 *     digits in it at all.
 *
 * Partial input keeps working: `normalizePhone('0179')` is `'0179'`, so typing
 * a prefix still prefix-matches. `+8801792` reduces to `01792`, which is the
 * point.
 *
 * @param {string} search raw text as typed
 * @param {string[]} nameFields document paths to match the raw text against
 * @param {string} phoneField document path holding the normalised phone
 * @returns {Array|null} $or branches, or null when there is nothing to search
 */
const buildSearchOr = (search, nameFields, phoneField) => {
  const raw = String(search ?? '').trim();
  if (!raw) return null;

  const escaped = escapeRegex(raw);
  const clauses = nameFields.map((field) => ({ [field]: { $regex: escaped, $options: 'i' } }));

  // Always include the raw term against the phone too: it is what makes a
  // straight `01792449180` keep working if normalisation ever changes shape.
  clauses.push({ [phoneField]: { $regex: escaped, $options: 'i' } });

  const normalised = normalizePhone(raw);
  if (normalised && normalised !== raw) {
    clauses.push({ [phoneField]: { $regex: escapeRegex(normalised), $options: 'i' } });
  }

  return clauses;
};

/** Customer fields the list and leaderboard surface, projected out of a $lookup. */
const CUSTOMER_PROJECTION = {
  name: '$customer.name',
  phone: '$customer.phone',
  address: '$customer.address',
  notes: '$customer.notes',
  tags: '$customer.tags',
  isActive: '$customer.isActive',
  createdAt: '$customer.createdAt',
  // Without this the branch-scoped list — which is an aggregation with an
  // EXPLICIT projection, unlike the shop-wide list's plain `find()` — would
  // drop the flag, and the till in every multi-branch shop would quietly ring
  // wholesale customers up at retail while single-branch shops worked fine.
  // Exactly how `openingDue` once read ৳০ for every branch-scoped shop.
  isWholesale: '$customer.isWholesale',
};

/**
 * The per-branch money figures, in the shape the shop-wide list already uses.
 * One constant so a field added to the ledger cannot reach the branch-scoped
 * list and miss the shop-wide one (or the reverse) — which is how `openingDue`
 * would otherwise have shown up as ৳0 for every branch-scoped shop.
 */
const BALANCE_PROJECTION = {
  totalPurchases: 1,
  totalPaid: 1,
  totalDue: 1,
  openingDue: 1,
  purchaseCount: 1,
  lastPurchase: 1,
};

/**
 * Resolve the name a branch sees, and say where it came from.
 *
 * Every branch-scoped read goes through here so the list, the detail page, the
 * till lookup and the leaderboard cannot disagree about what a customer is
 * called. `sharedName` rides along whenever the two differ, so a screen can
 * show "সব শাখায়: সাদেক মিয়া" instead of quietly presenting a name the rest of
 * the shop does not use.
 *
 * @param {Object} customer plain customer object (carries the canonical name)
 * @param {Object|null} row this branch's CustomerBalance row
 */
const resolveBranchName = (customer, row) => {
  const local = row?.localName || null;
  const shared = customer?.name || '';
  return {
    name: local || shared,
    // Only set when the branch has deliberately renamed AND the two differ —
    // a screen showing "সব শাখায়: X" beside an identical X is just noise.
    sharedName: local && local !== shared ? shared : null,
    hasLocalName: Boolean(local),
  };
};

/**
 * The stat cards above the customer list, computed server-side.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The page used to build these by `reduce`-ing the rows it had been handed:
 *
 *     const totalDue = customerList.reduce((s, c) => s + (c.totalDue || 0), 0)
 *
 * which is the current PAGE — twenty rows. A shop with 127 customers in debt saw
 * "মোট বাকি ৳৭,৮৮,৯৪৭" against a real book of ৳১,৪৮,৭১,০৮২, and the figure moved
 * every time they re-sorted, because a different twenty were on screen. The same
 * shop's smaller branch showed a correct total — it had 15 debtors, so the whole
 * book fitted on one page and the bug was invisible there. Two branches, same
 * screen, one right and one wrong: unfixable from the client, because the client
 * has never seen the other 107 rows.
 *
 * So the total is computed where the filter is applied, next to the `$count`
 * that was already being trusted for `pagination.total`.
 */
const SUMMARY_GROUP = {
  $group: {
    _id: null,
    totalDue: { $sum: { $ifNull: ['$totalDue', 0] } },
    totalPurchases: { $sum: { $ifNull: ['$totalPurchases', 0] } },
    customersWithDue: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$totalDue', 0] }, 0] }, 1, 0] } },
  },
};

/** Zero-fill the summary so the client never has to guard on an empty result. */
const normalizeSummary = (row) => ({
  totalDue: round2(row?.totalDue),
  totalPurchases: round2(row?.totalPurchases),
  customersWithDue: row?.customersWithDue || 0,
});

/**
 * Two-decimal money rounding, for arithmetic on figures already validated.
 *
 * Delegates to `quantizeMoney` rather than doing its own
 * `Math.round((n + Number.EPSILON) * 100) / 100`. That form looks equivalent and
 * is not: `Number.EPSILON` is an ABSOLUTE 2.2e-16, so adding it stops mattering
 * above ~2 and the helper rounded ~0.8% of paisa-boundary values the other way
 * from the rest of the codebase (2.135 -> 2.13 against 2.14). A due total that
 * disagrees by a paisa with the invoice it came from is the drift
 * `invoiceMath.util.js` exists to prevent. See `quantity.util.js` for why the
 * nudge has to be proportional to the value.
 */
const round2 = (n) => quantizeMoney(n || 0);

/** Query-string booleans arrive as 'true'/'false' strings, never as booleans. */
const isTrue = (value) => value === true || value === 'true';

/** Money never travels as a string. Rejects NaN/Infinity/negative-zero noise. */
const toAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

/**
 * Ceiling on one import batch. The commit loop is one `createCustomer` — and so
 * one transaction — per row, so an unbounded file would hold a request open for
 * minutes and time out halfway through, leaving a partially imported book with
 * no clear resume point.
 */
const IMPORT_ROW_LIMIT = 1000;

class CustomerService {
  /**
   * The customer list, joined to the active branch's ledger (Phase 7).
   *
   * Starts from `CustomerBalance` rather than `Customer`, which is what makes
   * this branch's customers the only ones returned — a customer with no row
   * here has never transacted at this branch and must not appear. The
   * `{shop, branch, totalDue: -1}` index serves the due-sorted case outright.
   *
   * Every returned document keeps the same shape as the shop-wide list, with
   * the branch's figures in place of the shop-wide ones, so no caller has to
   * know which mode it is in.
   */
  async _getBranchCustomers(shopId, branchId, options = {}) {
    const { page = 1, limit = 20, search, hasDue, sortBy = 'createdAt', sortOrder = 'desc', deleted = false } = options;

    // Union of what the list and the leaderboard each allow — both funnel here.
    const sortField = ['createdAt', 'name', 'totalDue', 'totalPurchases', 'purchaseCount', 'lastPurchase'].includes(sortBy)
      ? sortBy : 'createdAt';
    const direction = sortOrder === 'asc' ? 1 : -1;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const match = {
      shop: new mongoose.Types.ObjectId(shopId),
      branch: new mongoose.Types.ObjectId(branchId),
    };
    if (hasDue === 'true' || hasDue === true) match.totalDue = { $gt: 0 };

    const postJoinMatch = { 'customer.isActive': !deleted };
    // The branch's own label is searchable too. Without this a branch that
    // renamed a customer could no longer find them by the name on its own
    // screen — which is the exact failure this feature exists to prevent,
    // reintroduced from the other direction.
    const searchOr = buildSearchOr(search, ['customer.name', 'localName'], 'customer.phone');
    if (searchOr) postJoinMatch.$or = searchOr;

    const [result] = await CustomerBalance.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'customers',
          localField: 'customer',
          foreignField: '_id',
          as: 'customer',
        },
      },
      { $unwind: '$customer' },
      { $match: postJoinMatch },
      {
        $project: {
          _id: '$customer._id',
          ...CUSTOMER_PROJECTION,
          ...BALANCE_PROJECTION,
          // `name` is overwritten by the branch's label when it has one. The
          // spread above already emitted `name: '$customer.name'`, so this key
          // must come after it — later keys win in a $project literal.
          name: { $ifNull: ['$localName', '$customer.name'] },
          // Carried so the row can show "সব শাখায়: X" when the two differ.
          sharedName: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $ifNull: ['$localName', null] }, null] },
                  { $ne: ['$localName', '$customer.name'] },
                ],
              },
              '$customer.name',
              null,
            ],
          },
        },
      },
      {
        $facet: {
          // Sorting by `name` sorts the resolved name, because the $project
          // above runs first — so the list orders by what the branch actually
          // reads, not by a label it never sees.
          data: [{ $sort: { [sortField]: direction } }, { $skip: skip }, { $limit: parseInt(limit) }],
          count: [{ $count: 'total' }],
          // The stat cards, over the WHOLE filtered set rather than the page.
          // See `_listSummary` for why this cannot be left to the client.
          totals: [SUMMARY_GROUP],
        },
      },
    ]);

    const total = result?.count?.[0]?.total || 0;

    return {
      data: result?.data || [],
      summary: normalizeSummary(result?.totals?.[0]),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  }

  // Get all customers with filtering, searching, pagination
  async getCustomers(shopId, options = {}, req = null) {
    // `deleted=true` is the recycle bin — the only screen in the app that can
    // see a soft-deleted customer, and therefore the only way back from
    // `deleteCustomer`. Parsed here rather than in each arm so both modes agree.
    const opts = { ...options, deleted: isTrue(options.deleted) };

    if (isBranchCustomerScope(req)) {
      return this._getBranchCustomers(shopId, req.branchId, opts);
    }

    const {
      page = 1,
      limit = 20,
      search,
      hasDue,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      deleted,
    } = opts;

    const query = { shop: shopId, isActive: !deleted };

    // Search by name or phone (regex-escaped — raw input is a ReDoS vector,
    // and the phone term is normalised — see `buildSearchOr`)
    const searchOr = buildSearchOr(search, ['name'], 'phone');
    if (searchOr) query.$or = searchOr;

    // Filter by due status
    if (hasDue === 'true' || hasDue === true) {
      query.totalDue = { $gt: 0 };
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'name', 'totalDue', 'totalPurchases', 'lastPurchase'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [customers, total, totals] = await Promise.all([
      Customer.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
      // Same figures the branch-scoped path returns from its $facet, so both
      // modes hand the page an identical `summary` and it never has to know
      // which one it is in.
      //
      // `shop` is cast explicitly: `find` would coerce a string id off the
      // query, the aggregation framework will not, and a silently unmatched
      // $match here reads as "this shop is owed ৳0" rather than as an error.
      Customer.aggregate([
        { $match: { ...query, shop: new mongoose.Types.ObjectId(shopId) } },
        SUMMARY_GROUP,
      ]),
    ]);

    return {
      data: customers,
      summary: normalizeSummary(totals[0]),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Overlay a customer document with the active branch's figures.
   *
   * Returns null when the customer has no row at this branch — they belong to
   * another branch entirely and, in branch scope, must not be readable here.
   */
  async _applyBranchFigures(customer, shopId, branchId) {
    const row = await CustomerBalance.findOne({
      shop: shopId,
      customer: customer._id,
      branch: branchId,
    }).lean();

    if (!row) return null;

    const plain = typeof customer.toObject === 'function' ? customer.toObject() : { ...customer };
    return {
      ...plain,
      ...resolveBranchName(plain, row),
      totalPurchases: row.totalPurchases || 0,
      totalPaid: row.totalPaid || 0,
      totalDue: row.totalDue || 0,
      // Overlaid for the same reason `totalDue` is: under separate books the
      // branch's credit is the only figure this page may show. Omitted, the
      // shop-wide advance would leak through the spread above and a branch
      // holding nothing would offer to spend another branch's deposit.
      advanceBalance: row.advanceBalance || 0,
      openingDue: row.openingDue || 0,
      purchaseCount: row.purchaseCount || 0,
      lastPurchase: row.lastPurchase || null,
    };
  }

  // Get single customer by ID
  async getCustomerById(shopId, customerId, req = null) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId })
      .populate('createdBy', 'name phone');

    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    if (isBranchCustomerScope(req)) {
      const scoped = await this._applyBranchFigures(customer, shopId, req.branchId);
      // A plain 404, not a "wrong branch" hint: unlike a sale, whose branch an
      // owner may legitimately need to find, a customer this branch has never
      // served is simply not theirs to see. Naming the other branch would leak
      // the very thing separate customer books exist to keep apart.
      if (!scoped) {
        throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
      }

      // How many branches share this person. The detail page is where editing
      // starts, so this is where the UI can say "phone and address changes go
      // to all N branches" BEFORE the change rather than after the confusion.
      // A count, never the branch names — which branches serve a customer is
      // exactly what separate books exist to keep private.
      scoped.branchCount = await CustomerBalance.countDocuments({
        shop: shopId, customer: customerId,
      });

      return scoped;
    }

    return customer;
  }

  // Get customer by phone
  async getCustomerByPhone(shopId, phone, req = null) {
    // Deliberately shop-wide in BOTH modes. This is the till's lookup: a known
    // phone must resolve to the one existing person, or the same human ends up
    // with two records and the scope toggle stops being reversible. What branch
    // scope changes is what comes back with them — this branch's figures only,
    // never another branch's dues.
    //
    // Normalised first. Phones are STORED normalised, and this compared the raw
    // parameter, so `/customers/phone/+8801792449180` found nobody while
    // `/customers/phone/01792449180` found the same person — the till reporting
    // "নতুন কাস্টমার" for a customer of ten years.
    const customer = await Customer.findOne({
      shop: shopId,
      phone: normalizePhone(phone),
      isActive: true,
    });
    if (!customer) return null;

    if (isBranchCustomerScope(req)) {
      const scoped = await this._applyBranchFigures(customer, shopId, req.branchId);
      // No row here yet — a first-time visit to this branch. Return them with
      // zeroed figures rather than null, so the till binds to the existing
      // person instead of creating a duplicate.
      // No row here yet — a first-time visit to this branch, so they get the
      // shop-wide name until this branch decides to call them something else.
      return scoped || {
        ...customer.toObject(),
        sharedName: null,
        hasLocalName: false,
        totalPurchases: 0, totalPaid: 0, totalDue: 0, advanceBalance: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null,
      };
    }

    return customer;
  }

  /**
   * Move a customer's pre-software debt by `amount`, in one transaction.
   *
   * The single writer for `openingDue`. Everything that can create debt without
   * an invoice — the create form, the CSV import, the owner's correction —
   * comes through here, so the four things that must happen together cannot
   * drift apart:
   *
   *   1. a `DueAdjustment` row (the audit trail and the খতিয়ান line)
   *   2. `Customer.openingDue` and `Customer.totalDue`, both by `amount`
   *   3. the same pair on `CustomerBalance` for this branch
   *   4. an `AuditLog` entry
   *
   * `totalDue` is `$inc`-ed rather than re-derived for the same reason every
   * other write path here does: a plain increment is safe under concurrency,
   * and the re-derivation (`Customer.deriveDue`) is reserved for the return
   * paths that genuinely need to re-clamp.
   *
   * Clamped so the result never goes below zero — this shop does not track
   * customer advances, so a −৳500 balance would be a figure no screen can
   * render honestly. A reduction larger than what is owed simply lands at zero,
   * and the row records what was actually applied.
   *
   * @param {number} amount signed delta; positive raises the due
   * @returns {{customer: Object, adjustment: Object, applied: number}}
   */
  async _applyDueAdjustment(shopId, userId, customerId, { amount, kind, note }, req) {
    return runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const branchId = req ? requireBranch(req) : null;

      const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
      if (!customer) {
        throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
      }

      // Debt cannot be written onto a deleted customer.
      //
      // `deleteCustomer` refuses to soft-delete anyone who still owes money, so
      // the pair (isActive: false, totalDue > 0) should be unreachable — and it
      // was reached anyway, from the other side: delete the customer at ৳0, then
      // add the opening due back on a page still open behind you. One shop ended
      // up with ৳106,305 owed by a customer their all-branches dashboard could
      // not see (it filters `isActive`) while the branch dashboard counted it,
      // which is precisely the kind of split that makes the two screens
      // irreconcilable. Guarding only the delete side left the door open.
      if (customer.isActive === false && amount > 0) {
        throw new AppError(
          'ডিলিট করা কাস্টমারের বাকি যোগ করা যাবে না — আগে কাস্টমার ফিরিয়ে আনুন',
          'Cannot add due to a deleted customer — restore them first',
          400
        );
      }

      // A reduction can only take away debt that is actually there. Without
      // this an owner correcting ৳500 on a customer who owes ৳200 would leave
      // `openingDue` at −৳300 while `totalDue` clamped at 0 — the two rollups
      // permanently disagreeing, which the recalc script would then report
      // forever as unexplained drift.
      const shopFloor = -Math.min(customer.openingDue || 0, customer.totalDue || 0);

      // A reduction in a multi-branch shop is allocated across the branches that
      // actually hold the debt rather than charged to the one the owner is
      // standing in — see `CustomerBalance.reduceOpening` for what that prevents.
      // `applied` is then whatever the branch books could really give up, so the
      // shop-wide rollup below moves by exactly the same figure and the Σ
      // invariant survives a partial allocation.
      let applied;
      let allocated = false;

      if (branchId && amount < 0) {
        const removed = await CustomerBalance.reduceOpening({
          shop: shopId,
          customer: customerId,
          preferBranch: branchId,
          amount: -amount,
          branchOnly: isBranchCustomerScope(req),
        }, session);

        if (removed === null) {
          // No branch rows at all — pre-Phase-7 history. Fall back to the
          // shop-wide floor and let `applyDelta` below create the row, which is
          // what keeps Σ tracking `Customer` rather than drifting further.
          applied = Math.max(amount, shopFloor);
        } else {
          applied = -removed;
          allocated = true;
        }
      } else {
        applied = Math.max(amount, shopFloor);
      }

      if (applied === 0) {
        return { customer, adjustment: null, applied: 0 };
      }

      // Quantized so the shop-wide rollup rounds exactly as the branch rows did
      // in `reduceOpening` — the Σ invariant is an equality, and two sides that
      // round differently break it by a paisa the recalc script then reports as
      // unexplained drift forever.
      customer.openingDue = quantizeMoney((customer.openingDue || 0) + applied);
      customer.totalDue = quantizeMoney((customer.totalDue || 0) + applied);
      await customer.save(sessionOpt);

      const [adjustment] = await DueAdjustment.create([{
        shop: shopId,
        customer: customerId,
        branch: branchId,
        kind: kind || 'adjustment',
        amount: applied,
        balanceAfter: customer.openingDue,
        note,
        createdBy: userId,
      }], sessionOpt);

      // Same arithmetic per branch. A no-op for single-branch shops, where
      // branchId is null — exactly like every other call site.
      //
      // Skipped when `reduceOpening` already wrote the rows: it has spread the
      // reduction across the branches holding the debt, and repeating it here
      // would take the money off twice.
      if (!allocated) {
        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: customerId,
          branch: branchId,
          opening: applied,
          due: applied,
        }, session);
      }

      await AuditLog.log({
        shop: shopId,
        user: userId,
        customer: customerId,
        action: kind === 'opening' ? 'customer_opening_due' : 'customer_due_adjust',
        description: `${applied > 0 ? 'Added' : 'Reduced'} opening due ৳${Math.abs(applied)} for ${customer.name || customer.phone}`,
        entity: { type: 'customer', id: customerId, name: customer.name },
        changes: {
          before: { openingDue: customer.openingDue - applied, totalDue: customer.totalDue - applied },
          after: { openingDue: customer.openingDue, totalDue: customer.totalDue },
        },
        req,
      });

      return { customer, adjustment, applied };
    });
  }

  /**
   * Set a customer's opening due to an absolute figure (owner-only).
   *
   * Takes the target, not a delta, because that is the question the owner can
   * actually answer: "খাতায় ওর কত বাকি ছিল?" The delta is arithmetic, and
   * arithmetic is our job. The `DueAdjustment` row still stores the delta, so
   * the খতিয়ান reads as a history of corrections rather than a series of
   * absolute restatements.
   */
  async setOpeningDue(shopId, userId, customerId, { openingDue, note }, req) {
    const target = toAmount(openingDue);
    if (Number.isNaN(target) || target < 0) {
      throw new AppError('সঠিক পরিমাণ দিন', 'Enter a valid amount', 400);
    }

    const customer = await Customer.findOne({ _id: customerId, shop: shopId }).lean();
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    // The delta is measured against the figure the owner was LOOKING AT.
    //
    // Under separate books `getCustomerById` returns the branch's `openingDue`,
    // so the form shows — and the owner corrects — a branch figure, while this
    // subtracted the shop-wide one. A customer holding ৳5,000 at নয়াগোলা and
    // ৳15,000 shop-wide, restated to ৳5,000 from নয়াগোলা, produced a delta of
    // −৳10,000 against a branch that held ৳5,000: the "no change" case computed
    // as a ৳10,000 write-down. That is where crossed and negative branch rows
    // come from, and capping the reduction per-branch only stops it corrupting
    // the other branch — it does not make this subtraction correct.
    let current = customer.openingDue || 0;
    if (isBranchCustomerScope(req)) {
      const row = await CustomerBalance.findOne({
        shop: shopId, customer: customerId, branch: req.branchId,
      }).lean();
      current = row?.openingDue || 0;
    }

    const delta = toAmount(target - current);
    if (delta === 0) {
      return { customer, adjustment: null, applied: 0 };
    }

    return this._applyDueAdjustment(
      shopId, userId, customerId,
      { amount: delta, kind: 'adjustment', note },
      req
    );
  }

  // Create new customer
  async createCustomer(shopId, userId, customerData, req) {
    const { name, address, notes } = customerData;
    // Normalised HERE, not left to `Customer.pre('save')`, because the
    // duplicate check below has to ask the same question the unique index will.
    // It did not: a form submitting `+8801792449180` looked up that literal
    // string, found nothing, and fell through to `Customer.create` — which
    // normalised on save and hit E11000 on {shop, phone}. A 500 where the shop
    // should have been told "this customer already exists".
    const phone = normalizePhone(customerData.phone);
    const branchId = req ? requireBranch(req) : null;

    // Owner-only and flag-gated — see `resolveWholesaleFlag`. Checked here
    // rather than on the route for the same reason `openingDue` is: the route
    // is open to anyone with `customers.create`, only this FIELD is restricted.
    const isWholesale = resolveWholesaleFlag(customerData.isWholesale, req);

    // Pre-software debt, optional. Owner-only — writing this conjures a
    // receivable out of nothing, so it is the one part of the customer form a
    // cashier must not reach. Checked here rather than on the route because the
    // route itself is open to anyone with `customers.create`; only this *field*
    // is restricted.
    const openingDue = toAmount(customerData.openingDue ?? 0) || 0;
    if (openingDue < 0 || Number.isNaN(openingDue)) {
      throw new AppError('পূর্বের বাকি ঋণাত্মক হতে পারবে না', 'Opening due cannot be negative', 400);
    }
    if (openingDue > 0 && req && !req.user?.isOwner && !req.isAdmin) {
      throw new AppError(
        'শুধুমাত্র দোকান মালিক পূর্বের বাকি যোগ করতে পারবেন',
        'Only the shop owner can set an opening due',
        403
      );
    }

    // Check if customer with same phone exists.
    //
    // Deliberately shop-wide even in branch scope: one human is one record, and
    // {shop, phone} is unique. In branch scope the customer will not be in this
    // branch's list, so this reads as "already exists" for a customer the staff
    // cannot see — which is the honest answer, and the alternative (a second
    // document for the same phone) is what makes the scope toggle irreversible.
    const existingCustomer = await Customer.findOne({ shop: shopId, phone });
    if (existingCustomer) {
      // ── The soft-deleted dead end ──────────────────────────────────────────
      //
      // A deleted customer still holds their phone — `{shop, phone}` is unique
      // over every document, active or not — while being invisible to every
      // read path in the app. So "add this customer again" was the one move the
      // shop would obviously try, and it could not work:
      //
      //   - shared book  → "এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে", pointing
      //                    at a record no screen can open;
      //   - branch book  → 200 OK from the adopt path below, a success toast,
      //                    and STILL nothing in the list, because the list
      //                    re-filters on `customer.isActive`. A silent no-op.
      //
      // One real shop lost six customers this way, one of them carrying
      // ৳1,06,305 of due that kept growing because `sale.service` bound new
      // invoices to the same hidden record.
      //
      // Re-adding a deleted customer IS the request to bring them back, so it
      // is honoured as one — through the same single writer the restore
      // endpoint uses, and audited as a restore rather than a create so the
      // trail says what actually happened to the record.
      const wasRestored = existingCustomer.isActive === false;
      if (wasRestored) {
        await this._restore(shopId, userId, existingCustomer, req, 'customer_create');
      }

      // In branch scope the customer may exist shop-wide while being absent
      // from THIS branch's list — so "already exists" would be a dead end for a
      // record the staff cannot see or reach. Adopt them into this branch and
      // return them instead: the same silent bind the till does when a known
      // phone is typed. Their dues and history stay with the branches that
      // earned them; only their presence in this list is new.
      if (isBranchCustomerScope(req)) {
        await CustomerBalance.applyDelta({ shop: shopId, customer: existingCustomer._id, branch: branchId });

        // The staff member typed a name for this phone. If it differs from the
        // shop-wide one, that is what THIS branch knows them as — record it as
        // this branch's label rather than discarding it (the old behaviour) or
        // overwriting what every other branch sees (the bug this replaces).
        const typedName = (name || '').trim();
        if (typedName && typedName !== existingCustomer.name) {
          await CustomerBalance.updateOne(
            { shop: shopId, customer: existingCustomer._id, branch: branchId },
            { $set: { localName: typedName } }
          );
        }
        // An opening due typed alongside is still meant: the customer is new to
        // THIS branch, and this branch's paper খাতা may well have carried them.
        // It lands on this branch's row, not on whatever they owe elsewhere.
        if (openingDue > 0) {
          const { customer: withDue } = await this._applyDueAdjustment(
            shopId, userId, existingCustomer._id,
            { amount: openingDue, kind: 'opening', note: 'অনবোর্ডিং — পূর্বের বাকি' },
            req
          );
          return this._applyBranchFigures(withDue, shopId, branchId);
        }
        // Returned through the overlay so the caller immediately sees the name
        // it just typed, not the shop-wide one.
        return this._applyBranchFigures(existingCustomer, shopId, branchId);
      }
      // Shared book. If they were deleted a moment ago they have just been
      // restored above, and the restore IS the outcome the shop asked for — so
      // hand them back rather than reporting a duplicate, which would leave the
      // record active while telling the staff member their action failed.
      //
      // Keyed on `wasRestored`, NOT on `existingCustomer.isActive`: by this
      // point the restore has already flipped that flag to true, so reading it
      // here would also swallow the ordinary duplicate error for a customer who
      // was never deleted at all.
      if (wasRestored) {
        return existingCustomer;
      }

      // Genuinely already in their list, so the error is both correct and
      // actionable. Unchanged from before Phase 7.
      throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
    }

    const customer = await Customer.create({
      shop: shopId,
      phone,
      name,
      address,
      notes,
      // Spread rather than assigned, so an untouched field falls to the schema
      // default instead of being written as an explicit `undefined`.
      ...(isWholesale === undefined ? {} : { isWholesale }),
      createdBy: userId,
    });

    // Zero balance row for the creating branch. Without it a customer created
    // from the customers page — who has no sales yet — would be invisible in
    // the very branch that just created them.
    await CustomerBalance.applyDelta({ shop: shopId, customer: customer._id, branch: branchId });

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_create',
      description: `Created customer: ${name} (${phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: name,
      },
      changes: {
        // Whitelisted, not the whole document — see utils/auditDiff.util.js.
        after: auditSnapshot(customer, AUDIT_FIELDS.customer),
      },
      req,
    });

    // The paper-খাতা balance, if one was given. Deliberately AFTER the customer
    // exists and as its own transaction: a failure here must leave a customer
    // with no opening due (fixable in one click from their page) rather than
    // roll back a customer the staff member has already been told about.
    if (openingDue > 0) {
      const { customer: withDue } = await this._applyDueAdjustment(
        shopId, userId, customer._id,
        { amount: openingDue, kind: 'opening', note: 'অনবোর্ডিং — পূর্বের বাকি' },
        req
      );
      return withDue;
    }

    return customer;
  }

  /**
   * Update a customer.
   *
   * ── The bug this rewrites ──────────────────────────────────────────────────
   *
   * This method had NO branch awareness at all. In separate-books mode any
   * branch that could reach a customer id rewrote that customer's name and
   * phone for every other branch, with no warning. A shop hit it for real:
   * Chittagong corrected a name and number, and Dhaka — who had been tracking
   * the same person as "Sadek" — could never find them again.
   *
   * ── What changed, and what deliberately did not ────────────────────────────
   *
   * In branch scope the NAME is now written to this branch's ledger row
   * (`CustomerBalance.localName`) instead of to the shared document. Each
   * branch keeps its own label; nobody's disappears.
   *
   * Everything else — phone, address, notes — still writes to the shared
   * document, on purpose. The phone is the identity: `{shop, phone}` is a
   * unique index, SMS is sent to it, and `Sale` snapshots it. Making it
   * per-branch would move a database guarantee into a racy application check
   * and, worse, would mean a corrected number never reached the branches still
   * dialling the old one — the original problem made permanent and silent.
   *
   * So a phone correction is still shared, which is right: every branch should
   * get it. What no longer travels is the branch's private label.
   */
  async updateCustomer(shopId, userId, customerId, updateData, req) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const branchScoped = isBranchCustomerScope(req);
    const branchId = branchScoped ? req.branchId : null;
    let balanceRow = null;

    if (branchScoped) {
      // Visibility rule, matching `getCustomerById`: a branch may only edit a
      // customer it actually serves. Previously any reachable id was editable.
      balanceRow = await CustomerBalance.findOne({
        shop: shopId, customer: customerId, branch: branchId,
      });
      if (!balanceRow) {
        throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
      }
    }

    const beforeData = customer.toObject();

    // Check if phone is being changed and if it conflicts.
    //
    // Normalised on both sides of the comparison, for the same reason
    // `createCustomer` is: the raw form value was compared against the stored
    // normalised one, so re-saving the SAME number written `+880 1792-449180`
    // read as a change, missed the conflict lookup (also raw), and only failed
    // at the unique index. Assigned back onto `updateData` so the value that
    // reaches `Object.assign` below is the one that was actually checked.
    if (updateData.phone) {
      updateData.phone = normalizePhone(updateData.phone);

      if (updateData.phone !== customer.phone) {
        const existingCustomer = await Customer.findOne({
          shop: shopId, phone: updateData.phone, _id: { $ne: customerId },
        });
        if (existingCustomer) {
          throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
        }
      }
    }

    // In branch scope the name is peeled off before the shared document is
    // touched, so `Object.assign` below can never carry it through.
    const sharedUpdate = { ...updateData };

    // Same peel, for the same reason, on a field that is NOT branch-local: the
    // `Object.assign` at the end of this method copies whatever the body held,
    // and this one must pass the flag + owner gate first. Deleting the key and
    // re-adding the resolved value is what makes that unbypassable — leaving it
    // in place and merely validating it would still let the raw value through.
    //
    // Shop-wide on purpose. A পাইকারি buyer is one at every branch (I-4:
    // identity lives on the Customer document, only the ledger is scoped), and
    // per-branch tiers would quote the same person two prices depending on
    // which till they walked up to.
    delete sharedUpdate.isWholesale;
    const nextWholesale = resolveWholesaleFlag(updateData.isWholesale, req);
    if (nextWholesale !== undefined) {
      sharedUpdate.isWholesale = nextWholesale;
    }
    let localNameChanged = false;
    const previousLocalName = balanceRow?.localName || null;

    if (branchScoped && Object.prototype.hasOwnProperty.call(sharedUpdate, 'name')) {
      const nextName = (sharedUpdate.name || '').trim();
      delete sharedUpdate.name;

      // Clearing the field (or typing the shop-wide name back) drops the
      // override rather than storing a duplicate — so a branch can always get
      // back to "just use the shared name" without an extra control.
      const nextLocal = !nextName || nextName === customer.name ? null : nextName;

      if ((balanceRow.localName || null) !== nextLocal) {
        balanceRow.localName = nextLocal;
        await balanceRow.save();
        localNameChanged = true;
      }
    }

    // Update customer
    Object.assign(customer, sharedUpdate);
    await customer.save();

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_update',
      description: `Updated customer: ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      // Field-level diff rather than two full documents. A branch-local rename
      // never reaches the shared document, so it would leave no trace at all
      // without being spliced in here.
      changes: (() => {
        const diff = auditDiff(beforeData, customer, AUDIT_FIELDS.customer);
        if (!localNameChanged) return diff;
        return {
          before: { ...(diff?.before || {}), localName: previousLocalName },
          after: { ...(diff?.after || {}), localName: balanceRow.localName, branch: String(branchId) },
        };
      })(),
      req,
    });

    // Return what this branch will now see, not the raw shared document — the
    // client re-renders from this response, and handing back the shop-wide
    // name right after a rename would flash the old label back onto the screen.
    if (branchScoped) {
      return this._applyBranchFigures(customer, shopId, branchId);
    }

    return customer;
  }

  /**
   * Bring a soft-deleted customer back. The single writer for `isActive: true`.
   *
   * ── Why this exists ──────────────────────────────────────────────────────────
   *
   * `deleteCustomer` was a one-way door. It is the only line in the codebase
   * that writes `isActive: false`, and until now nothing wrote it back — no
   * endpoint, no admin script, no UI. Every read filters the flag out, so a
   * mis-tap on ডিলিট removed a customer from the list, the search, the till
   * lookup, the due list, the leaderboard and the aging report at once, with no
   * screen anywhere that could still see them and no way to undo it.
   *
   * The record was never gone — soft delete, by definition — so the shop was
   * told their customer had vanished while the document sat in the database
   * holding the phone number that stopped them re-creating it.
   *
   * Shared by the restore endpoint and by `createCustomer`, which treats
   * "add this phone again" as the same request.
   *
   * @param {Object} customer a loaded, soft-deleted Customer document
   * @param {string} viaAction what to record the restore as ('customer_restore'
   *   from the endpoint, 'customer_create' when it came from the add form)
   */
  async _restore(shopId, userId, customer, req, viaAction = 'customer_restore') {
    customer.isActive = true;
    await customer.save();

    // Make sure the branch doing the restoring can actually SEE them. In branch
    // scope the list is driven by `CustomerBalance` rows, so restoring the
    // identity alone would flip the flag and change nothing on screen for the
    // person who pressed the button. Moves no money — `applyDelta` with no
    // deltas is a `$setOnInsert` of a zero row, exactly as `createCustomer`
    // does when adopting an existing customer into a new branch.
    const branchId = req ? requireBranch(req) : null;
    if (branchId) {
      await CustomerBalance.applyDelta({ shop: shopId, customer: customer._id, branch: branchId });
    }

    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: viaAction,
      description: `Restored customer: ${customer.name} (${customer.phone})`,
      entity: { type: 'customer', id: customer._id, name: customer.name },
      changes: { before: { isActive: false }, after: { isActive: true } },
      req,
    });

    return customer;
  }

  /**
   * Restore a soft-deleted customer (owner / `customers.delete` holders).
   *
   * Gated on `delete` rather than `update` deliberately: undoing a removal is
   * the same authority as making one, and a cashier who cannot delete a
   * customer has no business resurrecting one either.
   */
  async restoreCustomer(shopId, userId, customerId, req) {
    // Deliberately NOT `getCustomerById` — that read is what filters the
    // deleted customer out in the first place, and in branch scope it 404s on a
    // missing ledger row, which is precisely the state a restore has to fix.
    // `AppError` is (message, messageBn, statusCode) — English first. Much of
    // this file has the two the wrong way round, which is why its 404s surface
    // in English-language contexts as Bengali; not fixed wholesale here, but
    // new throws follow the actual signature.
    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('Customer not found', 'কাস্টমার পাওয়া যায়নি', 404);
    }

    if (customer.isActive !== false) {
      throw new AppError('This customer is not deleted', 'এই কাস্টমার মুছে ফেলা হয়নি', 400);
    }

    await this._restore(shopId, userId, customer, req);

    return isBranchCustomerScope(req)
      ? this._applyBranchFigures(customer, shopId, req.branchId)
      : customer;
  }

  // Delete customer (soft delete)
  async deleteCustomer(shopId, userId, customerId, req) {
    const customer = await Customer.findOne({ _id: customerId, shop: shopId });
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    // Check if customer has due balance
    if (customer.totalDue > 0) {
      throw new AppError('বাকি আছে এমন কাস্টমার ডিলিট করা যাবে না', 'Cannot delete customer with due balance', 400);
    }

    customer.isActive = false;
    await customer.save();

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'customer_delete',
      description: `Deleted customer: ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      req,
    });

    return { success: true };
  }

  // Record due payment
  async collectDuePayment(shopId, userId, customerId, paymentData, req) {
    return await runInTransaction(async (session) => {
      const { method, transactionId, notes } = paymentData;

    // When the customer actually handed the money over. Absent means now,
    // which is what every existing caller sends. `date` is accepted as an
    // alias because that is what the purchase and expense forms call the same
    // control, and a shopkeeper-facing API that needs two names for one idea is
    // a bug waiting to be filed. Refuses a future date and anything unparseable
    // — see `resolvePaidAt`.
    const paidAt = resolvePaidAt({ raw: paymentData.paidAt ?? paymentData.date, req });

    const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const branchId = req ? requireBranch(req) : null;
    const branchScoped = isBranchCustomerScope(req);

    // Coercing the amount, validating it against the right book, writing the
    // `due_collection` row, moving the fund account, reducing `Customer.totalDue`
    // and allocating the same reduction across the branch rows all now live in
    // `dueSettlement.service`. That is not indirection for its own sake: the POS
    // settles dues at checkout too, and two implementations of those six steps
    // would drift into a book that never reconciles. See that file's header.
    const { payment, amount, allocations } = await dueSettlementService.settleCustomerDue(
      {
        shopId,
        userId,
        customer,
        amount: paymentData.amount,
        branchId,
        branchScoped,
        method,
        rawAccount: paymentData.account,
        paidAt,
        transactionId,
        notes,
        req,
      },
      session
    );

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'due_collection',
      // The collection date rides in the description because it is the one
      // thing about this row a reader cannot recover from `createdAt` — and a
      // backdated collection is exactly the entry someone will later want to
      // know was backdated, and by whom.
      description: `Collected ৳${amount} from ${customer.name} (${customer.phone}) on ${toBangladeshDateStr(paidAt)}`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      changes: {
        before: { totalDue: quantizeMoney(customer.totalDue + amount) },
        after: { totalDue: customer.totalDue },
      },
      req,
    });

    // Send payment receipt SMS (non-blocking — runs in background)
    const SMSService = require('./sms.service');
    SMSService.sendPaymentReceiptAsync(shopId, userId, {
      customerId: customer._id,
      amount,
    });

    /**
     * `allocations` is which invoices this money actually closed.
     *
     * Returned because "your due went from ৳4,200 to ৳2,200" is a figure the
     * shopkeeper has to take on trust, and "HFG202600403 পরিশোধ হয়েছে" is one
     * they can check against the paper in the customer's hand. The screen that
     * takes the money is the only place this is cheap to show — afterwards it
     * has to be reconstructed from two collections and an allocation order.
     */
    return { customer, payment, allocations };
    });
  }

  /**
   * The খতিয়ান — one chronological account, with a running balance.
   *
   * Three streams merged into one column of entries: invoices raise the
   * balance, payments lower it, and opening/adjustment rows move it without any
   * invoice behind them. This is the only view in the app that answers "কীভাবে
   * এই বাকিটা তৈরি হলো" — the sales and payments tabs each show half the story
   * and neither carries a balance.
   *
   * Merged in memory rather than by `$unionWith`, deliberately. The running
   * balance has to be computed oldest-first over the WHOLE history, so a
   * database-side paginated union would still need the full set to know what
   * the first row on page 2 opens at. `limit` caps how many entries come back;
   * the balance on each is always the true one.
   */
  async getCustomerLedger(shopId, customerId, options = {}, req = null) {
    const { limit = 200 } = options;

    // Reuses the branch visibility rule — a customer with no row at this branch
    // 404s here exactly as they do on their detail page.
    const customer = await this.getCustomerById(shopId, customerId, req);

    // In SHARED mode the খতিয়ান is shop-wide, for the same reason the history
    // tab is: one book means one account. In SEPARATE mode it narrows, so the
    // running balance ends on the figure that branch's page shows.
    const scope = { shop: shopId, customer: customerId };
    if (isBranchCustomerScope(req)) scope.branch = req.branchId;

    const [sales, payments, adjustments, returns] = await Promise.all([
      Sale.find({ ...scope, status: { $ne: 'cancelled' } })
        .select('invoiceNo total createdAt')
        .sort({ createdAt: 1 })
        .lean(),
      Payment.find(scope)
        .select('amount method type sale createdAt paidAt notes')
        .sort({ createdAt: 1 })
        .lean(),
      DueAdjustment.find(scope)
        .select('amount kind note createdAt')
        .sort({ createdAt: 1 })
        .lean(),
      // Settled only. A store-credit return sits at `pending` and has moved no
      // money yet — crediting it here would show a balance the customer's
      // account does not actually have.
      SalesReturn.find({ ...scope, refundStatus: 'settled' })
        .select('returnNo totalAmount refundMethod createdAt settledAt')
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const entries = [];

    for (const s of sales) {
      // The invoice's own total is the debit. Whatever was paid at the till
      // arrives as its own Payment row, so counting `paid` here too would
      // credit it twice.
      entries.push({
        _id: String(s._id),
        type: 'sale',
        date: s.createdAt,
        label: `ইনভয়েস ${s.invoiceNo}`,
        ref: s.invoiceNo,
        saleId: String(s._id),
        debit: s.total || 0,
        credit: 0,
      });
    }

    // ── Why a return is two lines, not one ───────────────────────────────────
    //
    // Goods coming back credit the account; cash going out debits it. On a cash
    // refund both happen, and they cancel — which is exactly what the write
    // path does (`totalPurchases -= X` and `totalPaid -= X`, leaving due
    // unchanged). Booking only the refund payment would leave the ledger ৳X
    // above the customer's real due on every cash return.
    //
    // On an `adjustment` return there is no cash and so no Payment row: the
    // credit stands alone and the balance drops by X, matching the write path
    // that decrements purchases only.
    for (const r of returns) {
      entries.push({
        _id: String(r._id),
        type: 'return',
        date: r.settledAt || r.createdAt,
        label: `মাল ফেরত ${r.returnNo}`,
        ref: r.returnNo,
        debit: 0,
        credit: r.totalAmount || 0,
      });
    }

    for (const p of payments) {
      const isRefund = p.type === 'refund';
      entries.push({
        _id: String(p._id),
        type: isRefund ? 'refund' : 'payment',
        // The day the money moved, not the day it was typed. The merge below
        // sorts on this, so a বাকি আদায় backdated to last Tuesday sits between
        // last Tuesday's invoices — which is the whole point of the খতিয়ান.
        // `sort({ createdAt })` above only orders the fetch; the real ordering
        // is the in-memory one, so no index changes hands here.
        date: p.paidAt || p.createdAt,
        label: isRefund
          ? 'ফেরত (নগদ প্রদান)'
          : (p.type === 'due_collection' ? 'বাকি আদায়' : 'পেমেন্ট'),
        method: p.method,
        note: p.notes,
        saleId: p.sale ? String(p.sale) : null,
        // Cash handed back reverses the credit the customer got for paying.
        // Pairs with the return's credit line above.
        debit: isRefund ? (p.amount || 0) : 0,
        credit: isRefund ? 0 : (p.amount || 0),
      });
    }

    for (const a of adjustments) {
      entries.push({
        _id: String(a._id),
        type: a.kind === 'opening' ? 'opening' : 'adjustment',
        date: a.createdAt,
        label: a.kind === 'opening' ? 'পূর্বের বাকি (খাতা থেকে)' : 'বাকি সমন্বয়',
        note: a.note,
        debit: a.amount > 0 ? a.amount : 0,
        credit: a.amount < 0 ? -a.amount : 0,
      });
    }

    // Oldest first so the balance accumulates. Ties broken by type so an
    // opening balance entered on the same day as the first invoice reads before
    // it, which is the order the shopkeeper thinks in.
    const rank = { opening: 0, adjustment: 1, sale: 2, return: 3, refund: 4, payment: 5 };
    entries.sort((a, b) => {
      const d = new Date(a.date) - new Date(b.date);
      return d !== 0 ? d : (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    });

    let balance = 0;
    for (const e of entries) {
      balance = Math.round((balance + e.debit - e.credit) * 100) / 100;
      e.balance = balance;
    }

    // Newest first for display, but only after the balances are fixed.
    entries.reverse();

    return {
      customer,
      entries: entries.slice(0, parseInt(limit)),
      totals: {
        // What the ledger itself says is owed. Should equal `customer.totalDue`;
        // a gap means a write path updated one book and not the other, so it is
        // surfaced rather than hidden.
        closingBalance: Math.max(0, balance),
        rawBalance: balance,
        openingDue: customer.openingDue || 0,
        entryCount: entries.length,
        truncated: entries.length > parseInt(limit),
      },
    };
  }

  // Get customer purchase history
  async getCustomerHistory(shopId, customerId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;

    // Reuses the visibility rule above: in branch scope this 404s for a
    // customer with no row at this branch, so history cannot be reached by
    // guessing an id that the list does not show.
    const customer = await this.getCustomerById(shopId, customerId, req);

    const skip = (page - 1) * limit;

    // In SHARED mode this stays shop-wide on purpose — one book means a branch
    // sees the customer's invoices from every other branch too, which is the
    // whole point of sharing. In SEPARATE mode it narrows to this branch.
    const scope = { shop: shopId, customer: customerId };
    if (isBranchCustomerScope(req)) {
      scope.branch = req.branchId;
    }

    const [sales, payments, totalSales, totalPayments] = await Promise.all([
      Sale.find(scope)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      // Newest-first on the effective date, so a backdated collection sits with
      // the day it belongs to rather than jumping to the top of the list.
      // A row written before `paidAt` existed sorts as null, i.e. last — which
      // is where it belongs anyway, being older than everything that has one.
      // `scripts/backfill-payment-paid-at.js` stamps them and removes the
      // caveat entirely.
      Payment.find(scope)
        .sort({ paidAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Sale.countDocuments(scope),
      Payment.countDocuments(scope),
    ]);

    return {
      customer,
      sales: {
        data: sales,
        total: totalSales,
      },
      payments: {
        data: payments,
        total: totalPayments,
      },
    };
  }

  /**
   * Top N of this branch's ledger, joined back to the customer.
   *
   * Sorted and limited BEFORE the $lookup, so the join only ever touches the
   * rows that survive — this is the reason the ledger is its own collection
   * rather than an array on Customer, where the same query would mean an
   * $unwind and an in-memory sort over every customer in the shop.
   */
  async _topBranchBalances(shopId, branchId, { sortField, limit, extraMatch = {} }) {
    return CustomerBalance.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(shopId),
          branch: new mongoose.Types.ObjectId(branchId),
          ...extraMatch,
        },
      },
      { $sort: { [sortField]: -1 } },
      { $limit: parseInt(limit) },
      { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'customer' } },
      { $unwind: '$customer' },
      { $match: { 'customer.isActive': true } },
      {
        $project: {
          _id: '$customer._id',
          ...CUSTOMER_PROJECTION,
          ...BALANCE_PROJECTION,
          // Same override as the list — see `_getBranchCustomers`.
          name: { $ifNull: ['$localName', '$customer.name'] },
        },
      },
    ]);
  }

  // Get customers with due
  async getCustomersWithDue(shopId, options = {}, req = null) {
    const { limit = 50, minDue = 0 } = options;

    const branchScoped = isBranchCustomerScope(req);

    const customers = branchScoped
      ? await this._topBranchBalances(shopId, req.branchId, {
        sortField: 'totalDue',
        limit,
        extraMatch: { totalDue: { $gt: Number(minDue) } },
      })
      : await Customer.find({
        shop: shopId,
        isActive: true,
        totalDue: { $gt: minDue },
      })
        .sort({ totalDue: -1 })
        .limit(limit)
        .lean();

    // The same page-local-sum bug the customer list had, one endpoint over:
    // `customers` is the top `limit` (50 by default), so summing it described
    // the fifty largest debtors while claiming to be the whole book. The
    // summary is now counted over everything that matches, and only the ROWS
    // stay capped.
    const totals = branchScoped
      ? await CustomerBalance.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            branch: new mongoose.Types.ObjectId(req.branchId),
            totalDue: { $gt: Number(minDue) },
          },
        },
        { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
        { $unwind: '$c' },
        { $match: { 'c.isActive': true } },
        { $group: { _id: null, totalDue: { $sum: '$totalDue' }, count: { $sum: 1 } } },
      ])
      : await Customer.aggregate([
        {
          $match: {
            shop: new mongoose.Types.ObjectId(shopId),
            isActive: true,
            totalDue: { $gt: Number(minDue) },
          },
        },
        { $group: { _id: null, totalDue: { $sum: '$totalDue' }, count: { $sum: 1 } } },
      ]);

    return {
      customers,
      summary: {
        // How many debtors exist, not how many were returned. `customers.length`
        // is still available to a caller that wants the size of the slice.
        count: totals[0]?.count || 0,
        totalDue: round2(totals[0]?.totalDue),
        returned: customers.length,
      },
    };
  }

  // Get top customers by purchase
  async getTopCustomers(shopId, limit = 10, req = null) {
    if (isBranchCustomerScope(req)) {
      return this._topBranchBalances(shopId, req.branchId, { sortField: 'totalPurchases', limit });
    }

    const customers = await Customer.find({
      shop: shopId,
      isActive: true,
    })
      .sort({ totalPurchases: -1 })
      .limit(limit)
      .lean();

    return customers;
  }

  // Get customer leaderboard (sortable by purchaseCount, totalPurchases, totalDue)
  async getCustomerLeaderboard(shopId, options = {}, req = null) {
    const {
      page = 1,
      limit = 20,
      sortBy = 'purchaseCount',
      sortOrder = 'desc',
      search,
    } = options;

    const allowedSortFields = ['purchaseCount', 'totalPurchases', 'totalDue', 'lastPurchase', 'createdAt'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'purchaseCount';

    // The leaderboard is the customer list with a rank column, so it reuses the
    // same branch-joined query — one place where the visibility rule lives.
    if (isBranchCustomerScope(req)) {
      const skipRows = (parseInt(page) - 1) * parseInt(limit);
      const result = await this._getBranchCustomers(shopId, req.branchId, {
        page, limit, search, sortBy: sortField, sortOrder,
      });
      return {
        ...result,
        data: result.data.map((c, i) => ({ ...c, rank: skipRows + i + 1 })),
      };
    }

    // Was an UNESCAPED `$regex: search` on both fields — a ReDoS vector the
    // customer list had already been fixed for, still open on this endpoint.
    const query = { shop: shopId, isActive: true };
    const searchOr = buildSearchOr(search, ['name'], 'phone');
    if (searchOr) query.$or = searchOr;

    const skip = (page - 1) * limit;
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .select('name phone totalPurchases totalPaid totalDue openingDue purchaseCount lastPurchase tags createdAt')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
    ]);

    // Add rank
    const ranked = customers.map((c, i) => ({
      ...c,
      rank: skip + i + 1,
    }));

    return {
      data: ranked,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Check a parsed import batch WITHOUT writing anything.
   *
   * Exists so the preview screen can show a shopkeeper exactly what will happen
   * to two hundred rows before a single one is committed. Every rejection
   * reason it can return is one `bulkImportCustomers` would hit for the same
   * row, so "০ ভুল" on the preview means the import will not partially fail —
   * which matters because there is no undo for a batch of opening dues.
   *
   * Duplicate phones WITHIN the file are caught here too. The write path could
   * not see them (each row is a separate existence check, and the first insert
   * makes the second a conflict), so without this the user would get a
   * confusing "already exists" for a customer they are creating right now.
   */
  async validateImportRows(shopId, rows, req = null) {
    if (!Array.isArray(rows)) {
      throw new AppError('সঠিক ডেটা দিন', 'Invalid import payload', 400);
    }
    if (rows.length > IMPORT_ROW_LIMIT) {
      throw new AppError(
        `একবারে সর্বোচ্চ ${IMPORT_ROW_LIMIT}টি সারি আপলোড করা যাবে`,
        `At most ${IMPORT_ROW_LIMIT} rows per import`,
        400
      );
    }

    const canSetOpeningDue = Boolean(req?.user?.isOwner || req?.isAdmin);

    const normalized = rows.map((row) => ({
      phone: normalizePhone(String(row.phone ?? '').trim()),
      rawPhone: String(row.phone ?? '').trim(),
      name: String(row.name ?? '').trim(),
      address: String(row.address ?? '').trim(),
      openingDue: row.openingDue === '' || row.openingDue == null ? 0 : toAmount(row.openingDue),
    }));

    // One query for the whole batch rather than one per row — a 200-row import
    // was 200 round trips before the user saw anything.
    const phones = normalized.map((r) => r.phone).filter(Boolean);
    const existing = await Customer.find({ shop: shopId, phone: { $in: phones } })
      .select('phone name totalDue')
      .lean();
    const existingByPhone = new Map(existing.map((c) => [c.phone, c]));

    const seen = new Map();
    const checked = normalized.map((row, index) => {
      const errors = [];

      if (!row.rawPhone) {
        errors.push('ফোন নম্বর নেই');
      } else if (!row.phone || !/^01[3-9]\d{8}$/.test(row.phone)) {
        errors.push('ফোন নম্বর সঠিক নয়');
      }

      if (row.name.length > 100) errors.push('নাম ১০০ অক্ষরের বেশি');
      if (row.address.length > 500) errors.push('ঠিকানা ৫০০ অক্ষরের বেশি');

      if (Number.isNaN(row.openingDue)) {
        errors.push('পূর্বের বাকি সংখ্যা নয়');
      } else if (row.openingDue < 0) {
        errors.push('পূর্বের বাকি ঋণাত্মক হতে পারবে না');
      } else if (row.openingDue > 0 && !canSetOpeningDue) {
        errors.push('শুধু মালিক পূর্বের বাকি দিতে পারবেন');
      }

      if (row.phone) {
        if (seen.has(row.phone)) {
          errors.push(`ফাইলেই ডুপ্লিকেট (সারি ${seen.get(row.phone) + 1})`);
        } else {
          seen.set(row.phone, index);
        }

        const already = existingByPhone.get(row.phone);
        if (already) {
          errors.push(`এই নম্বরে কাস্টমার আছে (${already.name || row.phone})`);
        }
      }

      return {
        row: index + 1,
        phone: row.phone || row.rawPhone,
        name: row.name,
        address: row.address,
        openingDue: Number.isNaN(row.openingDue) ? 0 : row.openingDue,
        valid: errors.length === 0,
        errors,
      };
    });

    const validRows = checked.filter((r) => r.valid);

    return {
      rows: checked,
      summary: {
        total: checked.length,
        valid: validRows.length,
        invalid: checked.length - validRows.length,
        totalOpeningDue: validRows.reduce((sum, r) => sum + r.openingDue, 0),
        canSetOpeningDue,
      },
    };
  }

  /**
   * Commit an import batch.
   *
   * Re-validates rather than trusting the preview: the client may have sat on
   * the confirm button while another device created one of these customers, and
   * a stale preview must not become a duplicate or a double-counted opening
   * due. Invalid rows are skipped and reported, never guessed at.
   */
  async bulkImportCustomers(shopId, userId, customers, req) {
    const { rows } = await this.validateImportRows(shopId, customers, req);
    const results = [];

    for (const row of rows) {
      if (!row.valid) {
        results.push({ row: row.row, phone: row.phone, success: false, error: row.errors.join(', ') });
        continue;
      }

      try {
        const customer = await this.createCustomer(shopId, userId, {
          phone: row.phone,
          name: row.name,
          address: row.address,
          openingDue: row.openingDue,
        }, req);
        results.push({
          row: row.row,
          phone: row.phone,
          success: true,
          customerId: customer._id,
          openingDue: row.openingDue,
        });
      } catch (error) {
        results.push({ row: row.row, phone: row.phone, success: false, error: error.messageBn || error.message });
      }
    }

    const imported = results.filter((r) => r.success);

    return {
      results,
      summary: {
        total: results.length,
        imported: imported.length,
        failed: results.length - imported.length,
        totalOpeningDue: imported.reduce((sum, r) => sum + (r.openingDue || 0), 0),
      },
    };
  }

  /**
   * Due Aging Analysis — Groups customer dues by age buckets
   * Returns per-customer breakdown: 0-30 days, 31-60 days, 60+ days
   */
  async getDueAging(shopId, req = null) {
    const now = new Date();
    const days30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const days60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const matchStage = {
      shop: new mongoose.Types.ObjectId(shopId),
      due: { $gt: 0 },
      status: { $ne: 'cancelled' }
    };

    // Aging is derived from Sale.due, so it was already per-branch whenever a
    // branch was active — which was WRONG under shared customers: one book must
    // age as one book. It now follows the same flag as every other due read,
    // which also settles the older disagreement between this and
    // getCustomersWithDue about what "due" means.
    if (isBranchCustomerScope(req)) {
      matchStage.branch = new mongoose.Types.ObjectId(req.branchId);
    }

    const result = await Sale.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$customer',
          customerName: { $first: '$customerName' },
          customerPhone: { $first: '$customerPhone' },
          totalDue: { $sum: '$due' },
          due0to30: {
            $sum: { $cond: [{ $gte: ['$createdAt', days30] }, '$due', 0] }
          },
          due31to60: {
            $sum: { $cond: [{ $and: [{ $lt: ['$createdAt', days30] }, { $gte: ['$createdAt', days60] }] }, '$due', 0] }
          },
          due60plus: {
            $sum: { $cond: [{ $lt: ['$createdAt', days60] }, '$due', 0] }
          },
          oldestDue: { $min: '$createdAt' },
          saleCount: { $sum: 1 }
        }
      },
      { $sort: { totalDue: -1 } }
    ]);

    // ── Debt with no invoice behind it ───────────────────────────────────────
    //
    // Aging reads `Sale.due`, so without this pass the paper-খাতা balance would
    // be missing from it entirely — and a shop that onboarded ৳২ লাখ of old debt
    // would see ৳০ aged while every other screen showed the real figure. That
    // gap is the exact failure this report exists to prevent.
    //
    // Aged from when the adjustment was recorded, which for an onboarding
    // import is the day the shop started using the software. So old debt opens
    // in the 0–30 bucket and ages from there. It is not the true age of the
    // debt — the shop never told us that — but it is the honest age of the
    // claim, and it moves into 60+ on its own.
    const adjMatch = { shop: new mongoose.Types.ObjectId(shopId) };
    if (isBranchCustomerScope(req)) {
      adjMatch.branch = new mongoose.Types.ObjectId(req.branchId);
    }

    const adjustments = await DueAdjustment.aggregate([
      { $match: adjMatch },
      {
        $group: {
          _id: '$customer',
          totalDue: { $sum: '$amount' },
          due0to30: { $sum: { $cond: [{ $gte: ['$createdAt', days30] }, '$amount', 0] } },
          due31to60: {
            $sum: { $cond: [{ $and: [{ $lt: ['$createdAt', days30] }, { $gte: ['$createdAt', days60] }] }, '$amount', 0] }
          },
          due60plus: { $sum: { $cond: [{ $lt: ['$createdAt', days60] }, '$amount', 0] } },
          oldestDue: { $min: '$createdAt' },
        }
      },
      { $match: { totalDue: { $gt: 0 } } },
    ]);

    if (adjustments.length > 0) {
      const byCustomer = new Map(result.map((r) => [String(r._id), r]));
      // Adjustment rows carry no name — they are keyed by customer id, so any
      // customer with opening debt but no invoice yet needs one looked up.
      const missing = adjustments
        .filter((a) => !byCustomer.has(String(a._id)))
        .map((a) => a._id);
      const names = missing.length
        ? await Customer.find({ _id: { $in: missing } }).select('name phone').lean()
        : [];
      const nameById = new Map(names.map((c) => [String(c._id), c]));

      for (const a of adjustments) {
        const key = String(a._id);
        const row = byCustomer.get(key);
        if (row) {
          row.totalDue += a.totalDue;
          row.due0to30 += a.due0to30;
          row.due31to60 += a.due31to60;
          row.due60plus += a.due60plus;
          if (a.oldestDue && a.oldestDue < row.oldestDue) row.oldestDue = a.oldestDue;
        } else {
          const c = nameById.get(key);
          byCustomer.set(key, {
            _id: a._id,
            customerName: c?.name || c?.phone || '',
            customerPhone: c?.phone || '',
            totalDue: a.totalDue,
            due0to30: a.due0to30,
            due31to60: a.due31to60,
            due60plus: a.due60plus,
            oldestDue: a.oldestDue,
            saleCount: 0,
          });
        }
      }

      result.length = 0;
      result.push(...[...byCustomer.values()].sort((x, y) => y.totalDue - x.totalDue));
    }

    // ── Money already collected: netted at the SOURCE now, not here ──────────
    //
    // This report used to re-subtract every `Payment{type:'due_collection'}`
    // from its own buckets, oldest-first, because khata collections reduced
    // `Customer.totalDue` and the branch rows but never touched `Sale.due` — so
    // a shop that invoiced ৳50,000 and collected ৳50,000 read ৳0 on every other
    // screen and ৳50,000 here, aging into the red bucket.
    //
    // That was a patch on ONE of the ten readers that sum `Sale.due`; the other
    // nine stayed wrong, and this one only looked right because the same money
    // was being subtracted twice in two different places to cancel out once.
    //
    // The root cause is fixed — `dueSettlement.reallocateCustomerInvoices` now
    // allocates every collection onto the invoices that hold the debt, so
    // `Sale.due` is the truth and the buckets above are already net. Re-running
    // the subtraction here would now deduct the same collection a SECOND time
    // and under-report what the shop is owed, which on this screen means
    // debtors quietly dropping off the chase list.
    //
    // Deliberately deleted rather than left behind a flag: two subtractions with
    // one of them conditionally disabled is the state that produced the bug.

    // A customer settled in full is no longer aging — leaving them at ৳0 would
    // pad the list with rows a shop has nothing to chase on.
    const aged = result.filter((c) => c.totalDue > 0);
    result.length = 0;
    result.push(...aged.sort((x, y) => y.totalDue - x.totalDue));

    // ── Deleted customers ────────────────────────────────────────────────────
    //
    // Same population every other due screen counts (the dashboard tile, the
    // list, `getCustomersWithDue`). Without this the aging total is the one
    // figure on the page that still includes soft-deleted customers, and a shop
    // reconciling it against the dashboard finds a gap with nothing to explain
    // it.
    const ids = result.map((c) => c._id).filter(Boolean);
    if (ids.length > 0) {
      // Queried for the DELETED ones, not the live ones, so the filter below can
      // drop only what it positively knows to be deleted. A walk-in sale groups
      // under `_id: null` and has no customer document to look up; inverting
      // this ("keep what came back active") would silently drop that debt.
      const removed = await Customer.find({ _id: { $in: ids }, isActive: false })
        .select('_id').lean();

      if (removed.length > 0) {
        const removedIds = new Set(removed.map((c) => String(c._id)));
        const visible = result.filter((c) => !removedIds.has(String(c._id)));
        result.length = 0;
        result.push(...visible);
      }
    }

    // Summary totals
    const summary = result.reduce((acc, c) => ({
      totalDue: acc.totalDue + c.totalDue,
      due0to30: acc.due0to30 + c.due0to30,
      due31to60: acc.due31to60 + c.due31to60,
      due60plus: acc.due60plus + c.due60plus,
      customerCount: acc.customerCount + 1,
    }), { totalDue: 0, due0to30: 0, due31to60: 0, due60plus: 0, customerCount: 0 });

    return { customers: result, summary };
  }
}

module.exports = new CustomerService();

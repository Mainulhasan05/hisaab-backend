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
const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');
const mongoose = require('mongoose');

/** Escape user input before it reaches $regex — raw input is a ReDoS vector. */
const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Customer fields the list and leaderboard surface, projected out of a $lookup. */
const CUSTOMER_PROJECTION = {
  name: '$customer.name',
  phone: '$customer.phone',
  address: '$customer.address',
  notes: '$customer.notes',
  tags: '$customer.tags',
  isActive: '$customer.isActive',
  createdAt: '$customer.createdAt',
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
    const { page = 1, limit = 20, search, hasDue, sortBy = 'createdAt', sortOrder = 'desc' } = options;

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

    const postJoinMatch = { 'customer.isActive': true };
    if (search) {
      const escaped = escapeRegex(search);
      postJoinMatch.$or = [
        { 'customer.name': { $regex: escaped, $options: 'i' } },
        { 'customer.phone': { $regex: escaped, $options: 'i' } },
        // The branch's own label is searchable too. Without this a branch that
        // renamed a customer could no longer find them by the name on its own
        // screen — which is the exact failure this feature exists to prevent,
        // reintroduced from the other direction.
        { localName: { $regex: escaped, $options: 'i' } },
      ];
    }

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
        },
      },
    ]);

    const total = result?.count?.[0]?.total || 0;

    return {
      data: result?.data || [],
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
    if (isBranchCustomerScope(req)) {
      return this._getBranchCustomers(shopId, req.branchId, options);
    }

    const {
      page = 1,
      limit = 20,
      search,
      hasDue,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId, isActive: true };

    // Search by name or phone (regex-escaped — raw input is a ReDoS vector)
    if (search) {
      const escaped = escapeRegex(search);
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { phone: { $regex: escaped, $options: 'i' } },
      ];
    }

    // Filter by due status
    if (hasDue === 'true' || hasDue === true) {
      query.totalDue = { $gt: 0 };
    }

    const skip = (page - 1) * limit;
    const sortField = ['createdAt', 'name', 'totalDue', 'totalPurchases', 'lastPurchase'].includes(sortBy) ? sortBy : 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [customers, total] = await Promise.all([
      Customer.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Customer.countDocuments(query),
    ]);

    return {
      data: customers,
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
    const customer = await Customer.findOne({ shop: shopId, phone, isActive: true });
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
        totalPurchases: 0, totalPaid: 0, totalDue: 0, openingDue: 0, purchaseCount: 0, lastPurchase: null,
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

      // A reduction can only take away debt that is actually there. Without
      // this an owner correcting ৳500 on a customer who owes ৳200 would leave
      // `openingDue` at −৳300 while `totalDue` clamped at 0 — the two rollups
      // permanently disagreeing, which the recalc script would then report
      // forever as unexplained drift.
      const floor = -Math.min(customer.openingDue || 0, customer.totalDue || 0);
      const applied = Math.max(amount, floor);

      if (applied === 0) {
        return { customer, adjustment: null, applied: 0 };
      }

      customer.openingDue = (customer.openingDue || 0) + applied;
      customer.totalDue = (customer.totalDue || 0) + applied;
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
      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: customerId,
        branch: branchId,
        opening: applied,
        due: applied,
      }, session);

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

    const delta = toAmount(target - (customer.openingDue || 0));
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
    const { phone, name, address, notes } = customerData;
    const branchId = req ? requireBranch(req) : null;

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
      // Shared book: the customer really is in their list already, so the
      // error is both correct and actionable. Unchanged from before Phase 7.
      throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
    }

    const customer = await Customer.create({
      shop: shopId,
      phone,
      name,
      address,
      notes,
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

    // Check if phone is being changed and if it conflicts
    if (updateData.phone && updateData.phone !== customer.phone) {
      const existingCustomer = await Customer.findOne({ shop: shopId, phone: updateData.phone, _id: { $ne: customerId } });
      if (existingCustomer) {
        throw new AppError('এই ফোন নম্বর দিয়ে ইতিমধ্যে কাস্টমার আছে', 'Customer with this phone already exists', 400);
      }
    }

    // In branch scope the name is peeled off before the shared document is
    // touched, so `Object.assign` below can never carry it through.
    const sharedUpdate = { ...updateData };
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
      const sessionOpt = session ? { session } : {};
      const { amount, method, transactionId, notes } = paymentData;

    const customer = await Customer.findOne({ _id: customerId, shop: shopId }).session(session || null);
    if (!customer) {
      throw new AppError('কাস্টমার পাওয়া যায়নি', 'Customer not found', 404);
    }

    const branchId = req ? requireBranch(req) : null;
    const branchScoped = isBranchCustomerScope(req);

    // Validate against whichever book this shop keeps.
    //
    // In branch scope this MUST be the branch figure. Validating against the
    // shop-wide total would let a branch collect ৳5,000 against a due that
    // exists only at another branch — the collecting branch would go negative
    // and the owing branch would stay overstated, permanently, with no error.
    let branchBalance = null;
    if (branchScoped) {
      branchBalance = await CustomerBalance.findOne(
        { shop: shopId, customer: customerId, branch: branchId },
        null,
        sessionOpt
      );
      const branchDue = branchBalance?.totalDue || 0;
      if (amount > branchDue) {
        throw new AppError(
          'Payment amount exceeds this branch\'s due balance',
          'পেমেন্টের পরিমাণ এই শাখার বাকির চেয়ে বেশি',
          400
        );
      }
    } else if (amount > customer.totalDue) {
      throw new AppError('পেমেন্টের পরিমাণ বাকির চেয়ে বেশি', 'Payment amount exceeds due balance', 400);
    }

    // Create payment record. `branch` is required: cashRegister._calculateCashFlows
    // matches due collections by branch, so an untagged payment is invisible to
    // every branch's till and understates expected closing (FEATURE_AUDIT.md H-6).
    const [payment] = await Payment.create([{
      shop: shopId,
      branch: branchId,
      customer: customerId,
      amount,
      method: method || 'cash',
      transactionId,
      type: 'due_collection',
      notes,
      receivedBy: userId,
    }], sessionOpt);

    // Update customer balance — the shop-wide rollup is maintained in both
    // modes, so the flag stays a read-path switch with nothing to migrate.
    customer.totalPaid += amount;
    customer.totalDue -= amount;
    await customer.save(sessionOpt);

    // A due collection is not tied to an invoice, so it is allocated to the
    // branches that actually hold the debt — collecting branch first, then
    // oldest. In branch scope the check above guarantees it all lands on the
    // collecting branch.
    await CustomerBalance.settleDue({
      shop: shopId,
      customer: customerId,
      preferBranch: branchId,
      amount,
    }, session);

    // Create audit log with request metadata & customer reference
    await AuditLog.log({
      shop: shopId,
      user: userId,
      customer: customer._id,
      action: 'due_collection',
      description: `Collected ৳${amount} from ${customer.name} (${customer.phone})`,
      entity: {
        type: 'customer',
        id: customer._id,
        name: customer.name,
      },
      changes: {
        before: { totalDue: customer.totalDue + amount },
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

    return { customer, payment };
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
        .select('amount method type sale createdAt notes')
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
        date: p.createdAt,
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
      Payment.find(scope)
        .sort({ createdAt: -1 })
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

    const customers = isBranchCustomerScope(req)
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

    const totalDue = customers.reduce((sum, c) => sum + c.totalDue, 0);

    return {
      customers,
      summary: {
        count: customers.length,
        totalDue,
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

    const query = { shop: shopId, isActive: true };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

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

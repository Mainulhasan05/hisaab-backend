const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { requireBranch } = require('../utils/branchScope.util');
const { runInTransaction } = require('../utils/transaction.util');
const { quantizeMoney } = require('../utils/quantity.util');

/** Money never travels as a string. Rejects NaN/Infinity/negative-zero noise. */
const toAmount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

/**
 * May this request write a pre-software payable?
 *
 * Owner-only, checked on the FIELD rather than the route, for the same reason
 * `customer.service` checks `openingDue` this way: `POST /suppliers` is open to
 * anyone holding `suppliers.create`, and it is only this one field that
 * manufactures debt out of nothing. The dedicated `/opening-due` endpoint is
 * `ownerOnly` at the route as well, because there the whole request is the
 * privileged act.
 */
const assertMayWriteOpeningDue = (req) => {
  if (req && !req.user?.isOwner && !req.isAdmin) {
    throw new AppError(
      'শুধুমাত্র দোকান মালিক পূর্বের বাকি যোগ করতে পারবেন',
      'Only the shop owner can set an opening due',
      403
    );
  }
};

class SupplierService {
  /**
   * All suppliers, with the active branch's money.
   *
   * The LIST is deliberately shop-wide in every mode — every branch buys from
   * the same vendors, and a supplier hidden from a branch is a supplier that
   * branch cannot record a purchase against. What follows the active branch is
   * the FIGURES: `totalDue` here means "what this branch owes them", because
   * the branch that bought the goods is the branch that owes for them.
   *
   * With no branch selected (single-branch shop, or an owner viewing All
   * Branches) the shop-wide rollup is returned untouched — and the sum across
   * every branch IS that rollup, so both views are the same numbers at
   * different resolutions.
   */
  async getSuppliers(shopId, options = {}, req = null) {
    const {
      page = 1,
      limit = 50,
      search,
      sortBy = 'name',
      sortOrder = 'asc',
    } = options;

    const query = { shop: shopId, isActive: true };

    if (search) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        // The firm on the bill is as often what the shop remembers as the rep
        // who delivered it, so a search that only reads `name` sends them
        // hunting for a supplier that is right there.
        { companyName: { $regex: escaped, $options: 'i' } },
        { phone: { $regex: escaped, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const sortField = ['name', 'createdAt', 'totalDue'].includes(sortBy) ? sortBy : 'name';
    const sort = { [sortField]: sortOrder === 'desc' ? -1 : 1 };

    const [suppliers, total] = await Promise.all([
      Supplier.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Supplier.countDocuments(query),
    ]);

    // Sorting by `totalDue` still sorts on the shop-wide column even when a
    // branch is active — the page is chosen in Mongo before the overlay can
    // run. Accepted rather than hidden: sorting a page after the fact would
    // produce an order that changes as you page through it.
    const data = req?.branchId
      ? await SupplierBalance.overlayBranchFigures(suppliers, shopId, req.branchId)
      : suppliers;

    return {
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get single supplier
  async getSupplierById(shopId, supplierId, req = null) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
      isActive: true,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    // Same overlay as the list, so the detail page and the row it was opened
    // from cannot show different figures.
    if (req?.branchId) {
      const [scoped] = await SupplierBalance.overlayBranchFigures(
        [supplier.toObject()], shopId, req.branchId
      );
      return scoped;
    }

    return supplier;
  }

  // Create supplier
  async createSupplier(shopId, userId, data, req = null) {
    const { name, companyName, phone, address, notes } = data;

    // Pre-software payable, optional. Validated before anything is written, so
    // a bad figure cannot leave a supplier created and the debt refused.
    const openingDue = toAmount(data.openingDue ?? 0) || 0;
    if (Number.isNaN(openingDue) || openingDue < 0) {
      throw new AppError('পূর্বের বাকি ঋণাত্মক হতে পারবে না', 'Opening due cannot be negative', 400);
    }
    if (openingDue > 0) assertMayWriteOpeningDue(req);

    // Deliberately NOT `requireBranch` unless money is involved — this is where
    // suppliers part company with customers. A supplier is shop-wide by design
    // (every branch buys from the same vendors, see `getSuppliers`), so an owner
    // in All-Branches must still be able to add one; forcing a branch choice
    // there would block a shop-wide act on a branch-shaped rule. An opening due
    // IS branch-shaped — it lands in one branch's book — so `_applyOpeningDue`
    // calls `requireBranch` itself, and that check happens below, after the
    // duplicate-name test, where a BRANCH_REQUIRED error cannot mask a plain
    // "this supplier already exists".
    const branchId = req?.branchId || null;

    // Check duplicate name
    const existing = await Supplier.findOne({
      shop: shopId,
      name: { $regex: `^${name.trim()}$`, $options: 'i' },
      isActive: true,
    });

    if (existing) {
      throw new AppError('এই নামে সরবরাহকারী আগে থেকেই আছে', 'Supplier with this name already exists', 400);
    }

    const supplier = await Supplier.create({
      shop: shopId,
      name: name.trim(),
      companyName: companyName?.trim(),
      phone: phone?.trim(),
      address: address?.trim(),
      notes: notes?.trim(),
      createdBy: userId,
    });

    // Zero balance row for the creating branch, mirroring `createCustomer`.
    // Without it a supplier added from this page — who has no purchases yet —
    // carries no row at the branch that just created them, so the opening due
    // below would be the row's first write and `getBranchDueSummary` would be
    // the only screen that ever knew they existed there. A no-op for
    // single-branch shops, where `branchId` is null.
    await SupplierBalance.applyDelta({ shop: shopId, supplier: supplier._id, branch: branchId });

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_create',
      actionBn: 'নতুন সরবরাহকারী যোগ',
      description: `Added supplier: ${supplier.name}`,
      descriptionBn: `নতুন সরবরাহকারী যোগ: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
    });

    // The paper-খাতা balance, if one was given. Deliberately AFTER the supplier
    // exists and as its own transaction, exactly as `createCustomer` does it: a
    // failure here must leave a supplier with no opening due — fixable in one
    // click — rather than roll back a supplier the staff member has already
    // been told about.
    if (openingDue > 0) {
      const { supplier: withDue } = await this._applyOpeningDue(
        shopId, userId, supplier._id,
        { amount: openingDue, kind: 'opening', note: 'অনবোর্ডিং — পূর্বের বাকি' },
        req
      );
      return withDue;
    }

    return supplier;
  }

  /**
   * Move a supplier's pre-software payable by `amount`, in one transaction.
   *
   * The single writer for `openingDue`. Everything that can create a payable
   * without a purchase — the create form, the owner's later correction — comes
   * through here, so the four things that must happen together cannot drift
   * apart:
   *
   *   1. a `SupplierDueAdjustment` row (the audit trail and the খতিয়ান line)
   *   2. `Supplier.openingDue` and `Supplier.totalDue`, both by `amount`
   *   3. the same pair on `SupplierBalance` for this branch
   *   4. an `AuditLog` entry
   *
   * ── Simpler than the customer side, deliberately ────────────────────────────
   *
   * `customer.service._applyDueAdjustment` has to spread a reduction across
   * branches (`CustomerBalance.reduceOpening`) because a customer's book can be
   * read shop-wide while the debt sits in several branches. Suppliers need none
   * of that: writes go through `requireBranch`, so a multi-branch shop always
   * has exactly one branch selected, and the figures the owner is looking at
   * are that branch's (`overlayBranchFigures`). The correction lands where it
   * was read. Single-branch shops have no rows at all, by design.
   *
   * Clamped so the result never goes below zero — a negative payable would be a
   * supplier advance, which this shop does not track, so a reduction larger
   * than what is owed simply lands at zero and the row records what was
   * actually applied.
   *
   * @param {number} amount signed delta; positive raises the payable
   * @returns {{supplier: Object, adjustment: Object|null, applied: number}}
   */
  async _applyOpeningDue(shopId, userId, supplierId, { amount, kind, note }, req = null) {
    return runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const branchId = req ? requireBranch(req) : null;

      const supplier = await Supplier.findOne({ _id: supplierId, shop: shopId }).session(session || null);
      if (!supplier) {
        throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
      }

      // Debt cannot be written onto a deleted supplier. The mirror of the guard
      // on `_applyDueAdjustment`, and it closes the same door from the same
      // side: soft-delete the supplier, then add an opening due from a page
      // still open behind you, and the shop ends up owing money that every
      // `isActive`-filtered screen refuses to show.
      if (supplier.isActive === false && amount > 0) {
        throw new AppError(
          'ডিলিট করা সরবরাহকারীর বাকি যোগ করা যাবে না — আগে ফিরিয়ে আনুন',
          'Cannot add due to a deleted supplier — restore them first',
          400
        );
      }

      // A reduction can only take away debt that is actually there, measured on
      // the book being corrected. Without this, reducing ৳500 on a supplier
      // owed ৳200 would leave `openingDue` at −৳300 while `totalDue` clamped at
      // 0 — the two rollups permanently disagreeing, which the recalc script
      // would then report forever as unexplained drift.
      let floorSource = { openingDue: supplier.openingDue || 0, totalDue: supplier.totalDue || 0 };
      if (branchId) {
        const row = await SupplierBalance.findOne(
          { shop: shopId, supplier: supplierId, branch: branchId }, null, sessionOpt
        ).lean();
        floorSource = { openingDue: row?.openingDue || 0, totalDue: row?.totalDue || 0 };
      }
      const floor = -Math.min(floorSource.openingDue, floorSource.totalDue);
      const applied = quantizeMoney(amount < 0 ? Math.max(amount, floor) : amount);

      if (applied === 0) {
        return { supplier, adjustment: null, applied: 0 };
      }

      supplier.openingDue = quantizeMoney((supplier.openingDue || 0) + applied);
      supplier.totalDue = quantizeMoney((supplier.totalDue || 0) + applied);
      await supplier.save(sessionOpt);

      const [adjustment] = await SupplierDueAdjustment.create([{
        shop: shopId,
        supplier: supplierId,
        branch: branchId,
        kind: kind || 'adjustment',
        amount: applied,
        balanceAfter: supplier.openingDue,
        note,
        createdBy: userId,
      }], sessionOpt);

      // Same arithmetic per branch. A no-op for single-branch shops, where
      // `branchId` is null — exactly like every other call site.
      await SupplierBalance.applyDelta({
        shop: shopId,
        supplier: supplierId,
        branch: branchId,
        opening: applied,
        due: applied,
      }, session);

      await AuditLog.create([{
        shop: shopId,
        user: userId,
        action: kind === 'opening' ? 'supplier_opening_due' : 'supplier_due_adjust',
        actionBn: applied > 0 ? 'সরবরাহকারীর পূর্বের বাকি যোগ' : 'সরবরাহকারীর পূর্বের বাকি কমানো',
        description: `${applied > 0 ? 'Added' : 'Reduced'} supplier opening due ৳${Math.abs(applied)} for ${supplier.name}`,
        descriptionBn: `সরবরাহকারীর পূর্বের বাকি ${applied > 0 ? 'যোগ' : 'কমানো'}: ${supplier.name}`,
        entity: { type: 'supplier', id: supplierId, name: supplier.name },
        changes: {
          before: { openingDue: supplier.openingDue - applied, totalDue: supplier.totalDue - applied },
          after: { openingDue: supplier.openingDue, totalDue: supplier.totalDue },
        },
      }], sessionOpt);

      return { supplier, adjustment, applied };
    });
  }

  /**
   * Set a supplier's opening due to an absolute figure (owner-only).
   *
   * Takes the target, not a delta, because that is the question the owner can
   * actually answer: "খাতায় ওকে কত দিতে হতো?" The delta is arithmetic, and
   * arithmetic is our job. The `SupplierDueAdjustment` row still stores the
   * delta, so the খতিয়ান reads as a history of corrections.
   *
   * The delta is measured against the figure the owner was LOOKING AT — with a
   * branch active that is the branch's `openingDue`, because that is what
   * `overlayBranchFigures` put on the screen. Subtracting the shop-wide figure
   * from a branch target is precisely the bug documented on
   * `customer.service.setOpeningDue`, where restating an unchanged branch
   * balance computed as a large write-down.
   */
  async setOpeningDue(shopId, userId, supplierId, { openingDue, note }, req = null) {
    assertMayWriteOpeningDue(req);

    const target = toAmount(openingDue);
    if (Number.isNaN(target) || target < 0) {
      throw new AppError('সঠিক পরিমাণ দিন', 'Enter a valid amount', 400);
    }

    const supplier = await Supplier.findOne({ _id: supplierId, shop: shopId }).lean();
    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    const branchId = req ? requireBranch(req) : null;
    let current = supplier.openingDue || 0;
    if (branchId) {
      const row = await SupplierBalance.findOne({
        shop: shopId, supplier: supplierId, branch: branchId,
      }).lean();
      current = row?.openingDue || 0;
    }

    const delta = toAmount(target - current);
    if (delta === 0) {
      return { supplier, adjustment: null, applied: 0 };
    }

    return this._applyOpeningDue(
      shopId, userId, supplierId,
      { amount: delta, kind: 'adjustment', note },
      req
    );
  }

  /**
   * One supplier's opening-due history, newest first.
   *
   * Narrowed to the active branch for the same reason the figures are: the
   * owner is reading the book they were shown. Shop-wide for single-branch
   * shops, where `branch` is null on every row.
   */
  async getOpeningDueHistory(shopId, supplierId, req = null, options = {}) {
    const { limit = 50 } = options;

    const scope = { shop: shopId, supplier: supplierId };
    if (req?.branchId) scope.branch = req.branchId;

    return SupplierDueAdjustment.find(scope)
      .select('amount kind note balanceAfter branch createdAt createdBy')
      .populate('createdBy', 'name phone')
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 50, 200))
      .lean();
  }

  // Update supplier
  async updateSupplier(shopId, userId, supplierId, data) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
      isActive: true,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    // Check duplicate name if name is being changed
    if (data.name && data.name.trim() !== supplier.name) {
      const existing = await Supplier.findOne({
        shop: shopId,
        name: { $regex: `^${data.name.trim()}$`, $options: 'i' },
        isActive: true,
        _id: { $ne: supplierId },
      });

      if (existing) {
        throw new AppError('এই নামে সরবরাহকারী আগে থেকেই আছে', 'Supplier with this name already exists', 400);
      }
    }

    const beforeData = { name: supplier.name, companyName: supplier.companyName, phone: supplier.phone };

    if (data.name) supplier.name = data.name.trim();
    if (data.companyName !== undefined) supplier.companyName = data.companyName?.trim();
    if (data.phone !== undefined) supplier.phone = data.phone?.trim();
    if (data.address !== undefined) supplier.address = data.address?.trim();
    if (data.notes !== undefined) supplier.notes = data.notes?.trim();

    // `openingDue` is deliberately NOT assignable here. It is a rollup of an
    // immutable ledger, not a profile field: writing it straight would leave
    // `SupplierDueAdjustment`, `SupplierBalance.openingDue` and `totalDue`
    // untouched and the books irreconcilable. Corrections go through
    // `setOpeningDue`, which is owner-only and writes all four together.
    await supplier.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_update',
      actionBn: 'সরবরাহকারী আপডেট',
      description: `Updated supplier: ${supplier.name}`,
      descriptionBn: `সরবরাহকারী আপডেট: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
      changes: {
        before: beforeData,
        after: { name: supplier.name, companyName: supplier.companyName, phone: supplier.phone },
      },
    });

    return supplier;
  }

  // Delete supplier (soft delete)
  async deleteSupplier(shopId, userId, supplierId) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    supplier.isActive = false;
    await supplier.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_delete',
      actionBn: 'সরবরাহকারী মুছে ফেলা',
      description: `Deleted supplier: ${supplier.name}`,
      descriptionBn: `সরবরাহকারী মুছে ফেলা: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
    });

    return { success: true };
  }
}

module.exports = new SupplierService();

const mongoose = require('mongoose');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
// Read by the payables aging report only — the bills themselves are where the
// age of a debt lives; `Supplier.totalDue` is a rollup and carries no dates.
const Purchase = require('../models/Purchase.model');
const Payment = require('../models/Payment.model');
const PaymentAccount = require('../models/PaymentAccount.model');
const supplierSettlement = require('./supplierSettlement.service');
const { PAYMENT_TYPES, PAYMENT_METHODS } = require('../config/constants');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { requireBranch, branchMatch, branchFilter } = require('../utils/branchScope.util');
const {
  ACCOUNT_DISPLAY_FIELDS,
  ACCOUNT_DISPLAY_PROJECT,
  accountDisplay,
} = require('../utils/accountDisplay.util');
const { paidAtMatch, LIVE_PAYMENT } = require('../utils/paymentDate.util');
const { endOfBangladeshDay } = require('../utils/bdTime.util');
const { runInTransaction } = require('../utils/transaction.util');
const { quantizeMoney } = require('../utils/quantity.util');
const { laterPaymentsLookup, PAID_AT_PURCHASE_EXPR } = require('../utils/purchasePayment.util');

/** Escape user input before it reaches $regex — raw input is a ReDoS vector. */
const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The two ways money leaves the shop for a vendor. Both, always, unless the
 * caller narrows it — see `getSupplierPaymentRegister`'s header for why one
 * without the other understates what the shop spent.
 */
const MONEY_OUT_TYPES = [PAYMENT_TYPES.PURCHASE_PAYMENT, PAYMENT_TYPES.SUPPLIER_ADVANCE];

/**
 * A register row's money, split by where it left from.
 *
 * A Payment row is one leg — one method, one account. A bill paid at the
 * counter may be several (৳৫,০০০ ক্যাশ + ৳১০,০০০ ব্যাংক) on `Purchase.payments[]`,
 * and attributing the whole bill to its largest leg's method — which is all
 * `paymentMethod` records — books ৳১৫,০০০ against the bank. So every row,
 * from either arm, carries `legs`, and the account filter and the per-account
 * totals read legs rather than rows.
 *
 * The bill arm falls back to ONE leg on `paymentMethod` whenever the legs do
 * not add up to the counter payment: bills from before fund accounts carry
 * `paid` alone, and a set of legs that disagrees with the row would make the
 * per-account totals disagree with the register total.
 */
const PAYMENT_ARM_LEGS = {
  $addFields: {
    legs: [{ method: '$method', account: { $ifNull: ['$account', null] }, amount: '$amount' }],
  },
};

const BILL_ARM_LEGS = {
  $cond: [
    {
      $and: [
        { $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] },
        {
          $lt: [
            { $abs: { $subtract: [{ $sum: '$payments.amount' }, '$atPurchaseAmount'] } },
            0.01,
          ],
        },
      ],
    },
    {
      $map: {
        input: '$payments',
        as: 'l',
        in: {
          method: '$$l.method',
          account: { $ifNull: ['$$l.account', null] },
          amount: '$$l.amount',
          reference: '$$l.reference',
        },
      },
    },
    [{ method: '$paymentMethod', account: null, amount: '$atPurchaseAmount' }],
  ],
};

/**
 * `?account=` and `?method=` from the query, validated.
 *
 * The account id is CAST here, once, because both arms hand it to a `$match`
 * and a `$filter` — and neither casts (I-3). A string id would match no leg and
 * the register would read ৳০ for the account the owner is looking at, with
 * nothing on the screen to say the filter was the problem.
 */
function parseLegFilter({ account, method } = {}) {
  let accountOid = null;
  if (account) {
    if (!mongoose.Types.ObjectId.isValid(String(account))) {
      throw new AppError('Invalid account', 'অ্যাকাউন্ট সঠিক নয়', 400);
    }
    accountOid = new mongoose.Types.ObjectId(String(account));
  }
  let methodWanted = null;
  if (method) {
    if (!Object.values(PAYMENT_METHODS).includes(String(method))) {
      throw new AppError('Invalid payment method', 'পেমেন্ট পদ্ধতি সঠিক নয়', 400);
    }
    methodWanted = String(method);
  }
  return { accountOid, methodWanted, active: Boolean(accountOid || methodWanted) };
}

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
      // Read before anything moves, for the audit entry at the end.
      const openingBefore = supplier.openingDue || 0;
      const dueBefore = supplier.totalDue || 0;
      const advanceBefore = supplier.advanceBalance || 0;
      const applied = quantizeMoney(amount < 0 ? Math.max(amount, floor) : amount);

      if (applied === 0) {
        return { supplier, adjustment: null, applied: 0 };
      }

      // The carried-in payable moves; both money halves are derived from it.
      // Adding `applied` straight onto `totalDue` said the same thing until a
      // supplier could hold our money — at which point recording old debt
      // against a vendor we have prepaid must CONSUME that credit rather than
      // leave the shop owing and in credit at once.
      Supplier.backfillTotalPaid(supplier);
      supplier.openingDue = quantizeMoney((supplier.openingDue || 0) + applied);
      Supplier.applyBalances(supplier);
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
      await SupplierBalance.recomputeBalances({
        shop: shopId, supplier: supplierId, branch: branchId,
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
          // Captured, not reconstructed as `totalDue − applied`: that arithmetic
          // was only ever right while the opening due and the payable moved in
          // lockstep, which they stop doing the moment a prepayment is involved.
          before: { openingDue: openingBefore, totalDue: dueBefore, advanceBalance: advanceBefore },
          after: {
            openingDue: supplier.openingDue,
            totalDue: supplier.totalDue,
            advanceBalance: supplier.advanceBalance,
          },
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
  async deleteSupplier(shopId, userId, supplierId, { acknowledgeDue = false } = {}) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    /**
     * An open position must be SEEN before it is deleted away.
     *
     * ── The payable half warns; it does not block ────────────────────────────
     *
     * `_applyOpeningDue` already refuses to ADD debt to a deleted supplier,
     * with a comment saying why: every read filters `isActive`, so the shop
     * ends up owing money no screen will show. Deleting a supplier the shop
     * ALREADY owes does the same damage from the other side, and nothing
     * stopped it — there was no guard here at all.
     *
     * But refusing outright is the wrong instrument. A shop closing an account
     * it has genuinely settled off the books, or clearing a vendor recorded
     * twice, has a real reason to remove a row that still shows a payable, and
     * the software has no way to know it is wrong. So the rule is the one the
     * fat-finger threshold already uses on the customer side: **warn, do not
     * block.** The first call is refused with the FIGURE in the message, and a
     * caller that comes back having shown the owner that figure may proceed.
     *
     * `acknowledgeDue` is therefore not a formality to be passed by default —
     * it is the record that a human was told what they were deleting, and the
     * audit entry below stores what the position was at that moment.
     *
     * ── The prepayment half still blocks, and that is not an oversight ───────
     *
     * A payable deleted away is money the shop owes someone else; the vendor
     * will come and ask. A PREPAYMENT deleted away is the shop's own claim on a
     * vendor holding its cash, and there is no refund door yet (Phase E's D4)
     * and no supplier restore endpoint at all — so acknowledging it would not
     * make it recoverable, it would only make it deliberate. Blocked until
     * there is a way to get the money back.
     */
    if ((supplier.advanceBalance || 0) > 0) {
      throw new AppError(
        'Cannot delete a supplier holding an advance — refund or use it first',
        `অগ্রিম জমা ৳${supplier.advanceBalance} আছে — আগে ফেরত নিন বা ব্যবহার করুন`,
        400
      );
    }
    if ((supplier.totalDue || 0) > 0 && !acknowledgeDue) {
      throw new AppError(
        `This supplier is still owed ৳${supplier.totalDue} — confirm to delete anyway`,
        `এই সরবরাহকারীর ৳${supplier.totalDue} বাকি আছে — ডিলিট করলে হিসাব থেকে হারিয়ে যাবে`,
        400
      );
    }

    // Read before the flag flips, for the audit entry.
    const outstanding = supplier.totalDue || 0;

    supplier.isActive = false;
    await supplier.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_delete',
      actionBn: 'সরবরাহকারী মুছে ফেলা',
      description: `Deleted supplier: ${supplier.name}`
        + (outstanding > 0 ? ` (acknowledged outstanding due ৳${outstanding})` : ''),
      descriptionBn: `সরবরাহকারী মুছে ফেলা: ${supplier.name}`
        + (outstanding > 0 ? ` (৳${outstanding} বাকি রেখে)` : ''),
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
      // What the books said at the moment it was removed. Without this the only
      // record of a deleted-with-debt supplier is a row nothing will show.
      ...(outstanding > 0 ? { changes: { before: { totalDue: outstanding } } } : {}),
    });

    return { success: true };
  }

  /**
   * পাওনাদার বয়স — what the shop OWES, bucketed by how long it has owed it.
   *
   * ── Why this exists ─────────────────────────────────────────────────────
   *
   * `customer.service.getDueAging` has answered "who owes me, and for how
   * long" since early on. There was no counterpart, so a shop could see its
   * receivables by age and could see only a single `totalDue` number per
   * supplier for its payables — no way to tell a bill raised last week from
   * one that has been sitting since April.
   *
   * That asymmetry is the wrong way round for these businesses. An unprofitable
   * month is survivable and slow; a cash-flow squeeze is neither, and it
   * arrives through the payables side. This is the screen an owner decides who
   * to pay first from.
   *
   * ── Aged on `date`, NOT `createdAt` ─────────────────────────────────────
   *
   * The one place this deliberately differs from the customer report. A
   * `Purchase` carries a backdatable business `date` — the day the bill is
   * dated — and every other purchase reader (the list, the supplier statement,
   * the P&L's purchase bucket) filters on it. A bill dated the 3rd and entered
   * on the 20th has been owed since the 3rd, and that is what the supplier
   * will say when they call.
   *
   * Sales have no such field, which is why `getDueAging` uses `createdAt`
   * there. The two reports look symmetric and are not, and merging them onto
   * one date field would silently mis-age one side.
   *
   * ── Branch ──────────────────────────────────────────────────────────────
   *
   * Follows `req.branchId` when one is active — the branch that bought the
   * goods is the branch that owes for them, the same rule `getSuppliers`'
   * figures follow. With no branch (single-branch shop, or an owner in All
   * Branches) it is shop-wide, and the sum across branches IS that figure. No
   * `customerScope` equivalent to consult: suppliers have never had a shared /
   * separate book toggle.
   */
  /**
   * পরিশোধ — pay a supplier, oldest debt first.
   *
   * A thin wrapper: the arithmetic, the allocation and both books live in
   * `supplierSettlement.service`, which is the ONE place money reduces a
   * supplier's payable. Everything here is the shape the route needs.
   *
   * `requireBranch` because this is a write: a multi-branch shop always has one
   * branch active, and the payable being paid down is that branch's.
   */
  async paySupplier(shopId, userId, supplierId, data = {}, req = null) {
    return runInTransaction(async (session) => supplierSettlement.settleSupplierDue({
      shopId,
      userId,
      supplierId,
      amount: data.amount,
      branchId: req ? requireBranch(req) : null,
      method: data.method || 'cash',
      rawAccount: data.account || null,
      paidAt: data.paidAt || null,
      reference: data.reference,
      transactionId: data.transactionId,
      notes: data.notes,
      req,
    }, session));
  }

  /**
   * অগ্রিম — pay a vendor ahead of the goods.
   *
   * ── Why this is its own door and not just a bigger পরিশোধ ────────────────
   *
   * `paySupplier` refuses to pay past what is owed, and must keep refusing: a
   * mistyped ৳50,000 for ৳5,000 at the ordinary counter should bounce, not
   * quietly become a ৳45,000 claim on a vendor. Creating a prepayment is a
   * deliberate act — the shop is choosing to hand money over for goods it has
   * not received — so it gets a door of its own, and an owner-only one.
   *
   * Debt is still settled FIRST. A shop that owes ৳5,000 and hands over
   * ৳50,000 clears the ৳5,000 and holds ৳45,000 on account; it does not end up
   * owing and in credit with the same vendor at once, which the exclusivity
   * invariant forbids anyway.
   */
  async paySupplierAdvance(shopId, userId, supplierId, data = {}, req = null) {
    return runInTransaction(async (session) => supplierSettlement.settleSupplierDue({
      shopId,
      userId,
      supplierId,
      amount: data.amount,
      branchId: req ? requireBranch(req) : null,
      method: data.method || 'cash',
      rawAccount: data.account || null,
      paidAt: data.paidAt || null,
      reference: data.reference,
      transactionId: data.transactionId,
      notes: data.notes || 'অগ্রিম প্রদান',
      allowAdvance: true,
      req,
    }, session));
  }

  /** Reverse one, putting every book back exactly as it was. Owner-only route. */
  async voidSupplierPayment(shopId, userId, paymentId, data = {}, req = null) {
    return runInTransaction(async (session) => supplierSettlement.voidSupplierPayment({
      shopId, userId, paymentId, reason: data.reason, req,
    }, session));
  }

  /**
   * One supplier's payment history, newest first.
   *
   * Includes voided rows, marked. A payment history that hides reversals shows
   * a shop money it no longer has — and the reversal is usually the thing the
   * owner opened the screen to check.
   *
   * Rows are found BOTH ways: by `supplier` for money with no bill under it,
   * and through the bills for everything `recordPayment` ever wrote, which
   * carries no `supplier` of its own.
   */
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * সরবরাহকারী পরিশোধ — every taka this shop has paid OUT to a vendor
   * ─────────────────────────────────────────────────────────────────────────
   *
   * The mirror of `customer.service.getCollectionRegister`, pointed the other
   * way, and it exists for the same reason that one does: `getSupplierPayments`
   * below can only answer "what did I pay THIS vendor", which requires already
   * knowing which vendor. The question an owner actually opens a screen to ask
   * is "what went out this month, and to whom" — and there was nowhere to ask
   * it.
   *
   * ── Both money-out types, never one ──────────────────────────────────────
   *
   * `purchase_payment` settles a bill; `supplier_advance` is money handed over
   * before there is a bill. They are separate types precisely so reports can
   * tell a settlement from a prepayment — but a register of what LEFT the shop
   * needs both, or it shows an owner less money spent than their bank did. Same
   * call `_supplierRangeEntries` makes for the statement.
   *
   * ── Cancelled rows stay ──────────────────────────────────────────────────
   *
   * Struck through and counted separately, never dropped. A payment book that
   * quietly lost reversals shows a shop money it no longer has, and the
   * reversal is usually the thing the owner opened this screen to check.
   */
  async getSupplierPaymentRegister(shopId, options = {}, req = null) {
    const {
      page = 1,
      limit = 25,
      search = '',
      startDate,
      endDate,
      includeCancelled = true,
      types,
    } = options;
    const legFilter = parseLegFilter(options);

    const requested = String(types || '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => MONEY_OUT_TYPES.includes(t));
    const wanted = requested.length ? requested : MONEY_OUT_TYPES;

    const match = branchMatch(req || {}, {
      shop: new mongoose.Types.ObjectId(String(shopId)),
      type: { $in: wanted },
    });
    if (!includeCancelled) Object.assign(match, LIVE_PAYMENT);
    // A Payment row is a single leg, so the filter narrows it at the index
    // rather than after the union.
    if (legFilter.accountOid) match.account = legFilter.accountOid;
    if (legFilter.methodWanted) match.method = legFilter.methodWanted;

    // Collected rather than assigned — see the customer register's note: both
    // the date predicate and the search are `$or`s, and assigning the second
    // over the first drops the date range without a word.
    const clauses = [];
    const range = {};
    if (startDate) range.$gte = new Date(startDate);
    if (endDate) range.$lte = endOfBangladeshDay(new Date(endDate));
    const hasRange = Boolean(startDate || endDate);
    if (hasRange) clauses.push(paidAtMatch(range));

    /**
     * Search resolves to supplier ids first, for the same reason the customer
     * register does it: a Payment carries no vendor name to match. The bill
     * number is matched separately — a shopkeeper holding a চালান has that and
     * often nothing else, and the payment row itself stores only a reference to
     * the purchase, so the invoice numbers have to be resolved to ids too.
     */
    const term = String(search || '').trim();
    const rx = term ? new RegExp(escapeRegex(term), 'i') : null;
    let searchSupplierIds = [];
    if (term) {
      const [suppliers, bills] = await Promise.all([
        Supplier.find(
          { shop: shopId, $or: [{ name: rx }, { companyName: rx }, { phone: rx }] },
          '_id'
        ).limit(500).lean(),
        Purchase.find({ shop: shopId, invoiceNo: rx }, '_id').limit(500).lean(),
      ]);
      searchSupplierIds = suppliers.map((x) => x._id);
      const searchOr = [
        ...(suppliers.length ? [{ supplier: { $in: searchSupplierIds } }] : []),
        ...(bills.length ? [{ purchase: { $in: bills.map((x) => x._id) } }] : []),
        // The number printed on the voucher — what a vendor reads back when
        // they ring to ask about a payment. Same question the আদায় register
        // answers on the customer side.
        { receiptNo: rx },
      ];
      // An `$or: []` is a Mongo error, and a search that matched no vendor and
      // no bill must return nothing rather than everything.
      clauses.push({ $or: searchOr.length ? searchOr : [{ _id: null }] });
    }
    if (clauses.length) match.$and = clauses;

    /**
     * ── The bill arm: money paid AT THE COUNTER, which has no Payment row ────
     *
     * `createPurchase` only sets `Purchase.paid`; it writes no `Payment`. So a
     * shopkeeper who took delivery and paid ৳20,000 on the spot found nothing
     * here — the register listed only what was paid LATER — while the supplier
     * statement, which has always derived this figure, showed it. This is the
     * mirror of the customer register's `Sale.paid` arm, and it was missing.
     *
     * Shaped like a Payment row so the facet below needs no second code path:
     * `purchase` and a single allocation name the bill, `status` carries the
     * bill's own (a cancelled purchase is struck through and excluded from the
     * totals exactly like a voided payment), `paidAt` is the bill's `date`.
     * The amount is `purchasePayment.util`'s formula, the same one the
     * statement prints, so the two screens cannot disagree.
     *
     * Only when the caller wants `purchase_payment` rows — an অগ্রিম-only view
     * has no business listing bills.
     */
    const pipeline = [{ $match: match }, PAYMENT_ARM_LEGS];
    if (wanted.includes(PAYMENT_TYPES.PURCHASE_PAYMENT)) {
      const shopOid = new mongoose.Types.ObjectId(String(shopId));
      const billMatch = branchMatch(req || {}, { shop: shopOid, paid: { $gt: 0 } });
      if (!includeCancelled) billMatch.status = { $ne: 'cancelled' };
      if (hasRange) billMatch.date = range;
      if (term) {
        billMatch.$or = [
          { invoiceNo: rx },
          ...(searchSupplierIds.length ? [{ supplier: { $in: searchSupplierIds } }] : []),
        ];
      }
      // A coarse pre-filter only — it keeps the scan to bills that COULD have
      // a matching leg. Which part of a split bill actually matches is decided
      // after the union, on `legs`. `$and`, because `$or` above is the search.
      const legClauses = [];
      if (legFilter.accountOid) legClauses.push({ 'payments.account': legFilter.accountOid });
      if (legFilter.methodWanted) {
        legClauses.push({
          $or: [
            { 'payments.method': legFilter.methodWanted },
            { paymentMethod: legFilter.methodWanted },
          ],
        });
      }
      if (legClauses.length) billMatch.$and = legClauses;

      pipeline.push({
        $unionWith: {
          coll: Purchase.collection.name,
          pipeline: [
            { $match: billMatch },
            laterPaymentsLookup(shopOid),
            { $addFields: { atPurchaseAmount: PAID_AT_PURCHASE_EXPR } },
            // A bill paid entirely LATER has nothing left over — its money is
            // already in the payment arm, and a ৳0 row would only be noise.
            { $match: { atPurchaseAmount: { $gt: 0 } } },
            {
              $project: {
                type: { $literal: PAYMENT_TYPES.PURCHASE_PAYMENT },
                atPurchase: { $literal: true },
                amount: '$atPurchaseAmount',
                method: '$paymentMethod',
                paidAt: '$date',
                createdAt: 1,
                supplier: 1,
                purchase: '$_id',
                allocations: [{ purchase: '$_id', amount: '$atPurchaseAmount' }],
                status: 1,
                receivedBy: '$createdBy',
                branch: 1,
                notes: 1,
                receiptNo: { $literal: null },
                legs: BILL_ARM_LEGS,
              },
            },
          ],
        },
      });
    }

    /**
     * Under an account or method filter a row reports only the part that
     * moved through it.
     *
     * A ৳১৫,০০০ bill paid ৳৫,০০০ ক্যাশ + ৳১০,০০০ ব্যাংক is ৳১০,০০০ of the bank's
     * story, not ৳১৫,০০০ — and the register total under that filter is what the
     * owner holds up against the bank statement. `rowAmount` keeps the whole so
     * the screen can say "মোট ৳১৫,০০০" beside it. A Payment row is one leg, so
     * for it the two are always equal.
     */
    if (legFilter.active) {
      const conds = [];
      if (legFilter.accountOid) conds.push({ $eq: ['$$l.account', legFilter.accountOid] });
      if (legFilter.methodWanted) conds.push({ $eq: ['$$l.method', legFilter.methodWanted] });
      pipeline.push(
        { $addFields: { legs: { $filter: { input: '$legs', as: 'l', cond: { $and: conds } } } } },
        { $addFields: { rowAmount: '$amount', amount: { $round: [{ $sum: '$legs.amount' }, 2] } } },
        { $match: { amount: { $gt: 0 } } }
      );
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [faceted] = await Payment.aggregate([
      ...pipeline,
      {
        $facet: {
          rows: [
            { $sort: { paidAt: -1, createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
              $lookup: {
                from: Supplier.collection.name,
                localField: 'supplier',
                foreignField: '_id',
                pipeline: [{ $project: { name: 1, phone: 1, companyName: 1 } }],
                as: 'supplierDoc',
              },
            },
            {
              $lookup: {
                from: Purchase.collection.name,
                localField: 'purchase',
                foreignField: '_id',
                pipeline: [{ $project: { invoiceNo: 1 } }],
                as: 'purchaseDoc',
              },
            },
            /**
             * ── EVERY bill the payment landed on, not just the first ────────
             *
             * `purchase` holds one id, and `settleSupplierDue` sets it to
             * `allocations[0]` purely so the row has something to point at. One
             * ৳50,000 payment can clear four চালান, and this register named one
             * of them and silently dropped the rest — a reader reconciling a
             * vendor statement saw ৳50,000 against a ৳12,000 bill and had no
             * way to find where the other ৳38,000 went.
             *
             * Resolved here rather than on the client because the row stores
             * ids and the reader needs numbers. Bounded by the page size, and
             * the ids are already indexed as `_id`.
             */
            {
              $lookup: {
                from: Purchase.collection.name,
                localField: 'allocations.purchase',
                foreignField: '_id',
                pipeline: [{ $project: { invoiceNo: 1 } }],
                as: 'allocationDocs',
              },
            },
            {
              $lookup: {
                from: 'users',
                localField: 'receivedBy',
                foreignField: '_id',
                pipeline: [{ $project: { name: 1 } }],
                as: 'recordedByDoc',
              },
            },
            // Which account each leg left — names, never balances (see
            // accountDisplay.util). Empty for a shop without fund accounts.
            {
              $lookup: {
                from: PaymentAccount.collection.name,
                localField: 'legs.account',
                foreignField: '_id',
                pipeline: [{ $project: ACCOUNT_DISPLAY_PROJECT }],
                as: 'accountDocs',
              },
            },
            {
              $addFields: {
                legs: {
                  $map: {
                    input: { $ifNull: ['$legs', []] },
                    as: 'l',
                    in: {
                      $mergeObjects: ['$$l', {
                        accountDoc: {
                          $first: {
                            $filter: {
                              input: '$accountDocs',
                              as: 'd',
                              cond: { $eq: ['$$d._id', '$$l.account'] },
                            },
                          },
                        },
                      }],
                    },
                  },
                },
                supplier: { $first: '$supplierDoc' },
                invoiceNo: { $first: '$purchaseDoc.invoiceNo' },
                recordedBy: { $first: '$recordedByDoc' },
                voided: { $eq: ['$status', 'cancelled'] },
                effectiveAt: { $ifNull: ['$paidAt', '$createdAt'] },
                // `{ purchase, invoiceNo, amount }` per bill, in the order the
                // settlement walked them — oldest debt first. `$lookup` does
                // not preserve order, so the invoice number is matched back to
                // its slice rather than zipped by position.
                allocationDetails: {
                  $map: {
                    input: { $ifNull: ['$allocations', []] },
                    as: 'a',
                    in: {
                      purchase: '$$a.purchase',
                      amount: '$$a.amount',
                      invoiceNo: {
                        $first: {
                          $map: {
                            input: {
                              $filter: {
                                input: '$allocationDocs',
                                as: 'd',
                                cond: { $eq: ['$$d._id', '$$a.purchase'] },
                              },
                            },
                            as: 'd',
                            in: '$$d.invoiceNo',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              // A row with no bill behind it paid down the carried-in খাতা —
              // the same vocabulary `getSupplierPayments` hands the drill-in.
              $addFields: { againstOpeningDue: { $eq: ['$invoiceNo', null] } },
            },
            {
              $project: {
                supplierDoc: 0, purchaseDoc: 0, recordedByDoc: 0, allocationDocs: 0, accountDocs: 0,
              },
            },
          ],
          total: [{ $count: 'n' }],
          live: [
            { $match: LIVE_PAYMENT },
            { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
          ],
          /**
           * কোন অ্যাকাউন্ট থেকে কত — the whole filtered range, not the page.
           *
           * Per LEG, so a split bill lands in both its accounts. Σ of these
           * equals `summary.paid` by construction: every row's legs sum to its
           * `amount` (see `BILL_ARM_LEGS`), and under a filter both were cut
           * to the same matching legs.
           */
          byAccount: [
            { $match: LIVE_PAYMENT },
            { $unwind: '$legs' },
            {
              $group: {
                _id: { account: '$legs.account', method: '$legs.method' },
                amount: { $sum: '$legs.amount' },
              },
            },
            {
              $lookup: {
                from: PaymentAccount.collection.name,
                localField: '_id.account',
                foreignField: '_id',
                pipeline: [{ $project: ACCOUNT_DISPLAY_PROJECT }],
                as: 'accountDoc',
              },
            },
            {
              $project: {
                _id: 0,
                method: '$_id.method',
                amount: { $round: ['$amount', 2] },
                accountDoc: { $first: '$accountDoc' },
              },
            },
            { $sort: { amount: -1 } },
          ],
        },
      },
    ]);

    const total = faceted?.total?.[0]?.n || 0;
    const byType = {};
    let paid = 0;
    let liveCount = 0;
    for (const group of faceted?.live || []) {
      byType[group._id] = { amount: group.amount, count: group.count };
      paid += group.amount;
      liveCount += group.count;
    }

    // The account number is cut to its tail HERE, before anything leaves the
    // server — a raw `accountNumber` on the wire is one CSV export away from a
    // vendor's inbox.
    const payments = (faceted?.rows || []).map((row) => ({
      ...row,
      legs: (row.legs || []).map(({ accountDoc, ...leg }) => ({
        ...leg,
        account: accountDisplay(accountDoc),
      })),
    }));
    const byAccount = (faceted?.byAccount || []).map(({ accountDoc, ...group }) => ({
      ...group,
      account: accountDisplay(accountDoc),
    }));

    return {
      payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)) || 0,
      },
      summary: {
        paid,
        count: liveCount,
        cancelled: total - liveCount,
        byType,
        byAccount,
      },
    };
  }

  /**
   * One supplier payment voucher — টাকা প্রদানের রসিদ — ready to print.
   *
   * ── Why it reads the whole receipt group ────────────────────────────────
   *
   * One পরিশোধ can be written as up to three rows: the half that cleared the
   * carried-in খাতা, the half that landed on bills, and an অগ্রিম surplus
   * (`settleSupplierDue`'s header says why they cannot be one row). The vendor
   * was handed ONE sum, so the slip is one slip: it lists each part with its
   * own রসিদ নং, and leads with the first. Reprinting from ANY row of the
   * group returns the same voucher, so the paper never depends on which line
   * of the register someone tapped.
   *
   * Parts are voided one row at a time (`voidSupplierPayment`), so each part
   * carries its own `voided`; the voucher is VOID only when every part is.
   *
   * Money paid at the counter on the bill itself has no Payment row and no
   * number — the purchase invoice is its paper, as the register already says.
   */
  async getSupplierPaymentReceipt(shopId, paymentId, req = null) {
    if (!mongoose.Types.ObjectId.isValid(String(paymentId))) {
      throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
    }

    // Branch-scoped (I-2): a branch reprints its own vouchers, and an owner in
    // All Branches reprints any.
    // cancelled-inclusive: a voided payment still prints, stamped বাতিলকৃত —
    // the vendor is holding the original and that copy is the reply.
    const anchor = await Payment.findOne(
      branchFilter(req || {}, { _id: paymentId, shop: shopId, type: { $in: MONEY_OUT_TYPES } }),
      'receiptGroup'
    ).lean();
    if (!anchor) {
      throw new AppError('Payment not found', 'পেমেন্ট পাওয়া যায়নি', 404);
    }

    // cancelled-inclusive: each part's void is shown on the slip, not hidden.
    const rows = await Payment.find(branchFilter(req || {}, {
      shop: shopId,
      type: { $in: MONEY_OUT_TYPES },
      ...(anchor.receiptGroup ? { receiptGroup: anchor.receiptGroup } : { _id: anchor._id }),
    }))
      // Ids are minted in allocation order — খাতা, bills, অগ্রিম — so `_id`
      // is the order the money was applied in.
      .sort({ _id: 1 })
      .populate('account', ACCOUNT_DISPLAY_FIELDS)
      .populate('receivedBy', 'name')
      .populate('cancelledBy', 'name')
      .lean();
    const lead = rows[0];

    const billIds = new Set();
    for (const r of rows) {
      if (r.purchase) billIds.add(String(r.purchase));
      for (const a of r.allocations || []) if (a.purchase) billIds.add(String(a.purchase));
    }
    const bills = billIds.size
      ? await Purchase.find({ shop: shopId, _id: { $in: [...billIds] } }, 'invoiceNo supplier').lean()
      : [];
    const billById = new Map(bills.map((b) => [String(b._id), b]));

    // The vendor: named on the row for খাতা and অগ্রিম money, reached through
    // the bill for a payment recorded from a purchase screen.
    const supplierId = lead.supplier
      || rows.map((r) => billById.get(String(r.purchase))?.supplier).find(Boolean)
      || null;
    const supplier = supplierId
      ? await Supplier.findOne({ _id: supplierId, shop: shopId }, 'name phone companyName address').lean()
      : null;

    const parts = rows.map((r) => {
      const slices = (r.allocations || []).length > 0
        ? r.allocations
        : (r.purchase ? [{ purchase: r.purchase, amount: r.amount }] : []);
      return {
        _id: r._id,
        receiptNo: r.receiptNo || '',
        type: r.type,
        // advance → অগ্রিম · bills → named চালান · opening → পূর্বের বাকি
        kind: r.type === PAYMENT_TYPES.SUPPLIER_ADVANCE ? 'advance' : (slices.length ? 'bills' : 'opening'),
        amount: quantizeMoney(r.amount || 0),
        bills: slices.map((s) => ({
          purchase: s.purchase,
          invoiceNo: billById.get(String(s.purchase))?.invoiceNo || null,
          amount: quantizeMoney(s.amount || 0),
        })),
        voided: r.status === 'cancelled',
        cancelledAt: r.cancelledAt || null,
        cancelledBy: r.cancelledBy?.name || null,
        cancelReason: r.cancelReason || '',
      };
    });

    const live = parts.filter((p) => !p.voided);

    return {
      receiptNo: lead.receiptNo || '',
      paidAt: lead.paidAt || lead.createdAt,
      method: lead.method,
      account: accountDisplay(lead.account),
      reference: lead.reference || '',
      transactionId: lead.transactionId || '',
      notes: lead.notes || '',
      recordedBy: lead.receivedBy?.name || null,
      supplier: supplier
        ? {
          _id: supplier._id,
          name: supplier.name,
          phone: supplier.phone || '',
          companyName: supplier.companyName || '',
          address: supplier.address || '',
        }
        : null,
      parts,
      amount: quantizeMoney(live.reduce((sum, p) => sum + p.amount, 0)),
      totalAmount: quantizeMoney(parts.reduce((sum, p) => sum + p.amount, 0)),
      voided: live.length === 0,
      partiallyVoided: live.length > 0 && live.length < parts.length,
      // `null`, never 0, when the row predates the snapshot — a reader must be
      // able to tell "cleared" from "unknown" (Payment.dueBefore).
      dueBefore: lead.dueBefore ?? null,
      dueAfter: lead.dueAfter ?? null,
    };
  }

  async getSupplierPayments(shopId, supplierId, req = null, options = {}) {
    const limit = Math.min(parseInt(options.limit, 10) || 50, 200);
    const branchId = req?.branchId || null;

    const bills = await Purchase.find(
      { shop: shopId, supplier: supplierId, ...(branchId ? { branch: branchId } : {}) },
      '_id invoiceNo'
    ).lean();
    const invoiceById = new Map(bills.map((b) => [String(b._id), b.invoiceNo]));

    // cancelled-inclusive: a payment history that hides reversals shows a shop
    // money it no longer has, and the reversal is usually the thing the owner
    // opened this screen to check. Each row carries `voided` so the UI can
    // strike it through rather than pretend it never happened.
    const rows = await Payment.find({
      shop: shopId,
      type: PAYMENT_TYPES.PURCHASE_PAYMENT,
      ...(branchId ? { branch: branchId } : {}),
      $or: [
        { supplier: supplierId },
        { purchase: { $in: bills.map((b) => b._id) } },
      ],
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .limit(limit)
      .populate('receivedBy', 'name')
      .populate('account', ACCOUNT_DISPLAY_FIELDS)
      .lean();

    /**
     * Money paid ON the bill at delivery — no Payment row exists for it (see
     * `purchasePayment.util`), so without this the history of a vendor the
     * shop always pays cash-on-delivery read as empty. Same formula, and the
     * same row shape, as the shop-wide register's bill arm.
     */
    const atPurchase = bills.length === 0 ? [] : await Purchase.aggregate([
      {
        $match: {
          shop: new mongoose.Types.ObjectId(String(shopId)),
          _id: { $in: bills.map((b) => b._id) },
          paid: { $gt: 0 },
        },
      },
      laterPaymentsLookup(new mongoose.Types.ObjectId(String(shopId))),
      { $addFields: { atPurchaseAmount: PAID_AT_PURCHASE_EXPR } },
      { $match: { atPurchaseAmount: { $gt: 0 } } },
      {
        $project: {
          type: { $literal: PAYMENT_TYPES.PURCHASE_PAYMENT },
          atPurchase: { $literal: true },
          amount: '$atPurchaseAmount',
          method: '$paymentMethod',
          paidAt: '$date',
          createdAt: 1,
          purchase: '$_id',
          status: 1,
          receivedBy: '$createdBy',
          notes: 1,
        },
      },
    ]);

    const effective = (r) => new Date(r.paidAt || r.createdAt).getTime() || 0;
    const merged = [...rows, ...atPurchase]
      .sort((a, b) => effective(b) - effective(a))
      .slice(0, limit);

    return merged.map((r) => ({
      ...r,
      // A bill-arm row has no `account` key at all; a Payment row's is
      // populated above and cut to its display form here.
      ...('account' in r ? { account: accountDisplay(r.account) } : {}),
      voided: r.status === 'cancelled',
      // What it settled, in the shopkeeper's vocabulary: a row with no bill
      // behind it paid down the carried-in খাতা.
      invoiceNo: r.purchase ? invoiceById.get(String(r.purchase)) || null : null,
      againstOpeningDue: !r.purchase,
    }));
  }

  async getPayableAging(shopId, req = null) {
    const now = new Date();
    const days30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const days60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const shopObjId = new mongoose.Types.ObjectId(shopId);
    // I-3: `$match` does not cast. Both ids reach an aggregation, so both are
    // built as real ObjectIds — a string here matches nothing and the report
    // reads ৳0 with no error raised.
    const branchObjId = req?.branchId ? new mongoose.Types.ObjectId(req.branchId) : null;

    const purchaseMatch = {
      shop: shopObjId,
      due: { $gt: 0 },
      status: { $ne: 'cancelled' },
      ...(branchObjId ? { branch: branchObjId } : {}),
    };

    const bucket = (field, dateField) => ({
      due0to30: { $sum: { $cond: [{ $gte: [dateField, days30] }, field, 0] } },
      due31to60: {
        $sum: {
          $cond: [
            { $and: [{ $lt: [dateField, days30] }, { $gte: [dateField, days60] }] },
            field,
            0,
          ],
        },
      },
      due60plus: { $sum: { $cond: [{ $lt: [dateField, days60] }, field, 0] } },
    });

    const result = await Purchase.aggregate([
      { $match: purchaseMatch },
      {
        $group: {
          _id: '$supplier',
          supplierName: { $first: '$supplierName' },
          totalDue: { $sum: '$due' },
          ...bucket('$due', '$date'),
          oldestDue: { $min: '$date' },
          purchaseCount: { $sum: 1 },
        },
      },
      { $sort: { totalDue: -1 } },
    ]);

    /**
     * ── Debt with no bill behind it ────────────────────────────────────────
     *
     * The exact counterpart of the `DueAdjustment` pass in `getDueAging`, and
     * omitting it would produce the same failure: aging reads `Purchase.due`,
     * so a shop that onboarded ৳2 lakh of paper-খাতা payables would see ৳0 aged
     * here while every other screen showed the real figure — a gap on the one
     * report that exists to close it.
     *
     * Aged from `createdAt`, because that is the only date these rows have and
     * an onboarding import has no bill date to borrow. So old debt opens in the
     * 0–30 bucket and ages out of it on its own. That is the honest age of the
     * CLAIM rather than of the debt, which is the same compromise the customer
     * report documents and accepts.
     *
     * Signed: `amount` is a delta and a correction can be negative, so the sum
     * per supplier can legitimately reduce a payable. The `$gt: 0` filter is
     * applied after grouping, never per row.
     */
    const adjMatch = {
      shop: shopObjId,
      ...(branchObjId ? { branch: branchObjId } : {}),
    };

    /**
     * ── An advance never enters this report, and that is correct ────────────
     *
     * Ageing is built from `Purchase.due` and the adjustment rows, so a
     * prepayment — which lives on neither — cannot appear as aged debt, and
     * cannot net against another vendor's payable either (R1). Verified rather
     * than changed: the safety is structural, and it stays that way only while
     * this report keeps deriving from documents instead of from
     * `Supplier.totalDue`.
     *
     * Phase G owes the other half of this: once an advance can exist, it must
     * be CONSUMED against open bills rather than sitting beside them, or this
     * report will show bills as due while the vendor position says nothing is
     * owed. Auto-consumption on the next purchase is what keeps the two
     * agreeing.
     */
    const adjustments = await SupplierDueAdjustment.aggregate([
      { $match: adjMatch },
      {
        $group: {
          _id: '$supplier',
          totalDue: { $sum: '$amount' },
          ...bucket('$amount', '$createdAt'),
          oldestDue: { $min: '$createdAt' },
        },
      },
      { $match: { totalDue: { $gt: 0 } } },
    ]);

    if (adjustments.length > 0) {
      const bySupplier = new Map(result.map((r) => [String(r._id), r]));
      // Adjustment rows carry no name — they are keyed by supplier id, so a
      // supplier with opening debt and no bill yet needs one looked up.
      const missing = adjustments
        .filter((a) => !bySupplier.has(String(a._id)))
        .map((a) => a._id);
      const names = missing.length
        ? await Supplier.find({ _id: { $in: missing } }).select('name companyName phone').lean()
        : [];
      const nameById = new Map(names.map((s) => [String(s._id), s]));

      for (const a of adjustments) {
        const key = String(a._id);
        const row = bySupplier.get(key);
        if (row) {
          row.totalDue += a.totalDue;
          row.due0to30 += a.due0to30;
          row.due31to60 += a.due31to60;
          row.due60plus += a.due60plus;
          if (a.oldestDue && a.oldestDue < row.oldestDue) row.oldestDue = a.oldestDue;
        } else {
          const s = nameById.get(key);
          bySupplier.set(key, {
            _id: a._id,
            supplierName: s?.name || s?.companyName || '',
            totalDue: a.totalDue,
            due0to30: a.due0to30,
            due31to60: a.due31to60,
            due60plus: a.due60plus,
            oldestDue: a.oldestDue,
            purchaseCount: 0,
          });
        }
      }

      result.length = 0;
      result.push(...bySupplier.values());
    }

    // A supplier settled in full is not aging — leaving them at ৳0 pads the
    // list with rows there is nothing to pay. A negative total (over-paid, or
    // corrected past zero) is dropped for the same reason: it is not a payable,
    // and it belongs on the statement where it can be explained.
    const aged = result
      .filter((s) => s.totalDue > 0)
      .sort((x, y) => y.totalDue - x.totalDue);

    /**
     * Deleted suppliers.
     *
     * Same population every other payable figure counts. Without this the aging
     * total is the one number on the page that still includes soft-deleted
     * suppliers, and a shop reconciling it against the supplier list finds a
     * gap with nothing to explain it.
     *
     * Queried for the INACTIVE ones so the filter can drop only what it
     * positively knows to be deleted — a purchase with no supplier attached
     * groups under `_id: null` and has no document to look up. Inverting this
     * ("keep what came back active") would silently drop that debt.
     */
    const ids = aged.map((s) => s._id).filter(Boolean);
    let visible = aged;
    if (ids.length > 0) {
      const removed = await Supplier.find({ _id: { $in: ids }, isActive: false })
        .select('_id').lean();
      if (removed.length > 0) {
        const removedIds = new Set(removed.map((s) => String(s._id)));
        visible = aged.filter((s) => !removedIds.has(String(s._id)));
      }
    }

    const summary = visible.reduce((acc, s) => ({
      totalDue: quantizeMoney(acc.totalDue + s.totalDue),
      due0to30: quantizeMoney(acc.due0to30 + s.due0to30),
      due31to60: quantizeMoney(acc.due31to60 + s.due31to60),
      due60plus: quantizeMoney(acc.due60plus + s.due60plus),
      supplierCount: acc.supplierCount + 1,
    }), { totalDue: 0, due0to30: 0, due31to60: 0, due60plus: 0, supplierCount: 0 });

    return { suppliers: visible, summary };
  }
}

module.exports = new SupplierService();

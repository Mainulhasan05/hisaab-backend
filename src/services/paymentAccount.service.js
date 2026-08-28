const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount.model');
const AccountTransfer = require('../models/AccountTransfer.model');
const AccountEntry = require('../models/AccountEntry.model');
const AccountReconciliation = require('../models/AccountReconciliation.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { requireBranch, branchFilter } = require('../utils/branchScope.util');
const { runInTransaction } = require('../utils/transaction.util');
const { accountFilter, canUseAccount } = require('../utils/accountScope.util');
const { shopHasFeature } = require('../utils/features.util');

/**
 * Fund accounts — the shop's own money, by the place it sits.
 *
 * `applyAccountDelta` at the bottom is the ONLY writer of `PaymentAccount
 * .balance` anywhere in this codebase. That is not a style preference; it is
 * the entire defence against the drift that `variants[].stock` suffered, where
 * a second write path forgot the rollup and nothing noticed for months. If you
 * are about to `$inc` a balance from another service, call this instead.
 */
class PaymentAccountService {
  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Every account visible from the caller's position.
   *
   * `accountFilter`, never `branchFilter` — a plain branch predicate would hide
   * every shared bank account and MFS number. See accountScope.util.
   */
  async getAccounts(shopId, req, options = {}) {
    const { includeInactive = false } = options;

    const filter = accountFilter(req, { shop: shopId });
    if (!includeInactive) filter.isActive = true;

    const accounts = await PaymentAccount.find(filter)
      .sort({ type: 1, name: 1 })
      .lean();

    return {
      accounts,
      // Derived, never stored (D-1). Two copies of one number is how they end
      // up disagreeing, and this one is cheap: the list is already in memory
      // and a shop has a handful of accounts, not thousands.
      totalBalance: accounts.reduce((sum, a) => sum + (a.balance || 0), 0),
    };
  }

  /**
   * Names only, no balances — what a payment picker needs.
   *
   * Deliberately NOT behind `accounts.view`. A cashier must be able to say
   * which account took the money without being able to read what is in the
   * shop's bank account; those are different questions and this codebase
   * already separates them elsewhere (`products.view_cost` is the same shape).
   * The route gates this on the capability alone.
   */
  async getAccountOptions(shopId, req) {
    return PaymentAccount.find(accountFilter(req, { shop: shopId, isActive: true }))
      .select('name type method isDefault branch')
      .sort({ type: 1, name: 1 })
      .lean();
  }

  async getAccount(shopId, accountId, req) {
    const account = await PaymentAccount.findOne(
      accountFilter(req, { _id: accountId, shop: shopId })
    ).lean();

    if (!account) {
      throw new AppError('Account not found', 'অ্যাকাউন্টটি পাওয়া যায়নি', 404);
    }
    return account;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * @param {boolean} isOwner  — gates `openingBalance`. Enforced HERE and not on
   *   the route, the same shape as `Customer.openingDue` and `isWholesale`
   *   (I-7): the route is open to anyone with `accounts.create`, and only this
   *   one field is restricted.
   */
  async createAccount(shopId, userId, data, req, isOwner = false) {
    const { name, type, method, accountNumber, bankName, notes } = data;

    // A cash box belongs to a counter, everything else to the business. One
    // statement of the rule, on the model, so a second caller cannot get it
    // subtly different.
    const branch = PaymentAccount.branchFor(type, requireBranch(req));

    const openingBalance = this._resolveOpeningBalance(data.openingBalance, isOwner);

    // `openingDate` is not accepted from the client. Day one is today
    // (FUND_ACCOUNT_PLAN Q-3, settled) — the same thing `CashRegister` does
    // with its opening figure. A back-dated opening balance would have to
    // replay every movement since to mean anything, and it would mean
    // something different on every screen until it did.
    const account = await PaymentAccount.create({
      shop: shopId,
      branch,
      name,
      type,
      method,
      accountNumber,
      bankName,
      notes,
      openingBalance,
      openingDate: new Date(),
      // The opening figure IS the starting balance. Not zero — a shop adopting
      // this holds real money already, and a balance that starts at zero is
      // wrong from the first screen it appears on.
      balance: openingBalance,
      isActive: true,
      createdBy: userId,
    });

    await this._ensureSingleDefault(shopId, account, data.isDefault);

    await AuditLog.create({
      shop: shopId,
      branch,
      user: userId,
      action: 'account_create',
      actionBn: 'নতুন অ্যাকাউন্ট যোগ',
      description: `Created ${type} account: ${name}`,
      descriptionBn: `নতুন অ্যাকাউন্ট: ${name}`,
      entity: { type: 'payment_account', id: account._id, name: account.name },
      changes: { after: { name, type, method, openingBalance } },
    });

    return account;
  }

  async updateAccount(shopId, userId, accountId, data, req, isOwner = false) {
    const account = await PaymentAccount.findOne(
      accountFilter(req, { _id: accountId, shop: shopId })
    );
    if (!account) {
      throw new AppError('Account not found', 'অ্যাকাউন্টটি পাওয়া যায়নি', 404);
    }

    const before = { name: account.name, isActive: account.isActive };

    // Guarded with `in`, not truthiness. §13.7's reversibility trap: a form that
    // does not render a field does not send its key, and treating the absent
    // key as `undefined` would clear stored data the first time each row is
    // edited.
    if ('name' in data) account.name = data.name;
    if ('accountNumber' in data) account.accountNumber = data.accountNumber;
    if ('bankName' in data) account.bankName = data.bankName;
    if ('notes' in data) account.notes = data.notes;
    if ('isActive' in data) account.isActive = Boolean(data.isActive);

    /**
     * `type` and `method` are NOT editable, and this is load-bearing.
     *
     * `type` decides the branch rule, so changing it would move a cash box to
     * `branch: null` while its history stays tagged to one branch — the
     * account would still be in the list and every figure behind it would be
     * wrong. `method` is what historical rows resolve through; changing it
     * re-points money that has already been counted somewhere else.
     *
     * Both are cheap to get right at creation and impossible to migrate
     * afterwards, so the answer is to close the account and open another.
     */

    // Never movable through `update`, whatever the payload says. The route is
    // open to `accounts.update`; the FIELD is owner-only (I-7).
    if ('openingBalance' in data) {
      if (!isOwner) {
        throw new AppError(
          'Opening balance is owner-only',
          'শুরুর ব্যালান্স শুধু মালিক পরিবর্তন করতে পারবেন',
          403
        );
      }
      // Editing the opening figure moves the running balance by the same
      // amount, because everything after it is unchanged. Doing it any other
      // way silently discards every movement recorded since.
      const delta = this._resolveOpeningBalance(data.openingBalance, true) - (account.openingBalance || 0);
      account.openingBalance += delta;
      account.balance += delta;
    }

    await account.save();
    await this._ensureSingleDefault(shopId, account, data.isDefault);

    await AuditLog.create({
      shop: shopId,
      branch: account.branch,
      user: userId,
      action: 'account_update',
      actionBn: 'অ্যাকাউন্ট সম্পাদনা',
      description: `Updated account: ${account.name}`,
      descriptionBn: `অ্যাকাউন্ট সম্পাদনা: ${account.name}`,
      entity: { type: 'payment_account', id: account._id, name: account.name },
      changes: { before, after: { name: account.name, isActive: account.isActive } },
    });

    return account;
  }

  // ── The one writer of `balance` ────────────────────────────────────────────

  /**
   * Move an account's balance, and nothing else.
   *
   * ── Why every money path must come through here ──────────────────────────
   *
   * `balance` is a stored rollup. Stored rollups drift when a second write path
   * appears and does not know about them — that is exactly how `variants[]
   * .stock` ended up disagreeing with `product.stock`, silently, on live data.
   * One function means there is one place to audit and one place to fix.
   *
   * Rules:
   *   · `amount` is SIGNED. Positive is money in, negative is money out.
   *   · `session` is not optional in practice. A balance moved outside the
   *     transaction that moved the money it describes will survive a rollback
   *     the money did not.
   *   · A missing `accountId` is a NO-OP, not an error. A shop without the
   *     capability names no account on anything, and every caller would
   *     otherwise need the same `if` around it.
   *
   * @param {ObjectId|string|null} accountId
   * @param {number} amount   signed
   * @returns {Promise<boolean>} whether a row actually moved
   */
  async applyAccountDelta({ shop, account: accountId, amount, session = null }) {
    if (!accountId) return false;

    const delta = Number(amount) || 0;
    if (delta === 0) return false;

    if (!shop) {
      // I-5. A balance update with no shop predicate would be writable across
      // the whole platform, and Mongoose strips `undefined` from filters rather
      // than refusing them.
      throw new AppError('Shop is required', 'দোকান নির্বাচন করুন', 500);
    }

    const result = await PaymentAccount.updateOne(
      { _id: accountId, shop },
      { $inc: { balance: delta } },
      session ? { session } : {}
    );

    return result.modifiedCount > 0;
  }

  /**
   * Which account a bare `method` means.
   *
   * This is what lets the capability be adopted without rewriting a single
   * existing form: a POS that still posts `method: 'bkash'` and no account gets
   * its money booked to the shop's default bKash account rather than nowhere.
   *
   * Returns `null` for a shop without the capability, which makes every caller
   * a no-op by construction (I-1) rather than by a conditional at each site.
   */
  async resolveAccountForMethod(shop, method, req) {
    if (!shopHasFeature(shop, 'fundAccounts')) return null;
    if (!method) return null;

    const shopId = shop._id || shop;

    // The branch's own cash box beats the shared default, which is what makes
    // "cash" mean the right drawer in a multi-branch shop. `sort` puts the
    // branch-tagged row first because `null` sorts before an ObjectId ascending
    // — so descending gives the specific one priority.
    const [account] = await PaymentAccount.find(
      accountFilter(req, { shop: shopId, method, isActive: true })
    )
      .sort({ isDefault: -1, branch: -1 })
      .limit(1)
      .lean();

    return account?._id || null;
  }

  /**
   * Validate an account named by a caller before money is booked against it.
   *
   * Visibility is not enough on a write path: an owner in All-Branches view can
   * SEE every cash box, and must still not be able to book a Dhaka sale into
   * the Chittagong drawer.
   *
   * ── `expectedMethod` ──────────────────────────────────────────────────────
   *
   * When given, the account must ANSWER to that method. Nothing used to check
   * this, so a payload naming `method: 'bkash'` with the id of the cash box was
   * accepted and booked: the bKash balance stayed flat, the cash box gained
   * money nobody had put in it, and the day's cash count came up over with no
   * row to explain it. The cash register is the sharpest version — every one of
   * its queries selects on `method: 'cash'`, so a bKash payment landing in a
   * cash account is counted as cash on hand that does not exist.
   *
   * The UI narrows the picker to the chosen method (see AccountPicker), but a
   * stale tab, a retried request or a direct API call all reach this instead,
   * and each of them can carry a pairing the current UI can no longer produce.
   *
   * Optional because two callers legitimately have no method to check against:
   * `transferBetweenAccounts`, where the whole point is that the two ends
   * differ, and the COD courier account, whose method is `courier` by
   * construction and never a tender.
   */
  async assertUsableAccount(shopId, accountId, req, expectedMethod = null) {
    if (!accountId) return null;

    const account = await PaymentAccount.findOne({ _id: accountId, shop: shopId }).lean();
    if (!account || !account.isActive) {
      throw new AppError('Account not found', 'অ্যাকাউন্টটি পাওয়া যায়নি', 404);
    }
    if (!canUseAccount(req, account)) {
      throw new AppError(
        'Account belongs to another branch',
        'এই অ্যাকাউন্টটি অন্য শাখার',
        400
      );
    }
    if (expectedMethod && account.method !== expectedMethod) {
      throw new AppError(
        `Account method ${account.method} does not match payment method ${expectedMethod}`,
        'পেমেন্ট মাধ্যম আর অ্যাকাউন্টটি মিলছে না',
        400
      );
    }
    return account;
  }

  // ── Transfers ──────────────────────────────────────────────────────────────

  /**
   * Move money from one account to another.
   *
   * ── Why this is not an expense and not income ────────────────────────────
   *
   * Banking the day's takings is the most common thing a shop does with its
   * money and it was unrecordable. The two things a shopkeeper could do were
   * both wrong: record it as an expense, and the P&L says they spent ৳60,000
   * they did not spend; record nothing, and the cash register reports a
   * ৳60,000 shortfall every evening, which reads as theft.
   *
   * Nothing is earned and nothing is spent here. Only the CHARGE touches
   * profit, and that is a real cost.
   *
   * ── `amountOut` and `amountIn` are both given ────────────────────────────
   *
   * The shopkeeper knows what left and what arrived. They do not know which
   * side the fee came off — bKash deducts from the sender, some bank transfers
   * from the recipient — and asking them to work it out is asking them to get
   * it wrong. The difference IS the charge; it is never stored, only derived.
   */
  async createTransfer(shopId, userId, data, req) {
    const { fromAccount, toAccount, notes } = data;

    const amountOut = Number(data.amountOut);
    // Defaults to `amountOut`, which is the no-charge case and by far the most
    // common one — banking cash costs nothing. Making the shopkeeper retype the
    // same number to record the ordinary case would be a tax on the majority.
    const amountIn = data.amountIn == null || data.amountIn === ''
      ? amountOut
      : Number(data.amountIn);

    if (!Number.isFinite(amountOut) || amountOut <= 0) {
      throw new AppError('Invalid amount', 'পরিমাণ ০ এর বেশি হতে হবে', 400);
    }
    if (!Number.isFinite(amountIn) || amountIn <= 0) {
      throw new AppError('Invalid amount', 'যত টাকা পৌঁছেছে তা ০ এর বেশি হতে হবে', 400);
    }
    // More arriving than left is not a charge, it is a typo — and accepting it
    // would silently mint money into the shop's balances.
    if (amountIn > amountOut) {
      throw new AppError(
        'Received cannot exceed sent',
        'যত টাকা পৌঁছেছে তা পাঠানো টাকার চেয়ে বেশি হতে পারে না',
        400
      );
    }
    if (String(fromAccount) === String(toAccount)) {
      throw new AppError(
        'Cannot transfer to the same account',
        'একই অ্যাকাউন্টে ট্রান্সফার করা যাবে না',
        400
      );
    }

    // Both ends validated against the caller's position, not merely their
    // visibility. An owner in All-Branches can SEE every cash box and must
    // still not be able to move money out of another branch's drawer.
    const from = await this.assertUsableAccount(shopId, fromAccount, req);
    const to = await this.assertUsableAccount(shopId, toAccount, req);

    return runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const [transfer] = await AccountTransfer.create([{
        shop: shopId,
        // The branch that initiated it — NOT an account's branch, since a
        // shared bank account has none. This is what `cashRegister.service`
        // matches on, so banking the takings reaches the right drawer.
        branch: requireBranch(req),
        fromAccount: from._id,
        toAccount: to._id,
        amountOut,
        amountIn,
        date: data.date ? new Date(data.date) : new Date(),
        notes,
        createdBy: userId,
      }], sessionOpt);

      // Both legs, inside the transaction that created the transfer. A balance
      // moved outside it survives a rollback the money did not — and here that
      // would leave the shop's books permanently richer or poorer by the
      // transfer amount, with no document to explain it.
      //
      // The difference between the two deltas is the charge. It is not a third
      // movement: the money never reached an account of the shop's, so there is
      // nothing to debit it from.
      await this.applyAccountDelta({
        shop: shopId, account: from._id, amount: -amountOut, session,
      });
      await this.applyAccountDelta({
        shop: shopId, account: to._id, amount: amountIn, session,
      });

      await AuditLog.create([{
        shop: shopId,
        branch: transfer.branch,
        user: userId,
        action: 'account_transfer',
        actionBn: 'ফান্ড ট্রান্সফার',
        description: `Transfer ${transfer.transferNo}: ৳${amountOut} from ${from.name} → ৳${amountIn} to ${to.name}`,
        descriptionBn: `ফান্ড ট্রান্সফার ${transfer.transferNo}: ${from.name} থেকে ৳${amountOut}, ${to.name} এ ৳${amountIn}`,
        entity: { type: 'account_transfer', id: transfer._id, name: transfer.transferNo },
        changes: { after: { fromAccount: from.name, toAccount: to.name, amountOut, amountIn } },
      }], sessionOpt);

      return transfer;
    });
  }

  /**
   * Transfer history.
   *
   * `branchFilter`, not `accountFilter` — a transfer carries the branch that
   * made it, exactly like a sale or an expense, so the ordinary helper is the
   * right one. `accountFilter`'s `$or` exists for the ACCOUNTS themselves,
   * which can be shop-wide; a transfer never is.
   */
  async getTransfers(shopId, req, options = {}) {
    const { page = 1, limit = 20, accountId } = options;

    const filter = branchFilter(req, { shop: shopId });
    if (accountId) {
      filter.$or = [{ fromAccount: accountId }, { toAccount: accountId }];
    }

    const [transfers, total] = await Promise.all([
      AccountTransfer.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('fromAccount', 'name type method')
        .populate('toAccount', 'name type method')
        .populate('createdBy', 'name')
        .lean(),
      AccountTransfer.countDocuments(filter),
    ]);

    return {
      transfers,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Money that is not trade ────────────────────────────────────────────────

  /**
   * Owner deposits and withdrawals, loans, and corrections.
   *
   * ── What makes this different from an expense ────────────────────────────
   *
   * It moves the balance and never touches profit. An owner drawing ৳30,000 for
   * household costs has not made the shop ৳30,000 less profitable; they have
   * taken money out of it. Recording that as an expense — which is what shops
   * do when there is nowhere else to put it — understates every margin figure
   * the owner then reads.
   *
   * @param {boolean} isOwner gates `adjustment`, which is the one type that can
   *   move a balance with no real-world event behind it. A staff member able to
   *   write one has a way to paper over a till discrepancy.
   */
  async createEntry(shopId, userId, data, req, isOwner = false) {
    const { account: accountId, type, notes } = data;

    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError('Invalid amount', 'পরিমাণ ০ এর বেশি হতে হবে', 400);
    }

    if (type === 'adjustment') {
      if (!isOwner) {
        throw new AppError(
          'Adjustments are owner-only',
          'সমন্বয় শুধু মালিক করতে পারবেন',
          403
        );
      }
      // A correction with no reason is a number nobody can account for six
      // months later, which is the thing this collection exists to prevent.
      if (!notes || !String(notes).trim()) {
        throw new AppError(
          'An adjustment needs a reason',
          'সমন্বয়ের কারণ লিখুন',
          400
        );
      }
    }

    // Derived for every type that has one answer; only `adjustment` may name it.
    const direction = AccountEntry.directionFor(type) || data.direction;
    if (direction !== 'in' && direction !== 'out') {
      throw new AppError('Direction is required', 'টাকা ঢুকছে না বেরোচ্ছে, নির্দিষ্ট করুন', 400);
    }

    const account = await this.assertUsableAccount(shopId, accountId, req);

    return runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const [entry] = await AccountEntry.create([{
        shop: shopId,
        branch: requireBranch(req),
        account: account._id,
        type,
        direction,
        amount,
        date: data.date ? new Date(data.date) : new Date(),
        notes,
        createdBy: userId,
      }], sessionOpt);

      await this.applyAccountDelta({
        shop: shopId,
        account: account._id,
        amount: direction === 'out' ? -amount : amount,
        session,
      });

      await AuditLog.create([{
        shop: shopId,
        branch: entry.branch,
        user: userId,
        action: 'account_entry',
        actionBn: 'অ্যাকাউন্ট এন্ট্রি',
        description: `${type} ${direction} ৳${amount} on ${account.name}`,
        descriptionBn: `${account.name} — ৳${amount} ${direction === 'out' ? 'উত্তোলন' : 'জমা'} (${type})`,
        entity: { type: 'account_entry', id: entry._id, name: account.name },
        changes: { after: { type, direction, amount, account: account.name } },
      }], sessionOpt);

      return entry;
    });
  }

  async getEntries(shopId, req, options = {}) {
    const { page = 1, limit = 20, accountId } = options;

    const filter = branchFilter(req, { shop: shopId });
    if (accountId) filter.account = accountId;

    const [entries, total] = await Promise.all([
      AccountEntry.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('account', 'name type method')
        .populate('createdBy', 'name')
        .lean(),
      AccountEntry.countDocuments(filter),
    ]);

    return { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  /**
   * Record that the statement and the app were compared.
   *
   * `systemBalance` is read HERE, not accepted from the client: it is the whole
   * point of the record, and a figure the caller supplies is a figure the caller
   * can make agree.
   *
   * Deliberately does NOT move the balance. See the note at the bottom of
   * AccountReconciliation.model.js — a gap is evidence, and overwriting one side
   * with the other destroys it. An owner who has investigated writes an
   * `adjustment` entry, which is owner-only and carries a required reason.
   */
  async reconcileAccount(shopId, userId, data, req) {
    const { account: accountId, statementBalance, notes } = data;

    const stated = Number(statementBalance);
    if (!Number.isFinite(stated)) {
      throw new AppError('Invalid balance', 'স্টেটমেন্টের ব্যালান্স সঠিক নয়', 400);
    }

    const account = await this.assertUsableAccount(shopId, accountId, req);

    const [reconciliation] = await AccountReconciliation.create([{
      shop: shopId,
      branch: requireBranch(req),
      account: account._id,
      date: data.date ? new Date(data.date) : new Date(),
      systemBalance: account.balance || 0,
      statementBalance: stated,
      notes,
      createdBy: userId,
    }]);

    return reconciliation;
  }

  async getReconciliations(shopId, req, options = {}) {
    const { accountId, limit = 20 } = options;

    const filter = branchFilter(req, { shop: shopId });
    if (accountId) filter.account = accountId;

    return AccountReconciliation.find(filter)
      .sort({ date: -1 })
      .limit(limit)
      .populate('account', 'name type method')
      .populate('createdBy', 'name')
      .lean();
  }

  // ── "আমার টাকা কোথায়" ──────────────────────────────────────────────────────

  /**
   * Every account, what is in it, and what moved through it this period.
   *
   * This is the screen the whole feature exists for. "How much money do I have"
   * is the question owners ask most, and before fund accounts the app could
   * answer it for the cash drawer and nothing else.
   *
   * ── Q-1, settled: what a BRANCH view shows ───────────────────────────────
   *
   * A branch's expense paid from the shared bank moves a shop-wide balance but
   * records a branch-scoped expense, so there is no honest per-branch figure for
   * a shared account — the bank account is not Dhaka's or Chittagong's, it is
   * the shop's.
   *
   * So a branch view shows that branch's own cash box PLUS every shared account,
   * each flagged `isShared`, and the total is labelled accordingly on the client.
   * Splitting a shared balance across branches by some ratio would be inventing
   * a number; hiding shared accounts would make the total read far too low.
   * Naming them is the only version that is true.
   */
  async getMoneyPosition(shopId, req, options = {}) {
    const { startDate, endDate } = options;

    const accounts = await PaymentAccount.find(
      accountFilter(req, { shop: shopId, isActive: true })
    ).sort({ type: 1, name: 1 }).lean();

    if (accounts.length === 0) {
      return { accounts: [], totalBalance: 0, byType: [], period: { startDate, endDate } };
    }

    const ids = accounts.map((a) => a._id);
    const dateMatch = {};
    if (startDate) dateMatch.$gte = new Date(startDate);
    if (endDate) dateMatch.$lte = new Date(endDate);
    const hasPeriod = Object.keys(dateMatch).length > 0;

    const shopOid = new mongoose.Types.ObjectId(String(shopId));

    // Movement through each account in the window. Transfers and non-trade
    // entries only — the trading flows (sales, purchases, expenses) already have
    // their own reports, and duplicating them here would make this screen a
    // second, subtly different P&L.
    const [transfersOut, transfersIn, entries] = await Promise.all([
      AccountTransfer.aggregate([
        { $match: { shop: shopOid, fromAccount: { $in: ids }, ...(hasPeriod ? { date: dateMatch } : {}) } },
        { $group: { _id: '$fromAccount', total: { $sum: '$amountOut' } } },
      ]),
      AccountTransfer.aggregate([
        { $match: { shop: shopOid, toAccount: { $in: ids }, ...(hasPeriod ? { date: dateMatch } : {}) } },
        { $group: { _id: '$toAccount', total: { $sum: '$amountIn' } } },
      ]),
      AccountEntry.aggregate([
        { $match: { shop: shopOid, account: { $in: ids }, ...(hasPeriod ? { date: dateMatch } : {}) } },
        { $group: { _id: { account: '$account', direction: '$direction' }, total: { $sum: '$amount' } } },
      ]),
    ]);

    const byId = (rows, key = '_id') => {
      const map = new Map();
      rows.forEach((r) => map.set(String(r[key]), r.total || 0));
      return map;
    };
    const outMap = byId(transfersOut);
    const inMap = byId(transfersIn);
    const entryIn = new Map();
    const entryOut = new Map();
    for (const row of entries) {
      const target = row._id.direction === 'out' ? entryOut : entryIn;
      target.set(String(row._id.account), row.total || 0);
    }

    const enriched = accounts.map((a) => {
      const key = String(a._id);
      return {
        ...a,
        // Named on the row rather than inferred from `branch` on the client:
        // "this is the shop's, not this counter's" is the fact the screen has to
        // convey, and inferring it in two places is how they end up disagreeing.
        isShared: a.type !== 'cash',
        movement: {
          transfersIn: inMap.get(key) || 0,
          transfersOut: outMap.get(key) || 0,
          ownerIn: entryIn.get(key) || 0,
          ownerOut: entryOut.get(key) || 0,
        },
      };
    });

    const byType = Object.values(
      enriched.reduce((acc, a) => {
        const t = a.type || 'other';
        if (!acc[t]) acc[t] = { type: t, balance: 0, count: 0 };
        acc[t].balance += a.balance || 0;
        acc[t].count += 1;
        return acc;
      }, {})
    );

    return {
      accounts: enriched,
      // Derived, never stored (D-1).
      totalBalance: enriched.reduce((sum, a) => sum + (a.balance || 0), 0),
      byType,
      period: { startDate, endDate },
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Owner-only, and `0` is a real answer — only absence falls back. */
  _resolveOpeningBalance(raw, isOwner) {
    if (raw == null || raw === '') return 0;

    if (!isOwner) {
      throw new AppError(
        'Opening balance is owner-only',
        'শুরুর ব্যালান্স শুধু মালিক দিতে পারবেন',
        403
      );
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new AppError('Invalid opening balance', 'শুরুর ব্যালান্স সঠিক নয়', 400);
    }
    // Deliberately NOT clamped at zero: an overdrawn current account is real,
    // and clamping misstates the shop's position in the one direction that
    // matters.
    return value;
  }

  /**
   * One default per method, per branch scope.
   *
   * Two defaults for `bkash` would make `resolveAccountForMethod` return
   * whichever the index happened to yield — money landing in a different
   * account on different days, with nothing on screen to explain it.
   */
  async _ensureSingleDefault(shopId, account, wanted) {
    if (wanted === undefined) return;

    if (!wanted) {
      if (account.isDefault) {
        account.isDefault = false;
        await account.save();
      }
      return;
    }

    await PaymentAccount.updateMany(
      {
        shop: shopId,
        method: account.method,
        branch: account.branch,
        _id: { $ne: account._id },
      },
      { $set: { isDefault: false } }
    );

    if (!account.isDefault) {
      account.isDefault = true;
      await account.save();
    }
  }
}

module.exports = new PaymentAccountService();

/**
 * Platform finance — HisaabBD's own books: what came in, what went out, what
 * was earned, and what is still owed in service.
 *
 * Reads two ledgers and writes one:
 *   PlatformPayment  — money shops paid us (written by billing.service, read here)
 *   PlatformExpense  — money we spent (written and read here)
 *
 * ── Two views of the same money ──────────────────────────────────────────────
 *
 *   CASH    the month the taka actually moved. A shop paying 6 months up front
 *           in January is ৳4,800 of January cash.
 *   EARNED  the months the money is FOR. That same ৳4,800 is ৳800 of revenue in
 *           each of January–June. Likewise a ৳12,000 annual server bill is
 *           ৳1,000 of cost in each of its twelve months.
 *
 * Profit is EARNED revenue minus EARNED cost. Doing it on cash would make the
 * month a client prepays look like a windfall and the five after it look like a
 * collapse, which is exactly the distortion the operator asked to get rid of.
 * Cash flow is reported beside it, because the bank balance is cash.
 *
 * ── The identity every figure on the page obeys ──────────────────────────────
 *
 *   collected  =  earned through this month  +  advance held (later months)
 *   paid out   =  expensed through this month +  prepaid (later months)
 *
 * Both hold to the paisa because every allocation is a split of one amount
 * whose remainder lands on its last month (`spreadMonthly`). If those two lines
 * ever disagree, a row was counted on one side and not the other — that is a
 * bug, not rounding.
 *
 * ── Why months, not days ─────────────────────────────────────────────────────
 *
 * Revenue is spread straight-line by calendar month from the month the cover
 * starts, not ratably by day. Day-precise spreading would push most of every
 * ordinary monthly payment into the following month — "I received ৳800 in
 * October, why does October say ৳413?" — for a precision nobody reads. By month,
 * a shop that pays each month earns in the month it pays, and only genuine
 * advances move.
 *
 * ── Scale ────────────────────────────────────────────────────────────────────
 *
 * The overview loads both ledgers in full and allocates in memory. These are
 * platform-level ledgers — a few rows per shop per month — not the shops'
 * transactional data. If they ever reach six figures, persist the allocations;
 * until then a second copy of every figure is a second thing to drift.
 */

const mongoose = require('mongoose');
const PlatformPayment = require('../models/PlatformPayment.model');
const PlatformExpense = require('../models/PlatformExpense.model');
const Shop = require('../models/Shop.model');
const billingService = require('./billing.service');
const { AppError } = require('../middleware/error.middleware');
const {
  getBangladeshTodayStr,
  getBangladeshDayRange,
  toBangladeshMonthStr,
  toBangladeshDateStr,
} = require('../utils/bdTime.util');
const { PLATFORM_EXPENSE_CATEGORIES, PLATFORM_PAYMENT_METHODS } = require('../config/constants');

const EXPENSE_CATEGORIES = Object.values(PLATFORM_EXPENSE_CATEGORIES);
const PAYMENT_METHODS = Object.values(PLATFORM_PAYMENT_METHODS);
const MAX_COVERAGE_MONTHS = 60;
const MAX_RANGE_MONTHS = 120;
// Average Gregorian month, for turning a day-mode extension into months.
const DAYS_PER_MONTH = 30.4375;

// ── month arithmetic (pure) ────────────────────────────────────────────────

const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 'YYYY-MM' plus n months (n may be negative). */
function addMonthsToKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Whole months from a to b; same month = 0. */
function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}

/** Every month key from a to b inclusive. Empty when b precedes a. */
function monthKeysBetween(a, b) {
  const out = [];
  for (let k = a; monthsBetween(k, b) >= 0; k = addMonthsToKey(k, 1)) out.push(k);
  return out;
}

/**
 * Split `amount` evenly across `months` calendar months starting at `startKey`.
 * Each share is rounded to the paisa and the LAST month absorbs the remainder,
 * so the shares always sum back to exactly `amount` — the property the
 * collected = earned + advance identity rests on.
 */
function spreadMonthly(amount, startKey, months) {
  const n = Math.max(1, Math.floor(Number(months) || 1));
  const total = round2(amount);
  const share = round2(total / n);
  const out = [];
  let allocated = 0;
  for (let i = 0; i < n; i += 1) {
    const value = i === n - 1 ? round2(total - allocated) : share;
    allocated = round2(allocated + value);
    out.push({ month: addMonthsToKey(startKey, i), amount: value });
  }
  return out;
}

/**
 * Which months a payment's cover runs over: `{ startKey, months }`, or null
 * when it buys no period (SMS, setup fee, a legacy row) and is earned the month
 * it was received.
 *
 * `periodStart` is usually the shop's OLD expiry, stored as the last instant of
 * that day — a day the previous payment already paid for. One millisecond later
 * is the first day this payment buys, which is the day whose month it starts in.
 * Without that nudge a shop paid through 31 December renewing for January would
 * have January's money booked in December.
 */
function coverOf(payment) {
  const start = payment.periodStart ? new Date(payment.periodStart) : null;
  const end = payment.periodEnd ? new Date(payment.periodEnd) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;

  let months = Number(payment.months);
  if (!Number.isInteger(months) || months < 1) {
    const days = (end.getTime() - start.getTime()) / 86400000;
    months = Math.max(1, Math.round(days / DAYS_PER_MONTH));
  }
  return { startKey: toBangladeshMonthStr(new Date(start.getTime() + 1)), months };
}

/**
 * Earned allocations for one payment row.
 *
 * A reversal row carries no period of its own; it is spread over its ORIGINAL's
 * cover, so a reversed six-month advance nets to zero in each of the six months
 * rather than leaving five months of revenue standing and one big negative.
 */
function earnedScheduleFor(payment, original = null) {
  const cover = coverOf(original || payment);
  if (!cover) {
    return [{ month: toBangladeshMonthStr(payment.receivedAt), amount: round2(payment.amount) }];
  }
  return spreadMonthly(payment.amount, cover.startKey, cover.months);
}

/** Cost allocations for one expense row. `coverageMonths: 1` = the month paid. */
function expenseScheduleFor(expense) {
  const startKey = toBangladeshMonthStr(expense.coverageStart || expense.paidAt);
  return spreadMonthly(expense.amount, startKey, expense.coverageMonths || 1);
}

/** Income type → the stream it is reported under. Unknown types are 'other'. */
const STREAMS = ['subscription', 'sms', 'setup', 'other', 'adjustment'];
function streamOf(type) {
  return STREAMS.includes(type) ? type : 'other';
}

function emptyMonth(month) {
  return {
    month,
    cashIn: 0,
    earned: 0,
    earnedByStream: Object.fromEntries(STREAMS.map((s) => [s, 0])),
    cashByStream: Object.fromEntries(STREAMS.map((s) => [s, 0])),
    expensesPaid: 0,
    expensed: 0,
    expensedByCategory: {},
    paymentCount: 0,
    expenseCount: 0,
  };
}

function finishMonth(row) {
  const out = { ...row };
  for (const k of ['cashIn', 'earned', 'expensesPaid', 'expensed']) out[k] = round2(out[k]);
  for (const s of STREAMS) {
    out.earnedByStream[s] = round2(out.earnedByStream[s]);
    out.cashByStream[s] = round2(out.cashByStream[s]);
  }
  for (const c of Object.keys(out.expensedByCategory)) {
    out.expensedByCategory[c] = round2(out.expensedByCategory[c]);
  }
  out.netProfit = round2(out.earned - out.expensed);
  out.netCash = round2(out.cashIn - out.expensesPaid);
  // A margin on zero revenue is undefined, not 0% — printing 0% beside real
  // spending reads as break-even rather than as a loss.
  out.margin = out.earned > 0 ? round2((out.netProfit / out.earned) * 100) : null;
  return out;
}

/**
 * Build the month ledger from raw rows. Pure — every figure the panel shows
 * comes out of this one function, which is what the tests pin.
 *
 * Pending payments are excluded: the money has not arrived. Waived ৳0 rows
 * contribute nothing and need no special case. Voided expenses must already be
 * filtered out by the caller.
 */
function buildLedger({ payments = [], expenses = [] }) {
  const months = new Map();
  const at = (key) => {
    if (!months.has(key)) months.set(key, emptyMonth(key));
    return months.get(key);
  };

  const live = payments.filter((p) => p.status !== 'pending' && Number.isFinite(Number(p.amount)));
  const byId = new Map(live.map((p) => [String(p._id), p]));

  for (const p of live) {
    const stream = streamOf(p.type);
    const cashRow = at(toBangladeshMonthStr(p.receivedAt));
    cashRow.cashIn += Number(p.amount);
    cashRow.cashByStream[stream] += Number(p.amount);
    cashRow.paymentCount += 1;

    const original = p.reversalOf ? byId.get(String(p.reversalOf)) || null : null;
    for (const slice of earnedScheduleFor(p, original)) {
      const row = at(slice.month);
      row.earned += slice.amount;
      row.earnedByStream[stream] += slice.amount;
    }
  }

  for (const e of expenses) {
    const cashRow = at(toBangladeshMonthStr(e.paidAt));
    cashRow.expensesPaid += Number(e.amount);
    cashRow.expenseCount += 1;
    for (const slice of expenseScheduleFor(e)) {
      const row = at(slice.month);
      row.expensed += slice.amount;
      row.expensedByCategory[e.category] = (row.expensedByCategory[e.category] || 0) + slice.amount;
    }
  }

  return months;
}

/** Sum month rows into one, for a range or for lifetime. */
function sumMonths(rows) {
  const total = emptyMonth(null);
  for (const r of rows) {
    total.cashIn += r.cashIn;
    total.earned += r.earned;
    total.expensesPaid += r.expensesPaid;
    total.expensed += r.expensed;
    total.paymentCount += r.paymentCount;
    total.expenseCount += r.expenseCount;
    for (const s of STREAMS) {
      total.earnedByStream[s] += r.earnedByStream[s];
      total.cashByStream[s] += r.cashByStream[s];
    }
    for (const [c, v] of Object.entries(r.expensedByCategory)) {
      total.expensedByCategory[c] = (total.expensedByCategory[c] || 0) + v;
    }
  }
  const out = finishMonth(total);
  delete out.month;
  return out;
}

// ── input parsing ──────────────────────────────────────────────────────────

const bad = (en, bn) => new AppError(en, bn, 400);

/**
 * A typed date ("YYYY-MM-DD") is a BANGLADESH date. Stored at Dhaka noon so no
 * timezone reading can move it to a neighbouring day — or, on the 1st, into the
 * previous month's figures.
 */
function parseBdDate(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date) return raw;
  const str = String(raw).slice(0, 10);
  if (!DATE_RX.test(str) || Number.isNaN(Date.parse(`${str}T00:00:00Z`))) {
    throw bad(`${field} is not a valid date`, 'তারিখ সঠিক নয়');
  }
  return new Date(getBangladeshDayRange(str).startOfDay.getTime() + 12 * 3600 * 1000);
}

function parseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw bad('Amount must be more than zero', 'টাকার পরিমাণ শূন্যের বেশি হতে হবে');
  }
  return round2(n);
}

function parseCoverage(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COVERAGE_MONTHS) {
    throw bad(
      `Coverage must be a whole number of months between 1 and ${MAX_COVERAGE_MONTHS}`,
      `মেয়াদ ১ থেকে ${MAX_COVERAGE_MONTHS} মাসের মধ্যে হতে হবে`
    );
  }
  return n;
}

function parseCategory(raw) {
  if (!EXPENSE_CATEGORIES.includes(raw)) {
    throw bad(`Unknown expense category "${raw}"`, 'খরচের ধরন সঠিক নয়');
  }
  return raw;
}

function parseMethod(raw) {
  if (raw === undefined || raw === null || raw === '') return PLATFORM_PAYMENT_METHODS.CASH;
  if (!PAYMENT_METHODS.includes(raw)) throw bad(`Unknown payment method "${raw}"`, 'পেমেন্ট মাধ্যম সঠিক নয়');
  return raw;
}

function parseTitle(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw bad('Describe the expense', 'খরচের বিবরণ লিখুন');
  if (s.length > 200) throw bad('Description is too long (200 characters max)', 'বিবরণ খুব বড়');
  return s;
}

/** A bill dated in the future would book cost into a month that has not happened. */
function refuseFuture(date, field) {
  if (date && toBangladeshDateStr(date) > getBangladeshTodayStr()) {
    throw bad(`${field} cannot be in the future`, 'তারিখ ভবিষ্যতে হতে পারে না');
  }
}

const actorShape = (actor) => ({ kind: actor?.kind || 'admin', id: actor?.id, name: actor?.name });

function parseMonthKey(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!MONTH_RX.test(String(raw))) throw bad(`${field} must be YYYY-MM`, 'মাস সঠিক নয়');
  return String(raw);
}

// ── the service ────────────────────────────────────────────────────────────

class PlatformFinanceService {
  async _loadLedgers() {
    const [payments, expenses] = await Promise.all([
      PlatformPayment.find({ status: { $ne: 'pending' } })
        .select('shop type amount receivedAt periodStart periodEnd months status reversalOf')
        .lean(),
      PlatformExpense.find({ voidedAt: null })
        .select('category amount paidAt coverageStart coverageMonths title')
        .lean(),
    ]);
    return { payments, expenses };
  }

  /**
   * The P&L. `from`/`to` are 'YYYY-MM' and bound the month table only — the
   * lifetime block always covers everything, so changing the range never
   * changes what "lifetime" means.
   */
  async getOverview({ from, to } = {}) {
    const currentMonth = getBangladeshTodayStr().slice(0, 7);
    const toKey = parseMonthKey(to, 'to') || currentMonth;
    const allTime = from === 'all';
    let fromKey = allTime ? null : parseMonthKey(from, 'from') || addMonthsToKey(toKey, -11);
    if (fromKey) {
      if (monthsBetween(fromKey, toKey) < 0) throw bad('"from" must not be after "to"', 'শুরুর মাস শেষের মাসের পরে হতে পারে না');
      if (monthsBetween(fromKey, toKey) >= MAX_RANGE_MONTHS) {
        throw bad(`Choose at most ${MAX_RANGE_MONTHS} months`, `সর্বোচ্চ ${MAX_RANGE_MONTHS} মাস বাছাই করুন`);
      }
    }

    const ledgers = await this._loadLedgers();
    const ledger = buildLedger(ledgers);
    const allKeys = [...ledger.keys()].sort();

    // "All time" runs from the first month anything happened, capped at the
    // range limit so a ten-year-old platform still gets a readable table.
    if (allTime) {
      const first = allKeys[0] && allKeys[0] < toKey ? allKeys[0] : toKey;
      const floor = addMonthsToKey(toKey, -(MAX_RANGE_MONTHS - 1));
      fromKey = first < floor ? floor : first;
    }

    const finished = new Map(allKeys.map((k) => [k, finishMonth(ledger.get(k))]));
    const row = (k) => finished.get(k) || finishMonth(emptyMonth(k));

    const toDate = allKeys.filter((k) => k <= currentMonth).map(row);
    const ahead = allKeys.filter((k) => k > currentMonth).map(row);
    const lifetime = sumMonths(toDate);
    const future = sumMonths(ahead);

    // The identity, stated as fields so the page can print it rather than
    // asking the reader to trust that two tiles add up.
    lifetime.collected = round2(lifetime.cashIn + future.cashIn);
    lifetime.advanceHeld = round2(future.earned);
    lifetime.paidOut = round2(lifetime.expensesPaid + future.expensesPaid);
    lifetime.prepaidExpenses = round2(future.expensed);
    lifetime.firstMonth = allKeys[0] || null;

    const months = monthKeysBetween(fromKey, toKey).map(row);
    const lastMonth = addMonthsToKey(currentMonth, -1);

    // MRR and overdue come from billing, which already defines them. A second
    // definition here would be a second answer to "what is MRR".
    const billing = await billingService.getSummary();

    return {
      asOf: getBangladeshTodayStr(),
      currentMonth,
      range: { from: fromKey, to: toKey },
      lifetime,
      thisMonth: row(currentMonth),
      lastMonth: row(lastMonth),
      months,
      rangeTotals: sumMonths(months),
      subscription: {
        mrr: billing.mrr,
        arr: round2(billing.mrr * 12),
        activeShops: billing.activeShops,
        trialShops: billing.trialShops,
        arpu: billing.arpu,
        overdueShops: billing.overdueShops,
        overdueAmount: billing.overdueAmount,
      },
    };
  }

  /**
   * Who has paid ahead, how much of it is still owed in service, and when it
   * turns into revenue. "Advance held" is a liability: if every one of these
   * shops left today, this is what they paid for and have not yet received.
   */
  async getAdvances() {
    const currentMonth = getBangladeshTodayStr().slice(0, 7);
    const { payments, expenses } = await this._loadLedgers();
    const live = payments.filter((p) => Number.isFinite(Number(p.amount)));
    const byId = new Map(live.map((p) => [String(p._id), p]));

    const perShop = new Map();
    const schedule = new Map();
    for (const p of live) {
      const original = p.reversalOf ? byId.get(String(p.reversalOf)) || null : null;
      for (const slice of earnedScheduleFor(p, original)) {
        if (slice.month <= currentMonth) continue;
        const key = String(p.shop);
        if (!perShop.has(key)) perShop.set(key, { held: 0, months: new Map(), lastPaymentAt: null });
        const s = perShop.get(key);
        s.held += slice.amount;
        s.months.set(slice.month, (s.months.get(slice.month) || 0) + slice.amount);
        if (!p.reversalOf && (!s.lastPaymentAt || p.receivedAt > s.lastPaymentAt)) s.lastPaymentAt = p.receivedAt;
        schedule.set(slice.month, (schedule.get(slice.month) || 0) + slice.amount);
      }
    }

    // A fully reversed advance nets to zero and is not an advance.
    const holding = [...perShop.entries()].filter(([, s]) => round2(s.held) > 0);
    const shopIds = holding.map(([id]) => id).filter((id) => mongoose.isValidObjectId(id));
    const shops = shopIds.length
      ? await Shop.find({ _id: { $in: shopIds } })
        .select('name phone owner subscription.expiresAt billing.monthlyPrice')
        .populate('owner', 'name phone')
        .lean()
      : [];
    const shopMap = new Map(shops.map((s) => [String(s._id), s]));

    const rows = holding
      .map(([id, s]) => {
        const shop = shopMap.get(id);
        const monthsAhead = [...s.months.entries()].filter(([, v]) => round2(v) > 0).map(([k]) => k).sort();
        return {
          shop: shop
            ? { _id: shop._id, name: shop.name, phone: shop.phone, owner: shop.owner }
            : { _id: id, name: null },
          held: round2(s.held),
          monthsAhead: monthsAhead.length,
          coveredThrough: monthsAhead[monthsAhead.length - 1] || null,
          paidThrough: shop?.subscription?.expiresAt || null,
          monthlyPrice: shop?.billing?.monthlyPrice ?? null,
          nextMonthRelease: round2(s.months.get(addMonthsToKey(currentMonth, 1)) || 0),
          lastPaymentAt: s.lastPaymentAt,
        };
      })
      .sort((a, b) => b.held - a.held);

    const prepaid = expenses
      .map((e) => {
        const later = expenseScheduleFor(e).filter((x) => x.month > currentMonth);
        if (!later.length) return null;
        return {
          _id: e._id,
          title: e.title,
          category: e.category,
          amount: e.amount,
          held: round2(later.reduce((sum, x) => sum + x.amount, 0)),
          monthsAhead: later.length,
          coveredThrough: later[later.length - 1].month,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.held - a.held);

    return {
      asOf: getBangladeshTodayStr(),
      currentMonth,
      total: round2(rows.reduce((sum, r) => sum + r.held, 0)),
      shopCount: rows.length,
      shops: rows,
      schedule: [...schedule.entries()]
        .map(([month, amount]) => ({ month, amount: round2(amount) }))
        .filter((r) => r.amount !== 0)
        .sort((a, b) => a.month.localeCompare(b.month)),
      prepaidExpenses: {
        total: round2(prepaid.reduce((sum, r) => sum + r.held, 0)),
        items: prepaid,
      },
    };
  }

  // ── the expense book ────────────────────────────────────────────────────

  async listExpenses({ page = 1, limit = 50, category, from, to, search, status = 'live' } = {}) {
    const pageN = Math.max(1, parseInt(page, 10) || 1);
    const limitN = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));

    const query = {};
    if (status === 'live') query.voidedAt = null;
    else if (status === 'voided') query.voidedAt = { $ne: null };
    if (category) query.category = parseCategory(category);
    const fromDate = from ? getBangladeshDayRange(String(from).slice(0, 10)).startOfDay : null;
    const toDate = to ? getBangladeshDayRange(String(to).slice(0, 10)).endOfDay : null;
    if (fromDate || toDate) {
      query.paidAt = {};
      if (fromDate) query.paidAt.$gte = fromDate;
      if (toDate) query.paidAt.$lte = toDate;
    }
    if (search && String(search).trim()) {
      // Escaped: this is typed into a search box, not a pattern language.
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ title: rx }, { vendor: rx }, { reference: rx }, { notes: rx }];
    }

    // Totals count live rows only, whatever the list shows: a voided bill is
    // listed so it can be found, never so it can be summed.
    const sumLive = status !== 'voided';

    const [data, total, sums] = await Promise.all([
      PlatformExpense.find(query)
        .sort({ paidAt: -1, createdAt: -1 })
        .skip((pageN - 1) * limitN)
        .limit(limitN)
        .lean(),
      PlatformExpense.countDocuments(query),
      sumLive
        ? PlatformExpense.aggregate([
          { $match: { ...query, voidedAt: null } },
          { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
        ])
        : [],
    ]);

    const byCategory = sums
      .map((s) => ({ category: s._id, amount: round2(s.amount), count: s.count }))
      .sort((a, b) => b.amount - a.amount);

    return {
      data,
      pagination: { page: pageN, limit: limitN, total, pages: Math.ceil(total / limitN) },
      totals: {
        amount: round2(byCategory.reduce((sum, c) => sum + c.amount, 0)),
        count: byCategory.reduce((sum, c) => sum + c.count, 0),
        byCategory,
      },
    };
  }

  async createExpense(actor, body = {}) {
    const paidAt = parseBdDate(body.paidAt, 'Paid date') || new Date();
    refuseFuture(paidAt, 'Paid date');
    const coverageStart = parseBdDate(body.coverageStart, 'Coverage start');

    return PlatformExpense.create({
      category: parseCategory(body.category),
      title: parseTitle(body.title),
      vendor: body.vendor ? String(body.vendor).trim().slice(0, 120) : undefined,
      amount: parseAmount(body.amount),
      method: parseMethod(body.method),
      paidAt,
      coverageStart: coverageStart || undefined,
      coverageMonths: parseCoverage(body.coverageMonths),
      reference: body.reference ? String(body.reference).trim().slice(0, 120) : undefined,
      notes: body.notes ? String(body.notes).slice(0, 1000) : undefined,
      recordedBy: actorShape(actor),
    });
  }

  /**
   * Correct an expense that was keyed in wrong. Everything except the amount:
   * a wrong amount is a void and a re-entry, so a total can never be quietly
   * rewritten. Every change is stamped with who, when, and the old values.
   */
  async amendExpense(actor, id, patch = {}) {
    if (!mongoose.isValidObjectId(id)) throw new AppError('Expense not found', 'খরচ পাওয়া যায়নি', 404);
    if (patch.amount !== undefined) {
      throw bad(
        'The amount cannot be edited — void this expense and record it again',
        'টাকার পরিমাণ বদলানো যায় না — এন্ট্রিটি বাতিল করে আবার লিখুন'
      );
    }

    const expense = await PlatformExpense.findById(id);
    if (!expense) throw new AppError('Expense not found', 'খরচ পাওয়া যায়নি', 404);
    if (expense.voidedAt) throw bad('A voided expense cannot be edited', 'বাতিল খরচ সম্পাদনা করা যায় না');

    const parsers = {
      category: parseCategory,
      title: parseTitle,
      vendor: (v) => (v ? String(v).trim().slice(0, 120) : ''),
      method: parseMethod,
      paidAt: (v) => {
        const d = parseBdDate(v, 'Paid date');
        if (!d) throw bad('Paid date is required', 'তারিখ দিন');
        refuseFuture(d, 'Paid date');
        return d;
      },
      coverageStart: (v) => parseBdDate(v, 'Coverage start'),
      coverageMonths: parseCoverage,
      reference: (v) => (v ? String(v).trim().slice(0, 120) : ''),
      notes: (v) => (v ? String(v).slice(0, 1000) : ''),
    };

    const before = {};
    const after = {};
    for (const [field, parse] of Object.entries(parsers)) {
      if (patch[field] === undefined) continue;
      const next = parse(patch[field]);
      const prev = expense[field];
      const same = prev instanceof Date || next instanceof Date
        ? (prev ? new Date(prev).getTime() : null) === (next ? new Date(next).getTime() : null)
        : String(prev ?? '') === String(next ?? '');
      if (same) continue;
      before[field] = prev ?? null;
      after[field] = next;
      // A cleared coverage start falls back to the paid date, so unset it.
      expense[field] = field === 'coverageStart' && !next ? undefined : next;
    }

    if (!Object.keys(after).length) throw bad('Nothing to change', 'পরিবর্তন করার কিছু নেই');

    expense.amendments.push({
      at: new Date(),
      by: actorShape(actor),
      before,
      after,
      reason: patch.reason ? String(patch.reason).slice(0, 500) : undefined,
    });
    await expense.save();
    return expense;
  }

  async voidExpense(actor, id, reason) {
    if (!reason || !String(reason).trim()) {
      throw bad('A reason is required to void an expense', 'খরচ বাতিল করতে কারণ লিখতে হবে');
    }
    if (!mongoose.isValidObjectId(id)) throw new AppError('Expense not found', 'খরচ পাওয়া যায়নি', 404);

    // Conditional on still being live, so two clicks cannot void twice and
    // overwrite the first reason.
    const voided = await PlatformExpense.findOneAndUpdate(
      { _id: id, voidedAt: null },
      { $set: { voidedAt: new Date(), voidedBy: actorShape(actor), voidReason: String(reason).trim().slice(0, 500) } },
      { new: true }
    );
    if (voided) return voided;

    const exists = await PlatformExpense.exists({ _id: id });
    if (!exists) throw new AppError('Expense not found', 'খরচ পাওয়া যায়নি', 404);
    throw new AppError('This expense is already voided', 'এই খরচ আগেই বাতিল করা হয়েছে', 409);
  }
}

const platformFinanceService = new PlatformFinanceService();

module.exports = platformFinanceService;
// The pure core, exported for the tests that pin the accounting.
module.exports.spreadMonthly = spreadMonthly;
module.exports.coverOf = coverOf;
module.exports.earnedScheduleFor = earnedScheduleFor;
module.exports.expenseScheduleFor = expenseScheduleFor;
module.exports.buildLedger = buildLedger;
module.exports.sumMonths = sumMonths;
module.exports.finishMonth = finishMonth;
module.exports.addMonthsToKey = addMonthsToKey;
module.exports.monthKeysBetween = monthKeysBetween;
module.exports.parseBdDate = parseBdDate;

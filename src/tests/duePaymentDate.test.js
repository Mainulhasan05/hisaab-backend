/**
 * Backdating a বাকি আদায় — dating a collection to the day the money came in.
 *
 * The sibling of `saleDate.test.js`, and grouped the same way
 * (AGENT_WORKFLOW.md §7.1):
 *
 *   A. NO DATE ASKED FOR — INVARIANT GUARDS. Pass before and after by
 *      construction. Every internal caller and every script sends nothing. A
 *      gate that 403'd the absent case would refuse every collection in every
 *      shop on the platform.
 *
 *   B. TODAY IS NOT A BACKDATE. The rule that makes the gate safe to ship: the
 *      collect-due form always posts a date, so if "today" required
 *      `customers.backdate` then every cashier taking an ordinary payment would
 *      be refused. Separated from group A because it is the arm most likely to
 *      be "simplified" away by someone reading the gate first.
 *
 *   C. THE GATE. Owner, platform admin, and a cashier who has been granted it
 *      may move a collection between days; a cashier who has not may not.
 *
 *   D. BOUNDS. No future, nothing before the shop existed, nothing unparseable.
 *
 *   E. THE BANGLADESH DAY. Why a bare 'YYYY-MM-DD' is not fed to `new Date()`:
 *      that is UTC midnight, i.e. 06:00 Dhaka, so every rounding question lands
 *      on a day boundary. Noon-BD is pinned here.
 *
 *   F. THE READ PATH. `paidAtMatch` must still find rows written before
 *      `paidAt` existed. This is the arm with real blast radius — get it wrong
 *      and every historical payment silently vanishes from every date-ranged
 *      report the moment this deploys.
 *
 *   G. WIRING — GUARDS. That the permission exists, that the presets carry it,
 *      and that EXISTING shops get it through an upgrade rather than only new
 *      ones. Cheap, and it catches the failure that is invisible from outside:
 *      a service checking a permission no owner can grant.
 *
 * Deliberately NOT here: that a backdated collection actually lands in the
 * earlier day's report totals. That is a property of the aggregations reading
 * the matcher, and a mocked unit test would pass whether or not the matcher was
 * really wired into them (§7.2). What IS pinned is the matcher's shape and the
 * resolved instant — the parts this feature owns.
 */

const mongoose = require('mongoose');

const { resolvePaidAt, paidAtMatch, PAID_AT_EXPR } = require('../utils/paymentDate.util');
const {
  toBangladeshDateStr,
  getBangladeshTodayStr,
  getBangladeshDayRange,
} = require('../utils/bdTime.util');
const {
  MODULES,
  ROLE_PRESETS,
  PRESET_VERSION,
  buildPresetUpgradePatch,
} = require('../config/permissions');

const id = () => new mongoose.Types.ObjectId();

/** A shop opened well in the past, so the floor check never fires by accident. */
const shopDoc = (createdAt = new Date('2020-01-01T00:00:00Z')) => ({ _id: id(), createdAt });

const ownerReq = (shop = shopDoc()) => ({ shop, user: { isOwner: true } });
/** A cashier who HAS been granted `customers.backdate`. */
const cashierReq = (shop = shopDoc()) => ({
  shop,
  user: {
    isOwner: false,
    permissions: { customers: { view: true, update: true, backdate: true } },
  },
});
/** A cashier who may take payments but may not move them between days. */
const plainCashierReq = (shop = shopDoc()) => ({
  shop,
  user: { isOwner: false, permissions: { customers: { view: true, update: true } } },
});
/** The platform admin acting inside a shop — carries no `user.isOwner` (M-7). */
const adminReq = (shop = shopDoc()) => ({ shop, isAdmin: true, user: { isOwner: false } });

/** A date safely in the past, as 'YYYY-MM-DD' in Bangladesh time. */
const daysAgoBd = (days) =>
  toBangladeshDateStr(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

describe('A. no date asked for — invariant guards', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s returns "now" and throws nothing, for a cashier WITHOUT the permission', (_label, raw) => {
    const before = Date.now();
    const when = resolvePaidAt({ raw, req: plainCashierReq() });
    expect(when).toBeInstanceOf(Date);
    expect(when.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('no request at all (a script or seeder) is not a violation', () => {
    expect(resolvePaidAt({ raw: undefined })).toBeInstanceOf(Date);
  });

  test('called with no arguments at all still returns now', () => {
    // `collectDuePayment` will not be the only caller forever; a signature
    // without a default object would throw on `resolvePaidAt()`.
    expect(resolvePaidAt()).toBeInstanceOf(Date);
  });
});

describe('B. today is not a backdate', () => {
  test("today's date needs no permission", () => {
    // The one that matters. The collect-due form ALWAYS posts a date, so if
    // this required the permission every ordinary collection would 403.
    expect(() =>
      resolvePaidAt({ raw: getBangladeshTodayStr(), req: plainCashierReq() })
    ).not.toThrow();
  });

  test("today's date resolves to NOW, not to noon", () => {
    // Not cosmetic: the customer's payment list prints the time, and money
    // taken at 8pm must not read 12:00. Only a genuinely past date gets the
    // noon placement.
    const when = resolvePaidAt({ raw: getBangladeshTodayStr(), req: plainCashierReq() });
    expect(Math.abs(when.getTime() - Date.now())).toBeLessThan(5000);
  });
});

describe('C. the gate', () => {
  test('a cashier WITHOUT `customers.backdate` is refused 403, in Bengali', () => {
    expect.assertions(3);
    try {
      resolvePaidAt({ raw: daysAgoBd(3), req: plainCashierReq() });
    } catch (err) {
      expect(err.statusCode).toBe(403);
      expect(err.messageBn).toContain('অনুমতি');
      // Nothing leaked back about what WOULD have been accepted.
      expect(err.messageBn).not.toMatch(/\d/);
    }
  });

  test('`customers.update` alone does NOT imply it', () => {
    // Taking a payment is not the same authority as deciding which day's till
    // it belongs to.
    expect(() => resolvePaidAt({ raw: daysAgoBd(1), req: plainCashierReq() })).toThrow();
  });

  test('a cashier WITH the permission may name a date', () => {
    const when = resolvePaidAt({ raw: daysAgoBd(3), req: cashierReq() });
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(3));
  });

  test('the owner may', () => {
    const when = resolvePaidAt({ raw: daysAgoBd(3), req: ownerReq() });
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(3));
  });

  test('the platform admin may too — they carry no user.isOwner (the M-7 trap)', () => {
    const when = resolvePaidAt({ raw: daysAgoBd(1), req: adminReq() });
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(1));
  });

  test('a script with no request may — there is nobody to distrust', () => {
    expect(resolvePaidAt({ raw: daysAgoBd(1) })).toBeInstanceOf(Date);
  });
});

describe('D. bounds', () => {
  test('a future date is refused 400', () => {
    const tomorrow = toBangladeshDateStr(new Date(Date.now() + 36 * 60 * 60 * 1000));
    expect.assertions(2);
    try {
      resolvePaidAt({ raw: tomorrow, req: ownerReq() });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('আজকের পরের');
    }
  });

  test('an unparseable date is refused 400', () => {
    expect.assertions(2);
    try {
      resolvePaidAt({ raw: 'কালকে', req: ownerReq() });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('ঠিকভাবে');
    }
  });

  test('a date before the shop existed is refused — the fat-fingered year', () => {
    // 2016 rather than 2026 would otherwise bury a collection a decade deep in
    // the reports, where nobody would ever look for it.
    const shop = shopDoc(new Date('2024-01-01T00:00:00Z'));
    expect.assertions(2);
    try {
      resolvePaidAt({ raw: '2016-05-04', req: ownerReq(shop), shop });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('দোকান খোলার');
    }
  });

  test('the shop floor is read off `req.shop` when not passed explicitly', () => {
    const shop = shopDoc(new Date('2024-01-01T00:00:00Z'));
    expect(() => resolvePaidAt({ raw: '2016-05-04', req: ownerReq(shop) })).toThrow();
  });

  test('there is no floor beyond the shop — last quarter is legitimate', () => {
    // A shop catching up on months of খাতা entries is exactly who this is for,
    // so there is deliberately no policy window.
    const when = resolvePaidAt({ raw: daysAgoBd(120), req: ownerReq() });
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(120));
  });
});

describe('E. the Bangladesh day', () => {
  test('a bare date lands at NOON Bangladesh time, not UTC midnight', () => {
    // Midnight BD sits exactly on the boundary `getBangladeshDayRange` uses, so
    // any rounding at all files the collection into the neighbouring day — the
    // one thing this feature must never do.
    const when = resolvePaidAt({ raw: '2026-05-04', req: ownerReq() });
    const { startOfDay } = getBangladeshDayRange('2026-05-04');
    expect(when.getTime() - startOfDay.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  test('the resolved instant reads back as the day that was asked for', () => {
    const when = resolvePaidAt({ raw: '2026-05-04', req: ownerReq() });
    expect(toBangladeshDateStr(when)).toBe('2026-05-04');
  });

  test('a full ISO datetime is honoured as given', () => {
    // An owner who knows the money came in at 7pm can say so.
    const raw = '2026-05-04T13:00:00.000Z';
    expect(resolvePaidAt({ raw, req: ownerReq() }).toISOString()).toBe(raw);
  });

  test('a Date instance passes through', () => {
    const raw = new Date('2026-05-04T13:00:00.000Z');
    expect(resolvePaidAt({ raw, req: ownerReq() }).getTime()).toBe(raw.getTime());
  });
});

describe('F. the read path', () => {
  const range = { $gte: new Date('2026-05-01'), $lte: new Date('2026-05-31') };

  test('the matcher covers rows that have no paidAt at all', () => {
    // THE arm with blast radius. Every payment written before this field
    // existed has no `paidAt`; a matcher filtering on it alone would make all
    // of them vanish from every date-ranged report at once, silently.
    const match = paidAtMatch(range);
    expect(match.$or).toHaveLength(2);
    expect(match.$or[1]).toEqual({ paidAt: null, createdAt: range });
  });

  test('the legacy branch uses `paidAt: null`, which matches MISSING too', () => {
    // `{ field: null }` matches null AND absent in MongoDB. `$exists: false`
    // would match only absent, so a row explicitly stored as null would be
    // lost — a distinction no caller should have to know about.
    expect(paidAtMatch(range).$or[1].paidAt).toBeNull();
  });

  test('both branches are plain field predicates, so both can use an index', () => {
    // Not `$expr` on `$ifNull`: `$expr` cannot use an index, and this runs in
    // the cash register's close path over every payment a shop has ever taken.
    for (const branch of paidAtMatch(range).$or) {
      expect(JSON.stringify(branch)).not.toContain('$expr');
    }
  });

  test('no range returns {}, so callers can spread it unconditionally', () => {
    expect(paidAtMatch(null)).toEqual({});
    expect(paidAtMatch(undefined)).toEqual({});
  });

  test('the aggregation expression falls back to createdAt', () => {
    expect(PAID_AT_EXPR).toEqual({ $ifNull: ['$paidAt', '$createdAt'] });
  });
});

describe('G. wiring — guards', () => {
  test('`backdate` is a real action on the customers module', () => {
    // Without this the roles screen cannot render the toggle and
    // `findUnknownPermissionKeys` rejects it as a typo, so an owner could never
    // grant the thing the service checks for.
    expect(MODULES.customers.actions).toContain('backdate');
  });

  test('manager and cashier presets carry it for NEW shops', () => {
    expect(ROLE_PRESETS.manager.permissions.customers.backdate).toBe(true);
    expect(ROLE_PRESETS.cashier.permissions.customers.backdate).toBe(true);
  });

  test('salesperson does not — floor staff are left out, as with `discount`', () => {
    expect(ROLE_PRESETS.salesperson.permissions.customers?.backdate).not.toBe(true);
  });

  test('EXISTING shops get it through a preset upgrade, not just new ones', () => {
    // Editing ROLE_PRESETS alone reaches only shops created afterwards. This is
    // the arm that carries the grant to roles that already exist.
    expect(PRESET_VERSION).toBeGreaterThanOrEqual(7);
    expect(buildPresetUpgradePatch('cashier', 6)).toMatchObject({
      'permissions.customers.backdate': true,
    });
    expect(buildPresetUpgradePatch('manager', 6)).toMatchObject({
      'permissions.customers.backdate': true,
    });
  });

  test('a role already at the current version is not re-granted', () => {
    // An owner who revokes the toggle must not have it handed back on next read.
    expect(buildPresetUpgradePatch('cashier', PRESET_VERSION)).toBeNull();
  });
});

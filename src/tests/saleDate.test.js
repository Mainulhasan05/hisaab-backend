/**
 * Backdated invoices — an owner dating a sale to the day it actually happened.
 *
 * Groups, and it matters which is which (AGENT_WORKFLOW.md §7.1):
 *
 *   A. NO DATE ASKED FOR — INVARIANT GUARDS. Pass before and after by
 *      construction. Every checkout on the platform sends no `saleDate`, and
 *      that path must stay silent for cashier and owner alike — a gate that
 *      403s the absent case would refuse every sale in every shop. This is the
 *      tripwire, not a regression test.
 *
 *   B. THE GATE — REGRESSIONS in the weak sense (`resolveSaleDate` did not
 *      exist, so there is nothing in the old code for them to fail against).
 *      Owner-only, no future dates, no date before the shop existed.
 *
 *   C. THE BANGLADESH DAY. The reason a bare 'YYYY-MM-DD' is not fed to
 *      `new Date()`: it would be UTC midnight, i.e. 06:00 Dhaka, and every
 *      rounding question then lands on a day boundary. These pin noon-BD and
 *      the day the invoice number is drawn from.
 *
 *   D. WIRING — GUARDS. That the Joi schema carries `saleDate` at all. Cheap,
 *      and it catches the one failure that is invisible from the outside:
 *      `validate.middleware` runs with `stripUnknown: true`, so a field missing
 *      from the schema is DELETED before the service sees it and the owner gets
 *      today's date with no error anywhere.
 *
 * Deliberately NOT here: that a backdated sale actually lands in the earlier
 * day's report/drawer totals. That is a property of the aggregations reading
 * `createdAt`, which they already do for every other sale — a mocked unit test
 * would pass whether or not `createdAt` was really moved (§7.2). What IS pinned
 * here is that the resolved instant is the one handed to the invoice number and
 * to the document, which is the part this feature owns.
 */

const mongoose = require('mongoose');

const { resolveSaleDate } = require('../utils/saleDate.util');
const { toBangladeshDateStr, getBangladeshDayRange } = require('../utils/bdTime.util');
const saleValidation = require('../validations/sale.validation');

const id = () => new mongoose.Types.ObjectId();

/* ── request fixtures ─────────────────────────────────────────────────────── */

/** A shop opened well in the past, so the floor check never fires by accident. */
const shopDoc = (createdAt = new Date('2020-01-01T00:00:00Z')) => ({ _id: id(), createdAt });

const ownerReq = (shop = shopDoc()) => ({ shop, user: { isOwner: true } });
const cashierReq = (shop = shopDoc()) => ({
  shop,
  user: { isOwner: false, permissions: { sales: { view: true, create: true } } },
});
/** The platform admin acting inside a shop — carries no `user.isOwner`. */
const adminReq = (shop = shopDoc()) => ({ shop, isAdmin: true, user: { isOwner: false } });

/** A date safely in the past, as 'YYYY-MM-DD' in Bangladesh time. */
const daysAgoBd = (days) =>
  toBangladeshDateStr(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

describe('A. no date asked for — invariant guards', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s returns null and throws nothing, for the OWNER', (_label, raw) => {
    expect(resolveSaleDate({ raw, req: ownerReq(), shop: shopDoc() })).toBeNull();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s returns null and throws nothing, for a CASHIER', (_label, raw) => {
    // The one that matters. Every ordinary POS payload takes this path, and a
    // gate that ran before the absent check would 403 the whole platform.
    expect(resolveSaleDate({ raw, req: cashierReq(), shop: shopDoc() })).toBeNull();
  });

  test('no request at all (a script or seeder) is not a violation', () => {
    expect(resolveSaleDate({ raw: undefined })).toBeNull();
  });
});

describe('B. the gate', () => {
  test('a cashier naming a date is refused 403, in Bengali', () => {
    expect.assertions(3);
    try {
      resolveSaleDate({ raw: daysAgoBd(3), req: cashierReq(), shop: shopDoc() });
    } catch (err) {
      expect(err.statusCode).toBe(403);
      expect(err.messageBn).toContain('মালিক');
      // No figure and no date leaked back about what WOULD have been accepted.
      expect(err.messageBn).not.toMatch(/\d/);
    }
  });

  test('the owner may name a date', () => {
    const when = resolveSaleDate({ raw: daysAgoBd(3), req: ownerReq(), shop: shopDoc() });
    expect(when).toBeInstanceOf(Date);
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(3));
  });

  test('the platform admin may too — they carry no user.isOwner (the M-7 trap)', () => {
    const when = resolveSaleDate({ raw: daysAgoBd(1), req: adminReq(), shop: shopDoc() });
    expect(toBangladeshDateStr(when)).toBe(daysAgoBd(1));
  });

  test('a script with no request may — there is no cashier to distrust', () => {
    expect(resolveSaleDate({ raw: daysAgoBd(1) })).toBeInstanceOf(Date);
  });

  test('a future date is refused 400 — this is BACKdating', () => {
    expect.assertions(2);
    const tomorrow = toBangladeshDateStr(new Date(Date.now() + 36 * 60 * 60 * 1000));
    try {
      resolveSaleDate({ raw: tomorrow, req: ownerReq(), shop: shopDoc() });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('ভবিষ্যতের');
    }
  });

  test("today itself is fine — it is not 'the future'", () => {
    const today = toBangladeshDateStr(new Date());
    expect(resolveSaleDate({ raw: today, req: ownerReq(), shop: shopDoc() })).toBeInstanceOf(Date);
  });

  test('garbage is refused 400', () => {
    expect.assertions(2);
    try {
      resolveSaleDate({ raw: 'kal bikale', req: ownerReq(), shop: shopDoc() });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toBeTruthy();
    }
  });

  test('a date before the shop existed is refused — the fat-fingered year', () => {
    expect.assertions(2);
    const shop = shopDoc(new Date('2024-06-01T00:00:00Z'));
    try {
      // 2016, not 2026. Without the floor this buries an invoice a decade deep
      // in the reports and nothing complains.
      resolveSaleDate({ raw: '2016-08-10', req: ownerReq(shop), shop });
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.messageBn).toContain('দোকান');
    }
  });

  test('a shop with no createdAt (a Redis-cached doc) has no floor, not a crash', () => {
    const shop = { _id: id() };
    expect(
      resolveSaleDate({ raw: daysAgoBd(2), req: ownerReq(shop), shop })
    ).toBeInstanceOf(Date);
  });
});

describe('C. the Bangladesh day', () => {
  test("a bare date lands at NOON Bangladesh time, not on the day boundary", () => {
    const when = resolveSaleDate({ raw: '2026-08-10', req: ownerReq(), shop: shopDoc() });
    // Noon BD = 06:00 UTC.
    expect(when.toISOString()).toBe('2026-08-10T06:00:00.000Z');
  });

  test('the resolved instant sits strictly INSIDE its Bangladesh day', () => {
    // The whole point of noon. A midnight-BD instant sits exactly on the bound
    // `getBangladeshDayRange` uses, and any rounding puts the sale in the wrong
    // day — which is the one thing this feature must never do.
    const when = resolveSaleDate({ raw: '2026-08-10', req: ownerReq(), shop: shopDoc() });
    const { startOfDay, endOfDay } = getBangladeshDayRange('2026-08-10');
    expect(when.getTime()).toBeGreaterThan(startOfDay.getTime());
    expect(when.getTime()).toBeLessThan(endOfDay.getTime());
  });

  test('a bare date is read as a BANGLADESH date, never a UTC one', () => {
    // `new Date('2026-08-10')` is UTC midnight = 06:00 Dhaka, and would be the
    // 9th for the six hours either side. This is the bug the parse exists to
    // avoid, so pin the day it resolves to.
    const when = resolveSaleDate({ raw: '2026-08-10', req: ownerReq(), shop: shopDoc() });
    expect(toBangladeshDateStr(when)).toBe('2026-08-10');
  });

  test('a full ISO datetime is honoured as given — 7pm stays 7pm', () => {
    const when = resolveSaleDate({
      raw: '2026-08-10T13:00:00.000Z', // 19:00 Dhaka
      req: ownerReq(),
      shop: shopDoc(),
    });
    expect(when.toISOString()).toBe('2026-08-10T13:00:00.000Z');
    expect(toBangladeshDateStr(when)).toBe('2026-08-10');
  });

  test('a Date instance is accepted as-is', () => {
    const raw = new Date('2026-08-10T06:00:00.000Z');
    expect(resolveSaleDate({ raw, req: ownerReq(), shop: shopDoc() }).getTime()).toBe(
      raw.getTime()
    );
  });

  test('a late-evening BD instant does NOT slip into the next day', () => {
    // 23:30 Dhaka on the 10th = 17:30 UTC on the 10th. A UTC-based reading of
    // "which day is this" gets this one right; the 00:30 case below is the one
    // that catches a naive implementation.
    const when = resolveSaleDate({
      raw: '2026-08-10T17:30:00.000Z',
      req: ownerReq(),
      shop: shopDoc(),
    });
    expect(toBangladeshDateStr(when)).toBe('2026-08-10');
  });

  test('a 00:30 Dhaka instant belongs to that Bangladesh day, not the UTC one', () => {
    // 00:30 Dhaka on the 11th = 18:30 UTC on the 10th.
    const when = resolveSaleDate({
      raw: '2026-08-10T18:30:00.000Z',
      req: ownerReq(),
      shop: shopDoc(),
    });
    expect(toBangladeshDateStr(when)).toBe('2026-08-11');
  });
});

describe('D. wiring', () => {
  test('the createSale schema carries `saleDate` — stripUnknown would eat it', () => {
    const { error, value } = saleValidation.createSale.validate(
      {
        items: [{ productId: id().toString(), quantity: 1 }],
        saleDate: '2026-08-10',
      },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    // The assertion that matters: it SURVIVED the strip.
    expect(value.saleDate).toBe('2026-08-10');
  });

  test('a full ISO datetime survives the schema too', () => {
    const { error, value } = saleValidation.createSale.validate(
      {
        items: [{ productId: id().toString(), quantity: 1 }],
        saleDate: '2026-08-10T13:00:00.000Z',
      },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    expect(value.saleDate).toBeTruthy();
  });

  test('an ordinary payload with no saleDate still validates', () => {
    const { error, value } = saleValidation.createSale.validate(
      { items: [{ productId: id().toString(), quantity: 1 }] },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    expect(value.saleDate).toBeUndefined();
  });

  test('the schema checks SHAPE only — policy stays in resolveSaleDate', () => {
    // A future date passes Joi and is refused by the util. Two places deciding
    // the same policy is how they come to disagree, so only one of them does.
    const future = toBangladeshDateStr(new Date(Date.now() + 36 * 60 * 60 * 1000));
    const { error } = saleValidation.createSale.validate(
      { items: [{ productId: id().toString(), quantity: 1 }], saleDate: future },
      { stripUnknown: true, abortEarly: false }
    );
    expect(error).toBeUndefined();
    expect(() =>
      resolveSaleDate({ raw: future, req: ownerReq(), shop: shopDoc() })
    ).toThrow();
  });
});

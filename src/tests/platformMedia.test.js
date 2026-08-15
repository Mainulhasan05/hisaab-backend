/**
 * The platform media library's reference machinery.
 *
 * These are the parts that decide whether bytes get deleted, and none of them
 * need a database:
 *
 *   · `confirmInUse` is the I-18 backstop. It MUST fail closed — a consumer that
 *     throws has to be read as "yes, still using it", because the alternative is
 *     deleting a file that something in production is serving.
 *   · `describeRefs` is why `refs` exists instead of a bare counter, and it must
 *     never let one broken consumer blank the admin's "used by" list.
 *   · `withoutMatching` is the filter behind every attach and detach. Getting
 *     its origin handling wrong makes a scan pass silently delete the explicit
 *     references a consumer attached, which surfaces much later as a missing
 *     image.
 */

const mongoose = require('mongoose');

const {
  PlatformMediaService,
  normalizeTags,
  withoutMatching,
} = require('../services/platformMedia.service');

const oid = () => new mongoose.Types.ObjectId();

/** Evaluate the `$filter` expression against a refs array, as Mongo would. */
function applyFilter(expr, refs) {
  const cond = expr.$filter.cond.$not[0].$and;
  return refs.filter((r) => {
    const matches = cond.every((c) => {
      const [lhs, rhs] = c.$eq;
      const field = String(lhs).replace('$$r.', '');
      return String(r[field]) === String(rhs);
    });
    return !matches;
  });
}

describe('normalizeTags', () => {
  test('lowercases, trims and de-duplicates', () => {
    expect(normalizeTags([' Aam ', 'AAM', 'mango'])).toEqual(['aam', 'mango']);
  });

  test('drops blanks and non-strings rather than storing them', () => {
    expect(normalizeTags(['', '   ', null, undefined, 'ok'])).toEqual(['ok']);
  });

  test('a non-array is an empty list, not a crash', () => {
    expect(normalizeTags('aam')).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  test('the count is bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(20);
  });
});

describe('withoutMatching', () => {
  const ownerId = oid();
  const other = oid();

  const refs = [
    { ownerType: 'landingPage', ownerId, key: 'hero', origin: 'explicit' },
    { ownerType: 'landingPage', ownerId, key: null, origin: 'scanned' },
    { ownerType: 'landingPage', ownerId: other, key: 'hero', origin: 'explicit' },
    { ownerType: 'emailTemplate', ownerId, key: 'banner', origin: 'explicit' },
  ];

  test('REGRESSION: a scanned pass leaves the same owner\'s explicit refs alone', () => {
    // The failure this pins: without `origin` in the match, a consumer's
    // save-time scan wipes the references it attached through the picker, and
    // the file becomes reclaimable while still on the page.
    const kept = applyFilter(withoutMatching({ ownerType: 'landingPage', ownerId, origin: 'scanned' }), refs);

    expect(kept).toHaveLength(3);
    expect(kept.some((r) => r.origin === 'explicit' && String(r.ownerId) === String(ownerId))).toBe(true);
    expect(kept.some((r) => r.origin === 'scanned')).toBe(false);
  });

  test('omitting origin drops everything that owner holds — releaseOwner', () => {
    const kept = applyFilter(withoutMatching({ ownerType: 'landingPage', ownerId }), refs);

    expect(kept).toHaveLength(2);
    expect(kept.every((r) => String(r.ownerId) !== String(ownerId) || r.ownerType !== 'landingPage')).toBe(true);
  });

  test('another owner of the same type is never touched', () => {
    const kept = applyFilter(withoutMatching({ ownerType: 'landingPage', ownerId }), refs);
    expect(kept.some((r) => String(r.ownerId) === String(other))).toBe(true);
  });

  test('another consumer type is never touched', () => {
    const kept = applyFilter(withoutMatching({ ownerType: 'landingPage', ownerId }), refs);
    expect(kept.some((r) => r.ownerType === 'emailTemplate')).toBe(true);
  });
});

describe('the consumer registry', () => {
  test('an unregistered ownerType is refused, not silently accepted', () => {
    const svc = new PlatformMediaService();
    expect(() => svc.assertOwnerType('landingPage')).toThrow();

    svc.registerConsumer({ ownerType: 'landingPage', label: 'সিজন পেজ' });
    expect(() => svc.assertOwnerType('landingPage')).not.toThrow();
  });

  test('the library carries no consumers of its own', () => {
    // If this ever fails, a consumer has been hard-coded into the library and
    // the dependency has been inverted.
    expect(new PlatformMediaService().consumers()).toEqual([]);
  });
});

describe('confirmInUse — the I-18 backstop', () => {
  const a = String(oid());
  const b = String(oid());

  test('an empty input asks nobody', async () => {
    const svc = new PlatformMediaService();
    const asked = jest.fn();
    svc.registerConsumer({ ownerType: 'x', label: 'X', confirmInUse: asked });

    expect((await svc.confirmInUse([])).size).toBe(0);
    expect(asked).not.toHaveBeenCalled();
  });

  test('what a consumer claims comes back as in use', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({ ownerType: 'x', label: 'X', confirmInUse: async () => [a] });

    const inUse = await svc.confirmInUse([a, b]);
    expect(inUse.has(a)).toBe(true);
    expect(inUse.has(b)).toBe(false);
  });

  test('claims from several consumers are unioned', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({ ownerType: 'x', label: 'X', confirmInUse: async () => [a] });
    svc.registerConsumer({ ownerType: 'y', label: 'Y', confirmInUse: async () => [b] });

    const inUse = await svc.confirmInUse([a, b]);
    expect(inUse.size).toBe(2);
  });

  test('REGRESSION: a consumer that THROWS protects everything it was asked about', async () => {
    // Fail-closed. Reading a broken callback as "nothing is in use" deletes
    // bytes that something in production is serving, and the sweep would report
    // success while doing it.
    const svc = new PlatformMediaService();
    svc.registerConsumer({
      ownerType: 'x',
      label: 'X',
      confirmInUse: async () => { throw new Error('database down'); },
    });

    const inUse = await svc.confirmInUse([a, b]);
    expect(inUse.has(a)).toBe(true);
    expect(inUse.has(b)).toBe(true);
  });

  test('one consumer failing does not suppress another\'s honest answer', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({
      ownerType: 'x',
      label: 'X',
      confirmInUse: async () => { throw new Error('down'); },
    });
    svc.registerConsumer({ ownerType: 'y', label: 'Y', confirmInUse: async () => [] });

    const inUse = await svc.confirmInUse([a, b]);
    expect(inUse.size).toBe(2);
  });

  test('a consumer with no confirmInUse callback is skipped, not treated as claiming', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({ ownerType: 'x', label: 'X' });

    expect((await svc.confirmInUse([a, b])).size).toBe(0);
  });
});

describe('describeRefs', () => {
  const ownerId = oid();
  const doc = (refs) => ({ refs });

  test('a consumer resolves its own refs into names and links', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({
      ownerType: 'landingPage',
      label: 'সিজন পেজ',
      resolve: async (ids) => ids.map((id) => ({ id, label: 'আম ২০২৬', href: `/p/${id}` })),
    });

    const out = await svc.describeRefs([doc([{ ownerType: 'landingPage', ownerId }])]);

    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('আম ২০২৬');
    expect(out[0].href).toContain(String(ownerId));
  });

  test('REGRESSION: a consumer that throws still yields an entry', async () => {
    // An unresolvable reference still blocks a delete. Dropping it would make
    // the block look like a bug and invite someone to "fix" the guard.
    const svc = new PlatformMediaService();
    svc.registerConsumer({
      ownerType: 'landingPage',
      label: 'সিজন পেজ',
      resolve: async () => { throw new Error('boom'); },
    });

    const out = await svc.describeRefs([doc([{ ownerType: 'landingPage', ownerId }])]);

    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('সিজন পেজ');
    expect(out[0].id).toBe(String(ownerId));
  });

  test('an unregistered consumer still yields an entry rather than vanishing', async () => {
    const svc = new PlatformMediaService();
    const out = await svc.describeRefs([doc([{ ownerType: 'ghost', ownerId }])]);

    expect(out).toHaveLength(1);
    expect(out[0].ownerType).toBe('ghost');
  });

  test('one owner referenced from several files is described once', async () => {
    const svc = new PlatformMediaService();
    svc.registerConsumer({
      ownerType: 'landingPage',
      label: 'সিজন পেজ',
      resolve: async (ids) => ids.map((id) => ({ id, label: 'আম', href: null })),
    });

    const out = await svc.describeRefs([
      doc([{ ownerType: 'landingPage', ownerId }]),
      doc([{ ownerType: 'landingPage', ownerId }]),
    ]);

    expect(out).toHaveLength(1);
  });

  test('files with no refs describe to nothing', async () => {
    const svc = new PlatformMediaService();
    expect(await svc.describeRefs([doc([]), doc(undefined)])).toEqual([]);
  });
});

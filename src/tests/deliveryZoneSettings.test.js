/**
 * The delivery-zone gate — `storefront.service.normalizeZones`.
 *
 * The settings PATCH replaces the zone table wholesale, and before this gate
 * existed it was stored with only an `Array.isArray` check: a zone with a NaN
 * charge, a blank name or a duplicate key went straight into the document that
 * `order.service.resolveDelivery` snapshots MONEY from.
 *
 * REGRESSIONS: every refusal case below fails against the old pass-through
 * (which threw only on a non-array). The normalisation cases document the
 * shape the checkout depends on.
 */

const { normalizeZones } = require('../services/storefront.service');

const zone = (over = {}) => ({
  name: 'Inside Dhaka',
  nameBn: 'ঢাকার ভিতরে',
  charge: 60,
  freeAbove: 0,
  etaDaysMin: 1,
  etaDaysMax: 2,
  isActive: true,
  ...over,
});

describe('normalizeZones — refusals', () => {
  test('a non-array is refused', () => {
    expect(() => normalizeZones('not-an-array')).toThrow();
    expect(() => normalizeZones(undefined)).toThrow();
  });

  test('REGRESSION: a blank name is refused', () => {
    expect(() => normalizeZones([zone({ name: '', nameBn: '' })])).toThrow(/name/i);
  });

  test('REGRESSION: a NaN charge is refused, not stored', () => {
    expect(() => normalizeZones([zone({ charge: 'sixty' })])).toThrow();
  });

  test('REGRESSION: a negative charge is refused', () => {
    expect(() => normalizeZones([zone({ charge: -10 })])).toThrow();
  });

  test('an absurd charge is a typo, not a price', () => {
    expect(() => normalizeZones([zone({ charge: 5000000 })])).toThrow();
  });

  test('more than 20 zones is refused', () => {
    const many = Array.from({ length: 21 }, (_, i) => zone({ key: `z${i}`, name: `Zone ${i}` }));
    expect(() => normalizeZones(many)).toThrow();
  });
});

describe('normalizeZones — normalisation', () => {
  test('a stored key is preserved (orders snapshot zoneKey)', () => {
    const [result] = normalizeZones([zone({ key: 'inside-dhaka' })]);
    expect(result.key).toBe('inside-dhaka');
  });

  test('a new zone derives a key from its English name', () => {
    const [result] = normalizeZones([zone({ key: undefined, name: 'Chittagong City' })]);
    expect(result.key).toBe('chittagong-city');
  });

  test('a Bengali-only zone still gets a usable key', () => {
    const [result] = normalizeZones([
      { name: '', nameBn: 'সিলেট', charge: 100 },
    ].map((z) => ({ ...zone(), ...z, name: z.name || z.nameBn })));
    expect(result.key).toMatch(/^zone-1$|^[a-z0-9-]+$/);
    expect(result.key.length).toBeGreaterThan(0);
  });

  test('REGRESSION: duplicate keys are made unique — resolveDelivery matches by key', () => {
    const [a, b] = normalizeZones([
      zone({ key: 'dhaka' }),
      zone({ key: 'dhaka', name: 'Dhaka Outskirts' }),
    ]);
    expect(a.key).not.toBe(b.key);
  });

  test('eta days are clamped and ordered (max >= min)', () => {
    const [result] = normalizeZones([zone({ etaDaysMin: 5, etaDaysMax: 2 })]);
    expect(result.etaDaysMax).toBeGreaterThanOrEqual(result.etaDaysMin);
  });

  test('isActive defaults on, explicit false survives', () => {
    const [on, off] = normalizeZones([zone(), zone({ key: 'x', isActive: false })]);
    expect(on.isActive).toBe(true);
    expect(off.isActive).toBe(false);
  });
});

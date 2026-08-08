/**
 * Unit tests for audit-log payload shaping (utils/auditDiff.util.js).
 *
 * These replaced whole-document `toObject()` snapshots in the audit log, so
 * the thing worth pinning down is that nothing an auditor needs went missing
 * in the process — and that the shrinking is real.
 */

const { auditSnapshot, auditDiff, AUDIT_FIELDS } = require('../utils/auditDiff.util');

describe('auditSnapshot', () => {
  it('keeps only whitelisted fields', () => {
    const doc = { name: 'Rice', sellingPrice: 80, variants: [1, 2, 3], images: ['a', 'b'] };
    const out = auditSnapshot(doc, ['name', 'sellingPrice']);
    expect(out).toEqual({ name: 'Rice', sellingPrice: 80 });
  });

  it('drops the heavy arrays that motivated the change', () => {
    const doc = {
      name: 'Rice',
      variants: new Array(50).fill({ sku: 'x', stock: 1 }),
      batches: new Array(30).fill({ quantity: 5 }),
      images: new Array(10).fill('https://example.com/a.jpg'),
    };
    const out = auditSnapshot(doc, AUDIT_FIELDS.product);
    expect(out.variants).toBeUndefined();
    expect(out.batches).toBeUndefined();
    expect(out.images).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(doc).length / 5);
  });

  it('calls toObject when given a Mongoose-like document', () => {
    const doc = { toObject: () => ({ name: 'Oil', stock: 4 }) };
    expect(auditSnapshot(doc, ['name', 'stock'])).toEqual({ name: 'Oil', stock: 4 });
  });

  it('omits undefined fields rather than storing nulls', () => {
    const out = auditSnapshot({ name: 'Tea' }, ['name', 'barcode']);
    expect(out).toEqual({ name: 'Tea' });
    expect('barcode' in out).toBe(false);
  });

  it('returns {} for a null document', () => {
    expect(auditSnapshot(null, ['name'])).toEqual({});
  });
});

describe('auditDiff', () => {
  it('records only the fields that actually changed', () => {
    const before = { name: 'Rice', sellingPrice: 80, stock: 100 };
    const after = { name: 'Rice', sellingPrice: 95, stock: 100 };
    expect(auditDiff(before, after, ['name', 'sellingPrice', 'stock'])).toEqual({
      before: { sellingPrice: 80 },
      after: { sellingPrice: 95 },
    });
  });

  it('returns empty sides when nothing changed', () => {
    const doc = { name: 'Rice', sellingPrice: 80 };
    expect(auditDiff(doc, { ...doc }, ['name', 'sellingPrice'])).toEqual({
      before: {}, after: {},
    });
  });

  it('compares nested objects structurally, not by reference', () => {
    // `packaging` is a nested object reloaded from Mongo on each read — by
    // reference it would look changed on every single edit.
    const before = { packaging: { packUnit: 'carton', packSize: 20 } };
    const after = { packaging: { packUnit: 'carton', packSize: 20 } };
    expect(auditDiff(before, after, ['packaging'])).toEqual({ before: {}, after: {} });

    const changed = { packaging: { packUnit: 'carton', packSize: 24 } };
    expect(auditDiff(before, changed, ['packaging']).after.packaging.packSize).toBe(24);
  });

  it('represents a newly-set field as null -> value', () => {
    expect(auditDiff({ name: 'Rice' }, { name: 'Rice', barcode: '123' }, ['name', 'barcode']))
      .toEqual({ before: { barcode: null }, after: { barcode: '123' } });
  });

  it('represents a cleared field as value -> null', () => {
    expect(auditDiff({ barcode: '123' }, {}, ['barcode']))
      .toEqual({ before: { barcode: '123' }, after: { barcode: null } });
  });

  it('ignores fields outside the whitelist even when they change', () => {
    const before = { name: 'Rice', updatedAt: new Date('2020-01-01') };
    const after = { name: 'Rice', updatedAt: new Date('2026-01-01') };
    expect(auditDiff(before, after, ['name'])).toEqual({ before: {}, after: {} });
  });

  it('accepts Mongoose-like documents on either side', () => {
    const before = { toObject: () => ({ stock: 10 }) };
    const after = { toObject: () => ({ stock: 7 }) };
    expect(auditDiff(before, after, ['stock']))
      .toEqual({ before: { stock: 10 }, after: { stock: 7 } });
  });

  it('treats a zero value as a real change, not as absent', () => {
    // Falsy-but-present values are exactly what a naive implementation drops.
    expect(auditDiff({ stock: 5 }, { stock: 0 }, ['stock']))
      .toEqual({ before: { stock: 5 }, after: { stock: 0 } });
  });

  it('treats false as a real change', () => {
    expect(auditDiff({ isActive: true }, { isActive: false }, ['isActive']))
      .toEqual({ before: { isActive: true }, after: { isActive: false } });
  });
});

describe('AUDIT_FIELDS', () => {
  it('tracks the product fields an auditor would ask about', () => {
    for (const f of ['name', 'sellingPrice', 'buyingPrice', 'stock', 'isActive']) {
      expect(AUDIT_FIELDS.product).toContain(f);
    }
  });

  it('tracks the customer money fields', () => {
    for (const f of ['name', 'phone', 'totalDue', 'creditLimit']) {
      expect(AUDIT_FIELDS.customer).toContain(f);
    }
  });
});

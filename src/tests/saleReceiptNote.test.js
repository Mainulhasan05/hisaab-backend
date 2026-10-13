/**
 * The till's note on the customer's receipt — `Sale.receiptNote`.
 *
 * `Sale.notes` was internal-only until 2026-10-13 and cashiers wrote it on that
 * promise; what prints is a separate snapshot, taken only by `createSale` from
 * the till's own note. `createSale` cannot be run here with mocked models (see
 * restaurantFeature.test.js), so the wiring is pinned structurally.
 *
 * [R] = regression: fails without the feature.  [G] = invariant guard.
 */
const fs = require('fs');
const path = require('path');
const Sale = require('../models/Sale.model');

const SRC = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const saleSrc = read('services/sale.service.js');

const body = (source, signature) => {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  // `) {` — the body, not a `= {}` default in the parameter list.
  let i = source.indexOf(') {', start) + 2;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.slice(start, i + 1);
};

describe('Sale.receiptNote', () => {
  it('[R] exists on the schema and is absent unless written', () => {
    expect(Sale.schema.path('receiptNote')).toBeDefined();
    const doc = new Sale({ notes: 'ভেতরের নোট' }).toObject();
    // Old invoices, and new ones without a note, keep their exact shape —
    // and an internal note alone never becomes printable.
    expect(doc).not.toHaveProperty('receiptNote');
  });

  it('[R] createSale snapshots the till note — but never an online order\'s', () => {
    const create = body(saleSrc, 'async createSale(');
    expect(create).toMatch(/!linkedOrder && typeof notes === 'string' && notes\.trim\(\)/);
    expect(create).toMatch(/\{ receiptNote: notes\.trim\(\)\.slice\(0, 500\) \}/);
  });

  it('[G] createSale is the only writer — cancel appends to notes, never here', () => {
    const services = fs.readdirSync(path.join(SRC, 'services')).filter((f) => f.endsWith('.js'));
    const writers = services.filter((f) => /receiptNote\s*[:=]/.test(read(`services/${f}`)));
    expect(writers).toEqual(['sale.service.js']);
    expect(body(saleSrc, 'async cancelSale(')).not.toMatch(/receiptNote/);
    expect(saleSrc.match(/receiptNote\s*[:=]/g)).toHaveLength(1);
  });

  it('[G] a client cannot post it directly — the Joi schema does not carry it', () => {
    // validate.middleware runs with stripUnknown, so an absent key is dropped
    // before the service sees it; the only way in is the till's `notes`.
    expect(read('validations/sale.validation.js')).not.toMatch(/receiptNote/);
  });
});

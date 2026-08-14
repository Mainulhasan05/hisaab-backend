/**
 * Cost basis — the moving weighted average that profit is computed from.
 *
 * Before this existed, `Product.buyingPrice` was whatever a shopkeeper last
 * typed into the product form and `createPurchase` never touched it. Every
 * profit figure in the app reads that field, so as supplier prices moved the
 * reported margin drifted away from the real one with nothing to signal it.
 *
 * Two things must hold and neither is obvious from reading either half alone:
 *
 *   A. THE FORMULA — blending is a weighted average of what is on the shelf and
 *      what just arrived, and it never moves on a zero-cost receipt.
 *   B. THE TWO IMPLEMENTATIONS AGREE — `blendedCost` (JS, used for the snapshot
 *      a cancellation reverses from) and `blendExpr` (the Mongo pipeline that
 *      actually writes the field) must produce the same number, or a
 *      cancellation would restore a cost the receipt never set.
 */

const mongoose = require('mongoose');
const {
  blendedCost,
  shouldRecost,
  buildProductCostUpdate,
  buildVariantCostUpdate,
  COST_DP,
} = require('../utils/costing.util');

/**
 * Evaluate the pipeline's `$set` expression in JS.
 *
 * A deliberately literal walk of the operators the builder emits — `$max`,
 * `$ifNull`, `$add`, `$multiply`, `$divide`, `$cond`, `$gt`, `$round`. It exists
 * so group B can compare the SHIPPED pipeline against `blendedCost` rather than
 * comparing `blendedCost` with a copy of itself.
 */
function evalExpr(expr, scope) {
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'string') {
    if (!expr.startsWith('$')) return expr;
    const path = expr.replace(/^\$\$?/, '');
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
  }

  const [op, arg] = Object.entries(expr)[0];
  const args = Array.isArray(arg) ? arg.map((a) => evalExpr(a, scope)) : evalExpr(arg, scope);

  switch (op) {
    case '$max': return Math.max(...args);
    case '$ifNull': return args[0] ?? args[1];
    case '$add': return args.reduce((a, b) => a + b, 0);
    case '$multiply': return args.reduce((a, b) => a * b, 1);
    case '$divide': return args[0] / args[1];
    case '$gt': return args[0] > args[1];
    case '$cond': return args[0] ? args[1] : args[2];
    case '$round': {
      const f = Math.pow(10, args[1]);
      return Math.round(args[0] * f) / f;
    }
    default: throw new Error(`evalExpr: unhandled operator ${op}`);
  }
}

const costExprOf = (update) => update[0].$set.buyingPrice;

/* ════════════════════════════════════════════════════════════════════════
 * A. THE FORMULA
 * ════════════════════════════════════════════════════════════════════════ */
describe('A. moving weighted average', () => {
  test('blends the shelf with the delivery', () => {
    // 10 on hand at ৳100, 10 arriving at ৳120 → ৳110
    expect(blendedCost(10, 100, 10, 120)).toBe(110);
  });

  test('an empty shelf takes the delivery rate outright', () => {
    expect(blendedCost(0, 999, 5, 80)).toBe(80);
  });

  test('negative stock cannot invert or inflate the average', () => {
    // A product oversold into negative stock (possible via clamped reversals)
    // would otherwise give a negative denominator and a nonsense cost.
    expect(blendedCost(-4, 100, 10, 50)).toBe(50);
  });

  test('a small top-up barely moves a large shelf', () => {
    // The failure mode of "last purchase price": one promotional carton must not
    // restate the cost of a warehouse.
    expect(blendedCost(1000, 100, 1, 50)).toBeCloseTo(99.95, 2);
  });

  test('a zero-cost receipt does NOT move the average', () => {
    // Samples, warranty replacements, an opening count. Blending ৳0 in would
    // write the shelf down to nothing and report the next sale as pure profit.
    expect(shouldRecost(10, 0)).toBe(false);
    expect(blendedCost(10, 100, 10, 0)).toBe(100);
    expect(buildProductCostUpdate(10, 0)).toBeNull();
    expect(buildVariantCostUpdate(new mongoose.Types.ObjectId(), 10, 0)).toBeNull();
  });

  test('a zero-quantity receipt does not move the average either', () => {
    expect(buildProductCostUpdate(0, 500)).toBeNull();
  });

  test('the result is rounded to paisa, like every other money figure', () => {
    // 3 at ৳10 + 1 at ৳10.005 → 10.00125
    expect(blendedCost(3, 10, 1, 10.005)).toBe(10);
    expect(COST_DP).toBe(2);
  });

  test('selling does not change the cost — the defining property', () => {
    // Nothing in the sale path calls into this module. Asserted here as a guard:
    // if a future change starts re-costing on sale, moving average is no longer
    // what this system implements and the P&L identity breaks.
    const costing = require('../utils/costing.util');
    const saleSource = require('fs').readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );
    expect(Object.keys(costing).some((fn) => saleSource.includes(fn))).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * B. THE PIPELINE AND THE JS AGREE
 * ════════════════════════════════════════════════════════════════════════ */
describe('B. pipeline and JS produce identical costs', () => {
  const cases = [
    { onHand: 10, oldCost: 100, received: 10, unitCost: 120 },
    { onHand: 0, oldCost: 0, received: 5, unitCost: 80 },
    { onHand: 1000, oldCost: 100, received: 1, unitCost: 50 },
    { onHand: 0.333, oldCost: 70, received: 0.667, unitCost: 90 },
    { onHand: 7, oldCost: 33.33, received: 3, unitCost: 41.67 },
  ];

  test.each(cases)(
    'product: $onHand @ $oldCost + $received @ $unitCost',
    ({ onHand, oldCost, received, unitCost }) => {
      const update = buildProductCostUpdate(received, unitCost);
      const fromPipeline = evalExpr(costExprOf(update), { stock: onHand, buyingPrice: oldCost });
      expect(fromPipeline).toBe(blendedCost(onHand, oldCost, received, unitCost));
    }
  );

  test('a missing buyingPrice reads as zero on both sides', () => {
    const update = buildProductCostUpdate(10, 50);
    const fromPipeline = evalExpr(costExprOf(update), { stock: 10, buyingPrice: null });
    expect(fromPipeline).toBe(blendedCost(10, null, 10, 50));
    expect(fromPipeline).toBe(25);
  });

  test('the variant builder casts its id — a string matches no element', () => {
    // Inside a pipeline `$eq` compares BSON types, so an uncast string id makes
    // the update silently write nothing at all (I-3).
    const id = new mongoose.Types.ObjectId();
    const update = buildVariantCostUpdate(String(id), 10, 120);
    const cond = update[0].$set.variants.$map.in.$cond[0];
    expect(cond.$eq[1]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(cond.$eq[1])).toBe(String(id));
  });

  test('the variant branch blends the VARIANT cost, not the product cost', () => {
    const update = buildVariantCostUpdate(new mongoose.Types.ObjectId(), 10, 120);
    const expr = update[0].$set.variants.$map.in.$cond[1].$mergeObjects[1].buyingPrice;
    const fromPipeline = evalExpr(expr, { v: { stock: 10, buyingPrice: 100 } });
    expect(fromPipeline).toBe(110);
  });
});

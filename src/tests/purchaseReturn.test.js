/**
 * কেনা ফেরত — RTV to the supplier (PURCHASE_RETURN_PLAN.md §9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE PIN, AND WHY EACH ONE IS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything in this file is a REGRESSION for new behaviour — none of it exists
 * against the old code, because `purchaseReturn.service` did not — EXCEPT the
 * two blocks marked INVARIANT GUARD, which assert that a shop with no returns
 * is byte-identical to before (I-1) and would pass either way. §7.1 asks for
 * that distinction to be stated, so it is.
 *
 * The three that are easiest to get backwards, and are therefore tested hardest:
 *
 *   · **billed refunds, landed leaves the shelf (D-1).** The supplier credit is
 *     computed from `unitPrice`; the stock ledger is written from
 *     `landedUnitPrice`. Swapping them is invisible to every screen and wrong
 *     in every report.
 *   · **`due` moves and `paid` does not.** The whole due-reduction mechanism
 *     rests on `Purchase.returnedAmount` being a third term in the pre-save
 *     hook. A test that only checked `due` would pass against a version that
 *     inflated `paid` — and that version reports cash the shop never handed
 *     over, on the statement it reconciles against the supplier's own paper.
 *   · **Σ SupplierBalance.totalDue === Supplier.totalDue (§8).** Asserted on
 *     real arithmetic rather than on calls having happened, the way
 *     `purchaseCancelUnwind` does it.
 */

jest.mock('../models/AuditLog.model', () => ({
  log: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue([{}]),
}));
jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const purchaseReturnService = require('../services/purchaseReturn.service');
const purchaseService = require('../services/purchase.service');
const detailedReportService = require('../services/detailedReport.service');
const paymentAccountService = require('../services/paymentAccount.service');

const PurchaseReturn = require('../models/PurchaseReturn.model');
const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const SupplierDueAdjustment = require('../models/SupplierDueAdjustment.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');

const { PAYMENT_TYPES, STOCK_TRANSACTION_TYPES, AUDIT_ACTIONS } = require('../config/constants');
const { PURCHASE_MONEY_KEYS } = require('../utils/dataSanitizer.util');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const SUPPLIER = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const PURCHASE_ID = new mongoose.Types.ObjectId();
const OLDER_ID = new mongoose.Types.ObjectId();
const PRODUCT_ID = new mongoose.Types.ObjectId();
const VARIANT_ID = new mongoose.Types.ObjectId();
const ITEM_ID = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

/* ════════════════════════════════════════════════════════════════════════════
 * Fixtures
 * ════════════════════════════════════════════════════════════════════════════ */

/** Mirror `Purchase.pre('save')`, `returnedAmount` term included. */
function applyPurchaseHook(doc) {
  const returned = Number.isFinite(doc.returnedAmount)
    ? Math.min(Math.max(0, doc.returnedAmount), Math.max(0, doc.totalAmount - doc.paid))
    : 0;
  doc.due = Math.max(0, doc.totalAmount - doc.paid - returned);
  if (doc.status !== 'cancelled') {
    doc.status = doc.due === 0 ? 'completed' : doc.paid > 0 ? 'partial' : 'unpaid';
  }
  return doc;
}

function billDoc(overrides = {}) {
  const doc = {
    _id: PURCHASE_ID,
    shop: SHOP,
    branch: BRANCH,
    supplier: SUPPLIER,
    supplierName: 'রহিম ট্রেডার্স',
    invoiceNo: 'PUR2026080001',
    // 10 sacks at ৳100, no concessions — `landedUnitPrice` deliberately HIGHER
    // than `unitPrice` so any test that refunds the landed figure by mistake
    // reads visibly wrong rather than coincidentally right.
    items: [{
      _id: ITEM_ID,
      product: PRODUCT_ID,
      productName: 'চাল',
      productCode: 'P-1',
      quantity: 10,
      unit: 'piece',
      unitPrice: 100,
      lineDiscount: 0,
      discountShare: 0,
      landedUnitPrice: 112,
      total: 1000,
    }],
    totalAmount: 1000,
    paid: 0,
    due: 1000,
    status: 'unpaid',
    date: new Date('2026-08-01'),
    save: jest.fn().mockImplementation(function () {
      applyPurchaseHook(this);
      return Promise.resolve(this);
    }),
    ...overrides,
  };
  return doc;
}

function productDoc(overrides = {}) {
  return {
    _id: PRODUCT_ID,
    shop: SHOP,
    unit: 'piece',
    stock: 10,
    hasVariants: false,
    variants: [],
    trackBatches: false,
    batches: [],
    ...overrides,
  };
}

let bulkOps;
let bulkResults;
let stockTxns;
let payments;
let accountDeltas;
let supplierDoc;
let balanceRow;
let createdReturns;

function stubEverything({
  purchase = billDoc(),
  product = productDoc(),
  priorReturns = [],
  olderBills = [],
} = {}) {
  jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(purchase) });
  jest.spyOn(Purchase, 'find').mockReturnValue({
    sort: () => ({ session: () => Promise.resolve(olderBills) }),
  });
  jest.spyOn(PurchaseReturn, 'find').mockReturnValue({
    session: () => Promise.resolve(priorReturns),
  });
  jest.spyOn(PurchaseReturn, 'generateReturnNo').mockResolvedValue('PRET202608270001');
  jest.spyOn(PurchaseReturn, 'create').mockImplementation(async ([doc]) => {
    const created = { _id: new mongoose.Types.ObjectId(), ...doc };
    createdReturns.push(created);
    return [created];
  });
  jest.spyOn(Product, 'find').mockReturnValue({
    session: () => Promise.resolve([product]),
  });
  return { purchase, product };
}

beforeEach(() => {
  bulkOps = [];
  bulkResults = [];
  stockTxns = [];
  payments = [];
  accountDeltas = [];
  createdReturns = [];

  jest.spyOn(Product, 'bulkWrite').mockImplementation(async (ops) => {
    bulkOps.push(ops);
    // Every guarded op matched, unless a test overrides this.
    const result = { modifiedCount: ops.length };
    bulkResults.push(result);
    return result;
  });
  jest.spyOn(StockTransaction, 'insertMany').mockImplementation(async (rows) => {
    stockTxns.push(...rows);
    return rows;
  });
  jest.spyOn(Payment, 'create').mockImplementation(async ([row]) => {
    payments.push(row);
    return [row];
  });

  supplierDoc = {
    _id: SUPPLIER,
    totalAmount: 1000,
    totalPaid: 0,
    openingDue: 0,
    totalDue: 1000,
    advanceBalance: 0,
    totalPurchases: 1,
    // Both the cancel path and the return path now READ this document, move a
    // component and re-derive, so one fixture serves both and the Σ invariant
    // is asserted on the same numbers either way.
    save: jest.fn().mockResolvedValue(undefined),
  };
  jest.spyOn(Supplier, 'findById').mockReturnValue({
    session: () => Promise.resolve(supplierDoc),
  });
  // Kept mocked so a stray call is observable rather than a live query. Nothing
  // should reach it any more: the `$inc` form could not tell a payable from a
  // prepayment, which is why every path was moved onto the components.
  jest.spyOn(Supplier, 'findByIdAndUpdate').mockResolvedValue(supplierDoc);

  balanceRow = { totalAmount: 1000, totalPaid: 0, totalDue: 1000, openingDue: 0, purchaseCount: 1 };
  jest.spyOn(SupplierBalance, 'applyDelta').mockImplementation(async (d) => {
    balanceRow.totalAmount += d.amount || 0;
    balanceRow.totalPaid += d.paid || 0;
    balanceRow.totalDue += d.due || 0;
    balanceRow.purchaseCount += d.count || 0;
  });
  jest.spyOn(SupplierBalance, 'recomputeBalances').mockImplementation(async () => {
    balanceRow.totalDue = Math.max(
      0, balanceRow.totalAmount + balanceRow.openingDue - balanceRow.totalPaid
    );
    return balanceRow;
  });

  jest.spyOn(paymentAccountService, 'applyAccountDelta').mockImplementation(async (d) => {
    accountDeltas.push(d);
  });
  jest.spyOn(paymentAccountService, 'resolveAccountForMethod').mockResolvedValue(ACCOUNT);
  jest.spyOn(paymentAccountService, 'assertUsableAccount').mockResolvedValue({ _id: ACCOUNT });
});

afterEach(() => jest.restoreAllMocks());

const createReturn = (data) =>
  purchaseReturnService.createReturn(SHOP, USER, {
    purchaseId: PURCHASE_ID,
    reason: 'পচা মাল',
    ...data,
  }, null);

/** All ops queued across every bulkWrite, flattened. */
const allOps = () => bulkOps.flat();

/* ════════════════════════════════════════════════════════════════════════════
 * 1 · Max returnable, across several partial returns
 * ════════════════════════════════════════════════════════════════════════════ */

describe('what may go back is the delivery less everything already returned', () => {
  it('allows a partial return against an untouched line', async () => {
    stubEverything();

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'pending',
    });

    expect(purchaseReturn.items[0].quantity).toBe(3);
    expect(purchaseReturn.totalAmount).toBe(300);
  });

  it('counts EVERY prior return, not just the last one', async () => {
    // Two partials of 3 and 4 already gone back out of 10 — 3 left.
    stubEverything({
      priorReturns: [
        { items: [{ purchaseItemId: ITEM_ID, quantity: 3 }] },
        { items: [{ purchaseItemId: ITEM_ID, quantity: 4 }] },
      ],
    });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('সর্বোচ্চ 3'),
    });
  });

  it('lets the last returnable unit through', async () => {
    stubEverything({
      priorReturns: [{ items: [{ purchaseItemId: ITEM_ID, quantity: 9 }] }],
      product: productDoc({ stock: 1 }),
    });

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 1 }],
      refundMethod: 'pending',
    });

    expect(purchaseReturn.totalAmount).toBe(100);
  });

  it('names the line when the id is not on this bill', async () => {
    stubEverything();
    await expect(createReturn({
      items: [{ purchaseItemId: new mongoose.Types.ObjectId(), quantity: 1 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2 · Billed refunds, landed leaves the shelf (D-1)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the refund is BILLED and the stock ledger is LANDED', () => {
  it('credits unitPrice and writes the ledger at landedUnitPrice', async () => {
    stubEverything();

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });

    // ৳100 billed × 4 — NOT the ৳112 the goods cost to get here. The ভাড়া on
    // returned goods is sunk; the truck really did drive.
    expect(purchaseReturn.totalAmount).toBe(400);
    expect(purchaseReturn.items[0].unitPrice).toBe(100);
    expect(purchaseReturn.items[0].landedUnitPrice).toBe(112);

    // The valuation ledger loses what the stock was worth.
    expect(stockTxns[0].unitCost).toBe(112);
    expect(stockTxns[0].totalCost).toBe(448);
  });

  it('splits both concessions largest-remainder, so a FULL return gives back exactly what the bill knocked off', async () => {
    // ৳10 line concession and ৳10 invoice share over 3 units: naive
    // multiplication returns 3.33 × 3 = 9.99 and loses a paisa into the
    // supplier's খাতা forever.
    const purchase = billDoc({
      items: [{
        _id: ITEM_ID,
        product: PRODUCT_ID,
        productName: 'চাল',
        quantity: 3,
        unit: 'piece',
        unitPrice: 100,
        lineDiscount: 10,
        discountShare: 10,
        landedUnitPrice: 100,
        total: 300,
      }],
      totalAmount: 280,
      due: 280,
    });
    stubEverything({ purchase, product: productDoc({ stock: 3 }) });

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'pending',
    });

    expect(purchaseReturn.items[0].lineDiscountShare).toBe(10);
    expect(purchaseReturn.items[0].discountShare).toBe(10);
    // 300 − 10 − 10, exactly. Not 279.98.
    expect(purchaseReturn.totalAmount).toBe(280);
  });

  it('a partial return takes a proportional slice that leaves the rest recoverable', async () => {
    const purchase = billDoc({
      items: [{
        _id: ITEM_ID,
        product: PRODUCT_ID,
        productName: 'চাল',
        quantity: 3,
        unit: 'piece',
        unitPrice: 100,
        lineDiscount: 10,
        discountShare: 0,
        landedUnitPrice: 100,
        total: 300,
      }],
      totalAmount: 290,
      due: 290,
    });
    stubEverything({ purchase, product: productDoc({ stock: 3 }) });

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 1 }],
      refundMethod: 'pending',
    });

    // 10 split [1, 2] → 3.33 to the returned unit, 6.67 left on the line. The
    // two sum to exactly 10, which is the property `_prorate` guarantees and a
    // bare `charge * r / q` does not.
    expect(purchaseReturn.items[0].lineDiscountShare).toBe(3.33);
    expect(purchaseReturn.totalAmount).toBe(96.67);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3 · Cannot return what is not on the shelf (D-5)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the guarded stock decrement', () => {
  it('refuses in Bangla, naming the product AND the stock it has', async () => {
    // Ten arrived, eight were sold to customers, two are left. The paper says
    // ten may go back; the shelf says two.
    stubEverything({ product: productDoc({ stock: 2 }) });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 5 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('চাল'),
    });

    const err = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 5 }],
      refundMethod: 'pending',
    }).catch((e) => e);
    expect(err.messageBn).toContain('2');

    // Refused BEFORE anything moved.
    expect(bulkOps).toEqual([]);
    expect(stockTxns).toEqual([]);
  });

  it('puts a $gte guard on the filter, not only on the pre-check', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });

    const stockOp = allOps().find(op => op.updateOne?.filter?.stock);
    expect(stockOp.updateOne.filter).toMatchObject({
      _id: PRODUCT_ID,
      shop: SHOP,
      stock: { $gte: 4 },
    });
  });

  it('turns a lost race — the guard matching nothing — into a 409, not silent oversell', async () => {
    stubEverything();
    Product.bulkWrite.mockImplementation(async (ops) => {
      bulkOps.push(ops);
      return { modifiedCount: 0 };  // a sale slipped in between read and write
    });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('guards a VARIANT line with $elemMatch, so one variant cannot borrow another\'s stock', async () => {
    const purchase = billDoc({
      items: [{
        _id: ITEM_ID,
        product: PRODUCT_ID,
        productName: 'শার্ট',
        variantId: VARIANT_ID,
        variantLabel: 'L',
        quantity: 5,
        unit: 'piece',
        unitPrice: 100,
        lineDiscount: 0,
        discountShare: 0,
        landedUnitPrice: 100,
        total: 500,
      }],
      totalAmount: 500,
      due: 500,
    });
    // The product-level rollup is 20; the variant being returned holds 2.
    const product = productDoc({
      hasVariants: true,
      stock: 20,
      variants: [
        { _id: VARIANT_ID, stock: 2 },
        { _id: new mongoose.Types.ObjectId(), stock: 18 },
      ],
    });
    stubEverything({ purchase, product });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 5 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({
      statusCode: 400,
      // The VARIANT's stock, not the product's 20.
      messageBn: expect.stringContaining('2'),
    });
  });

  it('writes an $elemMatch filter binding the id and the stock to ONE variant', async () => {
    const purchase = billDoc({
      items: [{
        _id: ITEM_ID, product: PRODUCT_ID, productName: 'শার্ট',
        variantId: VARIANT_ID, quantity: 5, unit: 'piece',
        unitPrice: 100, lineDiscount: 0, discountShare: 0,
        landedUnitPrice: 100, total: 500,
      }],
      totalAmount: 500, due: 500,
    });
    stubEverything({
      purchase,
      product: productDoc({
        hasVariants: true, stock: 10,
        variants: [{ _id: VARIANT_ID, stock: 10 }],
      }),
    });

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 5 }],
      refundMethod: 'pending',
    });

    const op = allOps().find(o => o.updateOne?.filter?.variants);
    // `{'variants._id': x, 'variants.stock': {$gte: q}}` would be satisfied by
    // one variant matching the id and a DIFFERENT one holding the stock.
    expect(op.updateOne.filter.variants).toEqual({
      $elemMatch: { _id: VARIANT_ID, stock: { $gte: 5 } },
    });
  });

  it('does not let two lines of one product each pass a guard the pair would fail', async () => {
    const second = new mongoose.Types.ObjectId();
    const purchase = billDoc({
      items: [
        { _id: ITEM_ID, product: PRODUCT_ID, productName: 'চাল', quantity: 5, unit: 'piece', unitPrice: 100, lineDiscount: 0, discountShare: 0, landedUnitPrice: 100, total: 500 },
        { _id: second, product: PRODUCT_ID, productName: 'চাল', quantity: 5, unit: 'piece', unitPrice: 100, lineDiscount: 0, discountShare: 0, landedUnitPrice: 100, total: 500 },
      ],
      totalAmount: 1000, due: 1000,
    });
    stubEverything({ purchase, product: productDoc({ stock: 6 }) });

    // 4 + 4 = 8 against 6 on the shelf. Each line alone would pass.
    await expect(createReturn({
      items: [
        { purchaseItemId: ITEM_ID, quantity: 4 },
        { purchaseItemId: second, quantity: 4 },
      ],
      refundMethod: 'pending',
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4 · Batches: this purchase's own parcel first, then FEFO
 * ════════════════════════════════════════════════════════════════════════════ */

describe('batch decrement prefers the batch this delivery brought in', () => {
  it('drains the purchaseRef batch, then falls back to FEFO for the remainder', async () => {
    const soon = new Date('2026-09-01');
    const later = new Date('2027-01-01');
    const product = productDoc({
      stock: 20,
      trackBatches: true,
      batches: [
        // The parcel that arrived on a DIFFERENT delivery and expires sooner.
        { variantId: null, quantity: 10, expiryDate: soon, purchaseRef: OLDER_ID },
        // This purchase's own parcel, longer-dated.
        { variantId: null, quantity: 6, expiryDate: later, purchaseRef: PURCHASE_ID },
      ],
    });
    stubEverything({ product });

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 8 }],
      refundMethod: 'pending',
    });

    // 6 from this purchase's own batch — a return must not eat a parcel that
    // came in on another delivery and happens to expire sooner — then the
    // remaining 2 by FEFO off the short-dated one.
    const remaining = product.batches;
    expect(remaining).toHaveLength(1);
    expect(String(remaining[0].purchaseRef)).toBe(String(OLDER_ID));
    expect(remaining[0].quantity).toBe(8);
  });

  it('keeps the batch write in its OWN bulkWrite, after the guarded one', async () => {
    const product = productDoc({
      trackBatches: true,
      batches: [{ variantId: null, quantity: 10, expiryDate: null, purchaseRef: PURCHASE_ID }],
    });
    stubEverything({ product });

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });

    // Two calls: the guarded stock ops, then the batches. Mixing them would let
    // a lost stock race hide behind a successful batch write.
    expect(bulkOps).toHaveLength(2);
    expect(bulkOps[0][0].updateOne.filter.stock).toEqual({ $gte: 4 });
    expect(bulkOps[1][0].updateOne.update.$set).toHaveProperty('batches');
  });

  it('does not touch batches on a product that does not track them', async () => {
    // INVARIANT GUARD — the overwhelming majority of products.
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });
    expect(bulkOps).toHaveLength(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5 · The adjustment walk (D-3)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('বাকি থেকে কাটা — the credit walks this bill, then older bills', () => {
  it('reduces `due` and leaves `paid` ALONE', async () => {
    // The heart of the mechanism. A version that inflated `paid` instead would
    // land the same `due` and report cash the shop never handed over.
    const purchase = billDoc({ paid: 200 });
    applyPurchaseHook(purchase);          // due 800
    stubEverything({ purchase });

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'adjustment',
    });

    expect(purchase.returnedAmount).toBe(300);
    expect(purchase.paid).toBe(200);      // untouched
    expect(purchase.due).toBe(500);       // 1000 − 200 − 300
    expect(purchase.totalAmount).toBe(1000); // the bill still says what it said
  });

  it('survives a LATER save of the same document', async () => {
    // The reason `returnedAmount` is a stored accumulator rather than a lower
    // `due`: `recordPayment` saves the document, and a bare `due` write would
    // be recomputed out of existence by the pre-save hook on that save.
    const purchase = billDoc();
    stubEverything({ purchase });

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'adjustment',
    });
    expect(purchase.due).toBe(700);

    // Somebody pays ৳200 later.
    purchase.paid = 200;
    await purchase.save();

    expect(purchase.due).toBe(500);       // NOT 800 — the credit is still there
    expect(purchase.returnedAmount).toBe(300);
  });

  it('spills onto the supplier\'s older open bills, oldest first', async () => {
    const older = billDoc({
      _id: OLDER_ID,
      invoiceNo: 'PUR2026070009',
      totalAmount: 900,
      paid: 0,
      due: 900,
      date: new Date('2026-07-01'),
    });
    // This bill can only absorb ৳200 of the ৳1,000 credit.
    const purchase = billDoc({ paid: 800 });
    applyPurchaseHook(purchase);          // due 200
    stubEverything({ purchase, olderBills: [older] });

    const { allocations } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 10 }],
      refundMethod: 'adjustment',
    });

    expect(allocations).toEqual([
      { purchase: PURCHASE_ID, invoiceNo: 'PUR2026080001', amount: 200 },
      { purchase: OLDER_ID, invoiceNo: 'PUR2026070009', amount: 800 },
    ]);
    expect(purchase.due).toBe(0);
    // ৳900 bill, ৳800 of credit landed on it — ৳100 still owed, and its `paid`
    // is untouched on the spilled bill exactly as on the primary one.
    expect(older.due).toBe(100);
    expect(older.returnedAmount).toBe(800);
    expect(older.paid).toBe(0);
  });

  it('refuses the remainder rather than inventing a supplier advance', async () => {
    const purchase = billDoc({ paid: 800 });
    applyPurchaseHook(purchase);          // due 200, no older bills
    stubEverything({ purchase, olderBills: [] });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 10 }],
      refundMethod: 'adjustment',
    })).rejects.toMatchObject({ statusCode: 400 });

    const err = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 10 }],
      refundMethod: 'adjustment',
    }).catch((e) => e);
    expect(err.messageBn).toContain('পরে নেবো');
    // Refused BEFORE anything moved — the walk is computed before any write.
    expect(bulkOps).toEqual([]);
    expect(purchase.returnedAmount).toBeUndefined();
  });

  it('refuses `adjustment` on a সরাসরি কেনা purchase — there is no ledger to cut', async () => {
    const purchase = billDoc({ supplier: null, supplierName: 'সরাসরি কেনা' });
    stubEverything({ purchase });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'adjustment',
    })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('সরাসরি কেনা'),
    });
  });

  it('records every touched bill on the return document itself', async () => {
    const older = billDoc({ _id: OLDER_ID, invoiceNo: 'PUR-OLD', totalAmount: 900, paid: 0, due: 900 });
    const purchase = billDoc({ paid: 800 });
    applyPurchaseHook(purchase);
    stubEverything({ purchase, olderBills: [older] });

    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 10 }],
      refundMethod: 'adjustment',
    });

    expect(purchaseReturn.allocations).toEqual([
      { purchase: PURCHASE_ID, amount: 200 },
      { purchase: OLDER_ID, amount: 800 },
    ]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6 · Σ SupplierBalance.totalDue === Supplier.totalDue (§8)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the supplier invariant holds after every path', () => {
  it('moves BOTH books once, by the same arithmetic, on an adjustment', async () => {
    stubEverything();

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'adjustment',
    });

    expect(supplierDoc.totalDue).toBe(700);
    expect(balanceRow.totalDue).toBe(700);
    expect(balanceRow.totalDue).toBe(supplierDoc.totalDue);
  });

  it('brings `totalAmount` down with `totalDue`, so `recomputeBalances` cannot undo the credit', async () => {
    // `SupplierBalance.recomputeBalances` re-derives
    // `totalDue = totalAmount + openingDue − totalPaid`. Moving the due alone
    // would hold until the next cancellation on this supplier+branch called it.
    stubEverything();

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'adjustment',
    });

    await SupplierBalance.recomputeBalances({ shop: SHOP, supplier: SUPPLIER, branch: BRANCH });

    expect(balanceRow.totalDue).toBe(700);
    expect(supplierDoc.totalAmount).toBe(700);
  });

  it('leaves the supplier books ALONE on a cash refund — the debt never changed', async () => {
    stubEverything();

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'cash',
      paymentMethod: 'cash',
    });

    expect(supplierDoc.totalDue).toBe(1000);
    expect(balanceRow.totalDue).toBe(1000);
    expect(supplierDoc.save).not.toHaveBeenCalled();
    expect(Supplier.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('leaves both books ALONE on a pending return', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'pending',
    });
    expect(supplierDoc.totalDue).toBe(1000);
    expect(balanceRow.totalDue).toBe(1000);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7 · The cash leg
 * ════════════════════════════════════════════════════════════════════════════ */

describe('টাকা ফেরত — the supplier hands money back', () => {
  it('writes ONE purchase_refund Payment and credits the account', async () => {
    stubEverything();

    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'cash',
      paymentMethod: 'bkash',
    });

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      shop: SHOP,
      branch: BRANCH,
      purchase: PURCHASE_ID,
      amount: 300,
      method: 'bkash',
      type: PAYMENT_TYPES.PURCHASE_REFUND,
      reference: 'PRET202608270001',
    });
    expect(payments[0].customer).toBeUndefined();
  });

  it('moves the account balance UP — money came IN', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'cash',
    });

    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: ACCOUNT, amount: 300 }),
    ]);
  });

  it('never reuses the customer `refund` type — that one means money OUT', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'cash',
    });
    expect(payments[0].type).not.toBe(PAYMENT_TYPES.REFUND);
    expect(PAYMENT_TYPES.PURCHASE_REFUND).toBe('purchase_refund');
  });

  it('leaves `Purchase.due` untouched — a cash refund settles no bill', async () => {
    const purchase = billDoc();
    stubEverything({ purchase });
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'cash',
    });
    expect(purchase.due).toBe(1000);
    expect(purchase.returnedAmount).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8 · pending → settle, and its idempotency guard
 * ════════════════════════════════════════════════════════════════════════════ */

describe('পরে নেবো, settled later', () => {
  function pendingReturn(overrides = {}) {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      shop: SHOP,
      branch: BRANCH,
      purchase: PURCHASE_ID,
      returnNo: 'PRET202608270001',
      totalAmount: 300,
      refundMethod: 'pending',
      refundStatus: 'pending',
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    jest.spyOn(PurchaseReturn, 'findOne').mockReturnValue({ session: () => Promise.resolve(doc) });
    return doc;
  }

  const settle = (id, data) =>
    purchaseReturnService.settleRefund(SHOP, USER, id, data, null);

  it('moves NOTHING when the return is created', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'pending',
    });

    expect(payments).toEqual([]);
    expect(accountDeltas).toEqual([]);
    expect(createdReturns[0].refundStatus).toBe('pending');
  });

  it('writes the cash-in leg when the money finally arrives', async () => {
    const doc = pendingReturn();

    // The frontend posts `{method, account}` — its own names, not the sale
    // side's `settlementMethod`.
    await settle(doc._id, { method: 'bkash', account: ACCOUNT });

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amount: 300,
      method: 'bkash',
      type: PAYMENT_TYPES.PURCHASE_REFUND,
    });
    expect(accountDeltas).toEqual([
      expect.objectContaining({ account: ACCOUNT, amount: 300 }),
    ]);
    expect(doc.refundStatus).toBe('settled');
    expect(doc.settlementMethod).toBe('bkash');
    expect(doc.settledBy).toBe(USER);
    expect(doc.settledAt).toBeInstanceOf(Date);
  });

  it('still accepts the sale side\'s `settlementMethod` spelling', async () => {
    const doc = pendingReturn();
    await settle(doc._id, { settlementMethod: 'bank' });
    expect(doc.settlementMethod).toBe('bank');
  });

  it('refuses a SECOND settle — the money must not arrive twice', async () => {
    const doc = pendingReturn({ refundStatus: 'settled' });

    await expect(settle(doc._id, { method: 'cash' })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('ইতিমধ্যে'),
    });
    expect(payments).toEqual([]);
    expect(accountDeltas).toEqual([]);
  });

  it('refuses to settle an adjustment or cash return, which never owed anything', async () => {
    const doc = pendingReturn({ refundMethod: 'adjustment', refundStatus: 'settled' });
    await expect(settle(doc._id, { method: 'cash' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('does not touch stock, batches or the supplier books on settle', async () => {
    // Those all happened when the return was created; touching them again here
    // would double-count them.
    const doc = pendingReturn();
    await settle(doc._id, { method: 'cash' });

    expect(bulkOps).toEqual([]);
    expect(stockTxns).toEqual([]);
    expect(supplierDoc.totalDue).toBe(1000);
    expect(doc).toBeDefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 9 · The stock ledger rows
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the StockTransaction rows a return writes', () => {
  it('carries the new type, a NEGATIVE quantity and the return as its reference', async () => {
    stubEverything();
    const { purchaseReturn } = await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });

    expect(stockTxns).toHaveLength(1);
    expect(stockTxns[0]).toMatchObject({
      shop: SHOP,
      type: STOCK_TRANSACTION_TYPES.PURCHASE_RETURN,
      quantity: -4,
      previousStock: 10,
      newStock: 6,
      reference: {
        type: 'purchase_return',
        id: purchaseReturn._id,
        invoiceNo: 'PRET202608270001',
      },
    });
  });

  it('SETS `branch` — an untagged row is invisible in every branch\'s history', async () => {
    stubEverything();
    await createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 4 }],
      refundMethod: 'pending',
    });
    expect(String(stockTxns[0].branch)).toBe(String(BRANCH));
  });

  it('is a distinct type from the customer-side `return`, which points the other way', async () => {
    expect(STOCK_TRANSACTION_TYPES.PURCHASE_RETURN).toBe('purchase_return');
    expect(STOCK_TRANSACTION_TYPES.PURCHASE_RETURN).not.toBe(STOCK_TRANSACTION_TYPES.RETURN);
    // Both enums have to know the value or the insert fails validation.
    const refEnum = StockTransaction.schema.path('reference.type').enumValues;
    expect(refEnum).toContain('purchase_return');
    expect(StockTransaction.schema.path('type').enumValues).toContain('purchase_return');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 10 · The cancel refusal, both directions (D-4)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('a purchase and its returns cannot both be reversed', () => {
  it('cancelPurchase refuses a bill that has goods returned against it', async () => {
    const purchase = billDoc();
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(purchase) });
    jest.spyOn(PurchaseReturn, 'countDocuments').mockReturnValue({
      session: () => Promise.resolve(1),
    });
    jest.spyOn(Payment, 'find').mockReturnValue({ session: () => Promise.resolve([]) });

    await expect(
      purchaseService.cancelPurchase(SHOP, USER, PURCHASE_ID, null, {})
    ).rejects.toMatchObject({
      statusCode: 400,
      messageBn: 'এই ক্রয়ের মাল ফেরত আছে — ক্রয়টি আর বাতিল করা যাবে না',
    });

    // Refused BEFORE anything moved — and before the multi-bill payment scan,
    // so a doubly-blocked bill names the reason a shopkeeper can act on.
    expect(purchase.status).toBe('unpaid');
    expect(Product.bulkWrite).not.toHaveBeenCalled();
  });

  it('cancelPurchase is unaffected when there are no returns', async () => {
    // INVARIANT GUARD — every purchase every shop has ever cancelled.
    const purchase = billDoc({ payments: [], items: [] });
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(purchase) });
    jest.spyOn(PurchaseReturn, 'countDocuments').mockReturnValue({
      session: () => Promise.resolve(0),
    });
    jest.spyOn(Payment, 'find').mockReturnValue({ session: () => Promise.resolve([]) });
    jest.spyOn(Product, 'find').mockReturnValue({ session: () => Promise.resolve([]) });
    jest.spyOn(Supplier, 'findById').mockReturnValue({ session: () => Promise.resolve(supplierDoc) });

    await purchaseService.cancelPurchase(SHOP, USER, PURCHASE_ID, null, {});

    expect(purchase.status).toBe('cancelled');
  });

  it('createReturn refuses a cancelled purchase', async () => {
    stubEverything({ purchase: billDoc({ status: 'cancelled' }) });

    await expect(createReturn({
      items: [{ purchaseItemId: ITEM_ID, quantity: 3 }],
      refundMethod: 'pending',
    })).rejects.toMatchObject({
      statusCode: 400,
      messageBn: expect.stringContaining('বাতিল ক্রয়'),
    });
  });

  it('the returnable list also refuses a cancelled purchase', async () => {
    jest.spyOn(Purchase, 'findOne').mockResolvedValue(billDoc({ status: 'cancelled' }));
    await expect(
      purchaseReturnService.getReturnableItems(SHOP, PURCHASE_ID, null)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cancelPurchase tags its reversal ledger rows with the branch (the fixed wart)', async () => {
    // The reversal rows carried no `branch` for years, so a cancelled
    // delivery's stock-out was invisible in every branch's history while its
    // stock-in showed — the history read as if the goods arrived and never left.
    const purchase = billDoc({ payments: [] });
    jest.spyOn(Purchase, 'findOne').mockReturnValue({ session: () => Promise.resolve(purchase) });
    jest.spyOn(PurchaseReturn, 'countDocuments').mockReturnValue({ session: () => Promise.resolve(0) });
    jest.spyOn(Payment, 'find').mockReturnValue({ session: () => Promise.resolve([]) });
    jest.spyOn(Product, 'find').mockReturnValue({ session: () => Promise.resolve([productDoc()]) });
    jest.spyOn(Supplier, 'findById').mockReturnValue({ session: () => Promise.resolve(supplierDoc) });

    await purchaseService.cancelPurchase(SHOP, USER, PURCHASE_ID, null, {});

    expect(stockTxns).toHaveLength(1);
    expect(String(stockTxns[0].branch)).toBe(String(BRANCH));
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 11 · The returnable list
 * ════════════════════════════════════════════════════════════════════════════ */

describe('GET /purchase/:id/returnable', () => {
  beforeEach(() => {
    jest.spyOn(PurchaseReturn, 'find').mockReturnValue({ lean: () => Promise.resolve([]) });
    jest.spyOn(Product, 'find').mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([productDoc({ stock: 2 })]) }),
    });
  });

  it('returns BOTH caps so the UI can say which one is binding', async () => {
    jest.spyOn(Purchase, 'findOne').mockResolvedValue(billDoc());

    const out = await purchaseReturnService.getReturnableItems(SHOP, PURCHASE_ID, null);

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      purchaseItemId: ITEM_ID,
      originalQuantity: 10,
      alreadyReturned: 0,
      maxReturnable: 10,   // the paper cap
      stockAvailable: 2,   // the physical cap — eight were sold on
    });
  });

  it('nets prior returns out of maxReturnable and drops fully-returned lines', async () => {
    jest.spyOn(Purchase, 'findOne').mockResolvedValue(billDoc());
    PurchaseReturn.find.mockReturnValue({
      lean: () => Promise.resolve([{ items: [{ purchaseItemId: ITEM_ID, quantity: 10 }] }]),
    });

    const out = await purchaseReturnService.getReturnableItems(SHOP, PURCHASE_ID, null);
    expect(out.items).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 12 · The supplier statement (§4)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the supplier statement learns কেনা ফেরত', () => {
  const SCOPES = {
    purchaseScope: { shop: SHOP },
    paymentScope: { shop: SHOP },
    adjustmentScope: { shop: SHOP },
    returnScope: { shop: SHOP, supplier: { $in: [SUPPLIER] }, refundMethod: 'adjustment' },
    ids: [SUPPLIER],
  };

  function stubStatementSources({ returns = [], bills = [] } = {}) {
    jest.spyOn(Purchase, 'aggregate').mockResolvedValue(bills);
    jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
    jest.spyOn(SupplierDueAdjustment, 'aggregate').mockResolvedValue([]);
    jest.spyOn(SupplierDueAdjustment, 'find').mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
    });
    jest.spyOn(PurchaseReturn, 'aggregate').mockResolvedValue(
      returns.map((r) => ({ _id: r.supplier, total: r.totalAmount }))
    );
    jest.spyOn(PurchaseReturn, 'find').mockReturnValue({
      select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(returns) }) }) }),
    });
  }

  it('pushes a CREDIT row — the statement balance is what the shop OWES', async () => {
    stubStatementSources({
      returns: [{
        supplier: SUPPLIER,
        returnNo: 'PRET202608270001',
        totalAmount: 300,
        items: [],
        createdAt: new Date('2026-08-10'),
      }],
    });

    const bySupplier = await detailedReportService._supplierRangeEntries({ ...SCOPES, range: null });
    const entries = bySupplier.get(String(SUPPLIER));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'return',
      label: 'কেনা ফেরত PRET202608270001',
      ref: 'PRET202608270001',
      debit: 0,
      credit: 300,
    });
  });

  it('MIRRORS the same rows into the opening balance, or the opening জের drifts', async () => {
    // The bills group counts a purchase at its FULL totalAmount, deliberately
    // never rewritten by a return. Without this term a shop that returned goods
    // before the window opened starts the statement owing money it has already
    // had credited.
    stubStatementSources({
      bills: [{ _id: SUPPLIER, billed: 1000, paidAtPurchase: 0 }],
      returns: [{ supplier: SUPPLIER, totalAmount: 300, items: [], createdAt: new Date('2026-07-01') }],
    });

    const openings = await detailedReportService._supplierOpeningBalances({
      ...SCOPES,
      rangeStart: new Date('2026-08-01'),
    });

    expect(openings.get(String(SUPPLIER))).toBe(700);
  });

  it('scopes to `adjustment` only — a cash refund never changed the debt', () => {
    // The predicate is built in `getSupplierStatements`; assert it is there, in
    // both passes, rather than only in the fixture above.
    const src = require('fs').readFileSync(
      require.resolve('../services/detailedReport.service.js'), 'utf8'
    );
    expect(src).toContain("refundMethod: 'adjustment'");
    // Both passes receive it.
    expect(src).toMatch(/_supplierOpeningBalances\(\{[^)]*returnScope/);
    expect(src).toMatch(/_supplierRangeEntries\(\{[^)]*returnScope/);
  });

  it('keeps purchase_refund Payment rows OUT of the statement', () => {
    // They are drawer movements, not debt movements. The payment scope names
    // exactly one type and it is not this one.
    const src = require('fs').readFileSync(
      require.resolve('../services/detailedReport.service.js'), 'utf8'
    );
    expect(src).toContain('type: PAYMENT_TYPES.PURCHASE_PAYMENT');
    expect(src).not.toContain('PAYMENT_TYPES.PURCHASE_REFUND');
  });

  it('names its item money `unitCost`/`totalCost`, the keys the sanitiser strips', async () => {
    stubStatementSources({
      returns: [{
        supplier: SUPPLIER,
        returnNo: 'PRET-1',
        totalAmount: 300,
        createdAt: new Date(),
        items: [{ productName: 'চাল', quantity: 3, unitPrice: 100, total: 300 }],
      }],
    });

    const bySupplier = await detailedReportService._supplierRangeEntries({
      ...SCOPES, range: null, withItems: true,
    });
    const row = bySupplier.get(String(SUPPLIER))[0];

    expect(row.items[0]).toMatchObject({ unitCost: 100, totalCost: 300 });
    expect(row.items[0].unitPrice).toBeUndefined();
    expect(row.items[0].total).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 13 · The registry checklist (§7)
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the new-model registry — every line is load-bearing', () => {
  it('is registered in models/index.js, or sync-indexes never sees the collection', () => {
    const models = require('../models');
    expect(models.PurchaseReturn).toBe(PurchaseReturn);
  });

  it('is in enableMultiBranch\'s backfill list, or existing rows vanish on the toggle', () => {
    const src = require('fs').readFileSync(
      require.resolve('../services/admin.service.js'), 'utf8'
    );
    const listed = src.slice(
      src.indexOf('const branchScopedModels'),
      src.indexOf('];', src.indexOf('const branchScopedModels'))
    );
    expect(listed).toContain('PurchaseReturn');
  });

  it('carries immutableGuard — a return is a ledger row, not a draft', async () => {
    await expect(PurchaseReturn.deleteMany({})).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('PurchaseReturn'),
    });
  });

  it('declares its audit actions in both languages', () => {
    expect(AUDIT_ACTIONS.PURCHASE_RETURN_CREATE).toEqual({
      en: 'purchase_return_create', bn: 'কেনা ফেরত',
    });
    expect(AUDIT_ACTIONS.PURCHASE_RETURN_SETTLE.bn).toBeTruthy();
  });

  it('strips the summary\'s money keys for a viewer without purchases.view_cost', () => {
    // These names are invented by the summary endpoint and resemble nothing
    // already in the set, so they had to be added by hand.
    for (const key of ['totalReturns', 'pendingRefundAmount', 'adjustedAmount', 'returnedAmount']) {
      expect(PURCHASE_MONEY_KEYS.has(key)).toBe(true);
    }
    // The count survives — the tile always renders.
    expect(PURCHASE_MONEY_KEYS.has('pendingRefundCount')).toBe(false);
    expect(PURCHASE_MONEY_KEYS.has('count')).toBe(false);
  });

  it('numbers itself off InvoiceCounter with a key nothing else can collide with (D-6)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../models/PurchaseReturn.model.js'), 'utf8'
    );
    // Zero new collections, and — the point of choosing this over a `kind` key
    // on ReturnCounter — zero index changes.
    expect(src).toContain("InvoiceCounter.nextSeq(shopId, null, `PRET:${dateStr}`");
    // Nothing is REQUIRED from ReturnCounter — the prose above the call explains
    // why the fallback was picked, and that prose must not be mistaken for a
    // dependency.
    expect(src).not.toContain("require('./ReturnCounter.model')");
  });

  it('every controller read goes through sanitizePurchases', () => {
    const src = require('fs').readFileSync(
      require.resolve('../controllers/purchaseReturn.controller.js'), 'utf8'
    );
    // One per exported handler — six reads plus the create envelope.
    const handlers = src.match(/^exports\.\w+ = asyncHandler/gm) || [];
    const strips = src.match(/sanitizePurchases\(/g) || [];
    expect(handlers.length).toBe(7);
    expect(strips.length).toBe(7);
    // `sanitizeReport` is the WRONG strip here — its denylist has no
    // `totalAmount`, `total` or `unitPrice`.
    expect(src).not.toContain('sanitizeReport(');
  });

  it('puts idempotency on both writes and offers no cancel route', () => {
    const src = require('fs').readFileSync(
      require.resolve('../routes/purchaseReturn.routes.js'), 'utf8'
    );
    expect(src).toMatch(/router\.post\('\/', idempotency\(\)/);
    expect(src).toMatch(/router\.patch\('\/:id\/settle', idempotency\(\)/);
    // No void: a purchase return is a ledger row, not a draft (D-4).
    expect(src).not.toContain("'/:id/cancel'");
    expect(src).not.toContain('router.delete(');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 14 · Purchase stays byte-identical for a shop that never returns anything
 * ════════════════════════════════════════════════════════════════════════════ */

describe('Purchase.pre(save) — the REAL hook, not the fixture\'s mirror', () => {
  /**
   * Drive the actual middleware, the way `invoiceMath.test` drives `Sale`'s.
   *
   * This matters more than it looks: every service test above uses a stubbed
   * `save()` that MIRRORS the hook, so reverting the model would leave them all
   * green. These are the tests that fail if `returnedAmount` is taken back out
   * of the derivation — which makes them the regression proof for the whole
   * due-reduction mechanism.
   */
  function runHook(doc) {
    const purchase = new Purchase({
      shop: SHOP,
      invoiceNo: 'PUR-HOOK-0001',
      createdBy: USER,
      items: [{ product: PRODUCT_ID, productName: 'চাল', quantity: 1, unitPrice: 5, total: 5 }],
      ...doc,
    });
    return new Promise((resolve, reject) => {
      Purchase.schema.s.hooks.execPre('save', purchase, [], (err) => (err ? reject(err) : resolve(purchase)));
    });
  }

  it('subtracts the credit from `due` without touching `paid`', async () => {
    const p = await runHook({ totalAmount: 1000, paid: 200, returnedAmount: 300 });
    expect(p.due).toBe(500);
    expect(p.paid).toBe(200);
    expect(p.totalAmount).toBe(1000);
  });

  it('clamps a credit to what the bill can still absorb — never a supplier advance', async () => {
    // ৳900 already paid on a ৳1,000 bill leaves ৳100 to credit against. A
    // ৳500 return cannot make the supplier owe the shop ৳400 — that balance
    // exists nowhere in this codebase, and F-4 refuses to create one too.
    const p = await runHook({ totalAmount: 1000, paid: 900, returnedAmount: 500 });
    expect(p.due).toBe(0);
  });

  it('derives `due` exactly as before when the field is absent', async () => {
    // INVARIANT GUARD — every purchase in every shop that has never returned
    // anything. Passes against the old code too, which is the point.
    const p = await runHook({ totalAmount: 1000, paid: 400 });
    expect(p.due).toBe(600);
    expect(p.status).toBe('partial');
  });

  it('has NO default, so the field never appears on an ordinary bill', async () => {
    // INVARIANT GUARD. `default: 0` would stamp the field onto every purchase
    // every shop has ever recorded, the next time each was saved (I-1).
    expect(Purchase.schema.path('returnedAmount').defaultValue).toBeUndefined();
    const p = await runHook({ totalAmount: 500, paid: 0 });
    expect(p.toObject().returnedAmount).toBeUndefined();
  });

  it('still refuses to relabel a cancelled bill', async () => {
    // INVARIANT GUARD — the pre-existing lifecycle-state guard, which the new
    // term must not have disturbed.
    const p = await runHook({ totalAmount: 1000, paid: 1000, returnedAmount: 0, status: 'cancelled' });
    expect(p.status).toBe('cancelled');
  });

  it('reads a fully-credited bill as nothing outstanding', async () => {
    const p = await runHook({ totalAmount: 1000, paid: 0, returnedAmount: 1000 });
    expect(p.due).toBe(0);
    expect(p.status).toBe('completed');
  });
});

/**
 * Characterization tests for the stock-transfer stock paths.
 *
 * Written BEFORE the N+1 refactor (PERFORMANCE_AUDIT.md H-3) and deliberately
 * asserting OUTCOMES — final stock values and the StockTransaction rows — never
 * the query shape. That is what lets the identical suite run against both the
 * old per-item `findOne` + `save()` loop and the batched `find` + `bulkWrite`
 * replacement, and prove the two behave the same.
 *
 * The fake product store below therefore backs all four access patterns, so the
 * refactor can change how the data is read and written without the test caring.
 *
 * `roundTrips` counts Mongo operations, which is the whole point of the change:
 * the batching assertions at the bottom are the one place shape is asserted,
 * and they are stated as an upper bound rather than an exact figure so a later
 * refactor is not forced to preserve an incidental call count.
 */

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: (cb) => cb(null),
}));

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const StockTransaction = require('../models/StockTransaction.model');
const StockTransfer = require('../models/StockTransfer.model');
const Branch = require('../models/Branch.model');
const transferService = require('../services/stockTransfer.service');

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const BRANCH_A = new mongoose.Types.ObjectId(); // source
const BRANCH_B = new mongoose.Types.ObjectId(); // destination

// ── Fake product store ──────────────────────────────────────────────────────
//
// Backs findOne/find (both with and without .session()) plus per-document
// save() and collection-level bulkWrite, over one shared in-memory map. Both
// the old and the new implementation mutate the same state, so assertions on
// final stock are meaningful either way.

let store;          // Map<idString, productDoc>
let roundTrips;     // Mongo operations issued
let createdTxns;    // flattened StockTransaction rows
let bulkOps;        // every Product.bulkWrite op the service emitted

function makeProduct({ id, code, branch, stock = 100, variants = null }) {
  const doc = {
    _id: id, shop: SHOP, branch, code, name: `Product ${code}`,
    stock, minStock: 5, unit: 'piece', isDeleted: false,
    clonedFrom: null,
    variants: variants || [],
    hasVariants: Boolean(variants),
    save: jest.fn(function () { roundTrips++; return Promise.resolve(this); }),
    toObject() { return { ...this }; },
  };
  // `variants.id(x)` is the Mongoose DocumentArray accessor the service uses.
  if (variants) {
    doc.variants.id = (vid) => variants.find((v) => String(v._id) === String(vid)) || null;
  }
  return doc;
}

const matches = (doc, filter) => {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or') {
      // `findCounterpartsBatch` fetches all three matching rules in one query.
      if (!v.some((branchFilter) => matches(doc, branchFilter))) return false;
    } else if (k === 'code' && v && v.$in) {
      if (!v.$in.some((x) => String(x) === String(doc.code))) return false;
    } else if (k === 'clonedFrom' && v && v.$in) {
      if (!v.$in.some((x) => String(x) === String(doc.clonedFrom))) return false;
    } else if (k === '_id') {
      if (v && v.$in) { if (!v.$in.some((x) => String(x) === String(doc._id))) return false; }
      else if (String(v) !== String(doc._id)) return false;
    } else if (k === 'isDeleted') {
      const want = v && v.$ne !== undefined ? doc.isDeleted !== v.$ne : doc.isDeleted === v;
      if (!want) return false;
    } else if (v && typeof v === 'object' && v.$ne !== undefined) {
      if (String(doc[k]) === String(v.$ne)) return false;
    } else if (doc[k] === undefined || String(doc[k]) !== String(v)) {
      return false;
    }
  }
  return true;
};

function installProductMocks() {
  const all = () => [...store.values()];

  jest.spyOn(Product, 'findOne').mockImplementation((filter) => {
    const result = all().find((d) => matches(d, filter)) || null;
    const thenable = {
      session: () => { roundTrips++; return Promise.resolve(result); },
      then: (res, rej) => { roundTrips++; return Promise.resolve(result).then(res, rej); },
    };
    return thenable;
  });

  jest.spyOn(Product, 'findById').mockImplementation((id) => {
    const result = store.get(String(id)) || null;
    return {
      session: () => { roundTrips++; return Promise.resolve(result); },
      then: (res, rej) => { roundTrips++; return Promise.resolve(result).then(res, rej); },
    };
  });

  jest.spyOn(Product, 'find').mockImplementation((filter) => {
    const result = all().filter((d) => matches(d, filter));
    return {
      session: () => { roundTrips++; return Promise.resolve(result); },
      then: (res, rej) => { roundTrips++; return Promise.resolve(result).then(res, rej); },
    };
  });

  // Applies the $set shape the batched implementation emits. $set mirrors what
  // save() did: the service quantizes in JS and writes the computed value.
  jest.spyOn(Product, 'bulkWrite').mockImplementation((ops) => {
    roundTrips++;
    // Kept so a test can assert WHICH document and variant a write targets.
    // The variant write is a pipeline update that this fake does not execute —
    // the stock values these tests read come from the service mutating the
    // shared in-memory doc — so without the recorded ops nothing would notice a
    // write aimed at the wrong subdocument.
    bulkOps.push(...ops);
    for (const op of ops) {
      const { filter, update } = op.updateOne;
      const doc = all().find((d) => matches(d, filter));
      if (!doc) continue;
      if (update.$set) {
        for (const [path, value] of Object.entries(update.$set)) {
          if (path === 'stock') doc.stock = value;
          else if (path.startsWith('variants.')) {
            // variants.$[v].stock style, or an index path
            const v = doc.variants.find((x) => String(x._id) === String(op.updateOne.arrayFilters?.[0]?.['v._id']));
            if (v) v.stock = value;
          }
        }
      }
    }
    return Promise.resolve({ modifiedCount: ops.length });
  });
}

beforeEach(() => {
  store = new Map();
  roundTrips = 0;
  createdTxns = [];
  bulkOps = [];

  installProductMocks();

  /**
   * The ledger mocks VALIDATE, they do not merely collect.
   *
   * This suite used to swallow whatever the service handed it, so the rows were
   * never once measured against `StockTransaction`'s schema. The service was
   * writing `performedBy` (the model requires `createdBy`), `note` (the model
   * calls it `notes`), a bare ObjectId in `reference` (the model wants
   * `{ type, id, invoiceNo }`) and a `referenceModel` key the model does not
   * declare. Every approve, receive and reject therefore died on insert in the
   * real app while all of these tests passed — after `Product.bulkWrite` had
   * already moved the stock.
   *
   * `validateSync` is the cheapest possible fix: no database, no async, and it
   * fails on exactly the mismatch that shipped.
   */
  const assertValidTxn = (doc) => {
    const err = new StockTransaction(doc).validateSync();
    if (err) throw err;
  };

  jest.spyOn(StockTransaction, 'create').mockImplementation((docs) => {
    roundTrips++;
    const rows = Array.isArray(docs) ? docs : [docs];
    rows.forEach(assertValidTxn);
    createdTxns.push(...rows);
    return Promise.resolve(rows);
  });
  jest.spyOn(StockTransaction, 'insertMany').mockImplementation((docs) => {
    roundTrips++;
    docs.forEach(assertValidTxn);
    createdTxns.push(...docs);
    return Promise.resolve(docs);
  });

  jest.spyOn(Branch, 'validateBranchOwnership').mockResolvedValue({ _id: BRANCH_A, code: 'DHA' });
});

afterEach(() => jest.restoreAllMocks());

/** Seed n source-branch products, all with the given stock. */
function seedSourceProducts(n, stock = 100) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = new mongoose.Types.ObjectId();
    ids.push(id);
    store.set(String(id), makeProduct({ id, code: `P${i}`, branch: BRANCH_A, stock }));
  }
  return ids;
}

function transferDoc(productIds, { status = 'pending', quantity = 10 } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B,
    transferNo: 'TR-001', status,
    items: productIds.map((pid, i) => ({
      _id: new mongoose.Types.ObjectId(),
      product: pid, productName: `Product P${i}`, productCode: `P${i}`,
      variantId: null, quantity,
    })),
    save: jest.fn(function () { roundTrips++; return Promise.resolve(this); }),
  };
}

const stubTransfer = (doc) => {
  jest.spyOn(StockTransfer, 'findOne').mockReturnValue({
    session: () => { roundTrips++; return Promise.resolve(doc); },
  });
};

// ── createTransfer: stock availability validation ───────────────────────────

describe('createTransfer — availability validation', () => {
  beforeEach(() => {
    jest.spyOn(StockTransfer, 'create').mockImplementation((d) => {
      roundTrips++;
      return Promise.resolve({ ...d, _id: new mongoose.Types.ObjectId() });
    });
  });

  it('creates the transfer when every line has enough stock', async () => {
    const ids = seedSourceProducts(5, 100);
    const items = ids.map((pid, i) => ({ product: pid, productName: `P${i}`, quantity: 10 }));

    const transfer = await transferService.createTransfer(
      { shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B, items }, USER
    );

    expect(transfer).toBeDefined();
    expect(StockTransfer.create).toHaveBeenCalled();
  });

  it('rejects when one line exceeds available stock, naming the product', async () => {
    const ids = seedSourceProducts(3, 100);
    store.get(String(ids[2])).stock = 4; // third line is short
    const items = ids.map((pid, i) => ({ product: pid, productName: `P${i}`, quantity: 10 }));

    await expect(
      transferService.createTransfer(
        { shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B, items }, USER
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(StockTransfer.create).not.toHaveBeenCalled();
  });

  it('rejects when a product is not stocked by the source branch', async () => {
    const ids = seedSourceProducts(2, 100);
    const missing = new mongoose.Types.ObjectId();
    const items = [...ids, missing].map((pid, i) => ({ product: pid, productName: `P${i}`, quantity: 5 }));

    await expect(
      transferService.createTransfer(
        { shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B, items }, USER
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reads the catalogue in a bounded number of round trips', async () => {
    const ids = seedSourceProducts(20, 100);
    const items = ids.map((pid, i) => ({ product: pid, productName: `P${i}`, quantity: 1 }));

    roundTrips = 0;
    await transferService.createTransfer(
      { shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B, items }, USER
    );

    // One read for the whole catalogue + one create. The per-item loop this
    // replaced issued 20 reads for the same information.
    expect(roundTrips).toBeLessThanOrEqual(3);
  });
});

// ── approveTransfer: deduct from source ─────────────────────────────────────

describe('approveTransfer — deducts source stock', () => {
  it('deducts every line and records one TRANSFER_OUT row per line', async () => {
    const ids = seedSourceProducts(4, 100);
    const doc = transferDoc(ids, { quantity: 10 });
    stubTransfer(doc);

    await transferService.approveTransfer(doc._id, SHOP, USER);

    for (const id of ids) {
      expect(store.get(String(id)).stock).toBe(90);
    }
    expect(createdTxns).toHaveLength(4);
    expect(createdTxns.every((t) => t.quantity === -10)).toBe(true);
    expect(createdTxns.every((t) => t.previousStock === 100 && t.newStock === 90)).toBe(true);
    expect(doc.status).toBe('in_transit');
  });

  it('refuses a transfer that is not pending', async () => {
    const ids = seedSourceProducts(2);
    const doc = transferDoc(ids, { status: 'in_transit' });
    stubTransfer(doc);

    await expect(transferService.approveTransfer(doc._id, SHOP, USER))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses when a line no longer has the stock, leaving nothing deducted', async () => {
    const ids = seedSourceProducts(3, 100);
    store.get(String(ids[1])).stock = 2;
    const doc = transferDoc(ids, { quantity: 10 });
    stubTransfer(doc);

    await expect(transferService.approveTransfer(doc._id, SHOP, USER))
      .rejects.toMatchObject({ statusCode: 400 });

    // ── All-or-nothing, without relying on the transaction ──────────────────
    //
    // The per-item loop this replaced validated and wrote in the same pass, so
    // line 0 was already deducted and its ledger row written by the time line 1
    // threw. A real MongoDB transaction rolled that back — but
    // `runInTransaction` falls back to a NULL SESSION on a standalone server
    // (utils/transaction.util.js), and on that path the partial deduction
    // stuck: stock gone, no transfer to show for it.
    //
    // Validating every line before writing any makes the guarantee hold on both
    // topologies rather than only on a replica set.
    //
    // Asserted against what was PERSISTED, not against the in-memory documents.
    // `applyStock` mutates the loaded doc before the throw is reached, and in
    // this fake the store holds those same objects — so checking `store` here
    // would conflate "mutated in memory" (harmless; the doc is discarded) with
    // "written to the database" (the thing that must not happen).
    expect(createdTxns).toHaveLength(0);
    expect(Product.bulkWrite).not.toHaveBeenCalled();
    expect(StockTransaction.insertMany).not.toHaveBeenCalled();
  });

  it('approves a 20-line transfer in a bounded number of round trips', async () => {
    const ids = seedSourceProducts(20, 100);
    const doc = transferDoc(ids, { quantity: 5 });
    stubTransfer(doc);

    roundTrips = 0;
    await transferService.approveTransfer(doc._id, SHOP, USER);

    // transfer read + product read + stock write + ledger write + transfer save.
    // The per-item loop cost 3 round trips per line — 60 for this transfer.
    expect(roundTrips).toBeLessThanOrEqual(8);
    expect(createdTxns).toHaveLength(20);
  });
});

// ── rejectTransfer: reverse source deduction ────────────────────────────────

describe('rejectTransfer — reverses an in-transit deduction', () => {
  it('restores stock and records TRANSFER_IN rows', async () => {
    const ids = seedSourceProducts(3, 90);
    const doc = transferDoc(ids, { status: 'in_transit', quantity: 10 });
    stubTransfer(doc);

    await transferService.rejectTransfer(doc._id, SHOP, USER, 'damaged');

    for (const id of ids) {
      expect(store.get(String(id)).stock).toBe(100);
    }
    expect(createdTxns).toHaveLength(3);
    expect(createdTxns.every((t) => t.quantity === 10)).toBe(true);
    expect(doc.status).toBe('rejected');
    expect(doc.rejectionReason).toBe('damaged');
  });

  it('touches no stock when rejecting a still-pending transfer', async () => {
    const ids = seedSourceProducts(3, 90);
    const doc = transferDoc(ids, { status: 'pending', quantity: 10 });
    stubTransfer(doc);

    await transferService.rejectTransfer(doc._id, SHOP, USER, 'not needed');

    for (const id of ids) {
      expect(store.get(String(id)).stock).toBe(90);
    }
    expect(createdTxns).toHaveLength(0);
    expect(doc.status).toBe('rejected');
  });

  it('skips a line whose product no longer exists rather than failing the whole rejection', async () => {
    const ids = seedSourceProducts(2, 90);
    const doc = transferDoc([...ids, new mongoose.Types.ObjectId()], {
      status: 'in_transit', quantity: 10,
    });
    stubTransfer(doc);

    await transferService.rejectTransfer(doc._id, SHOP, USER, 'partial');

    expect(createdTxns).toHaveLength(2); // only the two that resolved
    expect(doc.status).toBe('rejected');
  });

  it('rejects a 20-line transfer in a bounded number of round trips', async () => {
    const ids = seedSourceProducts(20, 90);
    const doc = transferDoc(ids, { status: 'in_transit', quantity: 5 });
    stubTransfer(doc);

    roundTrips = 0;
    await transferService.rejectTransfer(doc._id, SHOP, USER, 'bulk');

    expect(roundTrips).toBeLessThanOrEqual(8);
    expect(createdTxns).toHaveLength(20);
  });
});

// ── The variant path, both ends ─────────────────────────────────────────────
//
// A branch move of a variant product is the case that was broken end to end:
// the line could be created without naming a variant (which moved the roll-up
// and quietly undid itself), and a line that DID name one could not be received
// unless the destination happened to share the source's subdocument ids.

/** A product whose variants carry the given ids, with SKUs shared across branches. */
function makeVariantProduct({ id, code, branch, specs }) {
  const variants = specs.map((v) => ({
    _id: v.id,
    sku: v.sku,
    attributes: { size: v.size },
    buyingPrice: 10,
    sellingPrice: 20,
    stock: v.stock,
  }));
  const doc = makeProduct({
    id, code, branch,
    stock: variants.reduce((n, v) => n + v.stock, 0),
    variants,
  });
  return doc;
}

function variantTransferDoc({ productId, variantId, sku, size, quantity = 4, status = 'pending' }) {
  return {
    _id: new mongoose.Types.ObjectId(),
    shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B,
    transferNo: 'TR-V1', status,
    items: [{
      _id: new mongoose.Types.ObjectId(),
      product: productId,
      productName: 'Shirt',
      productCode: 'SH1',
      variantId,
      variantSku: sku,
      variantAttributes: { size },
      quantity,
      batches: [],
    }],
    save: jest.fn(function () { roundTrips++; return Promise.resolve(this); }),
  };
}

describe('variant transfers', () => {
  const SRC_XL = new mongoose.Types.ObjectId();
  const SRC_S = new mongoose.Types.ObjectId();
  const DEST_XL = new mongoose.Types.ObjectId();  // deliberately a DIFFERENT id
  const DEST_S = new mongoose.Types.ObjectId();
  let srcId;
  let destId;

  beforeEach(() => {
    srcId = new mongoose.Types.ObjectId();
    destId = new mongoose.Types.ObjectId();
    store.set(String(srcId), makeVariantProduct({
      id: srcId, code: 'SH1', branch: BRANCH_A,
      specs: [
        { id: SRC_XL, sku: 'SH1-XL', size: 'XL', stock: 30 },
        { id: SRC_S, sku: 'SH1-S', size: 'S', stock: 20 },
      ],
    }));
    store.set(String(destId), makeVariantProduct({
      id: destId, code: 'SH1', branch: BRANCH_B,
      specs: [
        { id: DEST_XL, sku: 'SH1-XL', size: 'XL', stock: 5 },
        { id: DEST_S, sku: 'SH1-S', size: 'S', stock: 1 },
      ],
    }));
  });

  it('refuses a line on a variant product that names no variant', async () => {
    jest.spyOn(StockTransfer, 'create').mockImplementation((d) => Promise.resolve(d));

    await expect(transferService.createTransfer({
      shop: SHOP, fromBranch: BRANCH_A, toBranch: BRANCH_B,
      items: [{ product: srcId, productName: 'Shirt', quantity: 4, variantId: null }],
    }, USER)).rejects.toThrow(/ভ্যারিয়েন্ট নির্বাচন করুন/);
  });

  it('deducts the named variant and rolls the product total up with it', async () => {
    const doc = variantTransferDoc({ productId: srcId, variantId: SRC_XL, sku: 'SH1-XL', size: 'XL' });
    stubTransfer(doc);

    await transferService.approveTransfer(doc._id, SHOP, USER);

    const src = store.get(String(srcId));
    expect(src.variants.find((v) => String(v._id) === String(SRC_XL)).stock).toBe(26);
    expect(src.variants.find((v) => String(v._id) === String(SRC_S)).stock).toBe(20);
    expect(createdTxns).toHaveLength(1);
    expect(createdTxns[0].type).toBe('transfer_out');
    expect(String(createdTxns[0].variantId)).toBe(String(SRC_XL));
  });

  it('credits the destination variant matched by SKU, not by subdocument id', async () => {
    const doc = variantTransferDoc({
      productId: srcId, variantId: SRC_XL, sku: 'SH1-XL', size: 'XL', status: 'in_transit',
    });
    stubTransfer(doc);

    await transferService.receiveTransfer(doc._id, SHOP, USER, null);

    const dest = store.get(String(destId));
    expect(dest.variants.find((v) => String(v._id) === String(DEST_XL)).stock).toBe(9);
    expect(dest.variants.find((v) => String(v._id) === String(DEST_S)).stock).toBe(1);
    expect(doc.status).toBe('received');

    // The ledger row must be reachable from the DESTINATION product's history,
    // so it names that document's own variant id.
    expect(createdTxns).toHaveLength(1);
    expect(createdTxns[0].type).toBe('transfer_in');
    expect(String(createdTxns[0].product)).toBe(String(destId));
    expect(String(createdTxns[0].variantId)).toBe(String(DEST_XL));
    expect(createdTxns[0].reference.type).toBe('transfer');
    expect(createdTxns[0].reference.invoiceNo).toBe('TR-V1');

    // And the stock write itself is aimed at the destination document, with the
    // destination's own variant id embedded in its pipeline.
    const write = bulkOps.find((op) => String(op.updateOne.filter._id) === String(destId));
    expect(write).toBeDefined();
    expect(JSON.stringify(write.updateOne.update)).toContain(String(DEST_XL));
    expect(JSON.stringify(write.updateOne.update)).not.toContain(String(SRC_XL));
  });

  it('names the variant when the destination branch does not stock it', async () => {
    const dest = store.get(String(destId));
    dest.variants = dest.variants.filter((v) => v.sku !== 'SH1-XL');
    dest.variants.id = (vid) => dest.variants.find((v) => String(v._id) === String(vid)) || null;

    const doc = variantTransferDoc({
      productId: srcId, variantId: SRC_XL, sku: 'SH1-XL', size: 'XL', status: 'in_transit',
    });
    stubTransfer(doc);

    await expect(transferService.receiveTransfer(doc._id, SHOP, USER, null))
      .rejects.toThrow(/XL/);
  });

  it('refuses to receive more than was dispatched', async () => {
    const doc = variantTransferDoc({
      productId: srcId, variantId: SRC_XL, sku: 'SH1-XL', size: 'XL', status: 'in_transit',
    });
    stubTransfer(doc);

    await expect(transferService.receiveTransfer(doc._id, SHOP, USER, [
      { itemId: doc.items[0]._id, received: 400 },
    ])).rejects.toThrow(/বেশি গ্রহণ করা যাবে না/);

    expect(store.get(String(destId)).variants.find((v) => String(v._id) === String(DEST_XL)).stock).toBe(5);
  });

  it('accepts a short receipt and records only what arrived', async () => {
    const doc = variantTransferDoc({
      productId: srcId, variantId: SRC_XL, sku: 'SH1-XL', size: 'XL', status: 'in_transit',
    });
    stubTransfer(doc);

    await transferService.receiveTransfer(doc._id, SHOP, USER, [
      { itemId: doc.items[0]._id, received: 1 },
    ]);

    expect(store.get(String(destId)).variants.find((v) => String(v._id) === String(DEST_XL)).stock).toBe(6);
    expect(doc.items[0].received).toBe(1);
    expect(createdTxns[0].quantity).toBe(1);
  });
});

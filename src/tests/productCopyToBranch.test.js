/**
 * অন্য শাখায় কপি (`productService.copyProductsToBranch`) and the admin
 * new-branch clone — both go through `branchClone.util` now.
 *
 * Models are faked over one in-memory store; assertions are on what lands in
 * the destination branch and on the photo refCounts the copies take.
 */

jest.mock('../services/media.service', () => ({
  reconcileRefs: jest.fn(() => Promise.resolve({ attached: [], detached: [] })),
  mediaIdsOfProduct: (p) => [
    ...(p?.catalogImages || []).map((i) => i?.mediaId),
    ...(p?.variants || []).map((v) => v?.imageMediaId),
  ].filter(Boolean),
}));

const mongoose = require('mongoose');
const Product = require('../models/Product.model');
const Branch = require('../models/Branch.model');
const AuditLog = require('../models/AuditLog.model');
const mediaService = require('../services/media.service');
const cacheService = require('../services/cache.service');
const productService = require('../services/product.service');
const adminService = require('../services/admin.service');
const productRoutes = require('../routes/product.routes');
const { ownerOnly } = require('../middleware/permission.middleware');

const oid = () => new mongoose.Types.ObjectId();
const SHOP = oid();
const USER = oid();
const BRANCH_A = oid();
const BRANCH_B = oid();

let products;

function product({ code, branch, extra = {} }) {
  const doc = {
    _id: oid(), shop: SHOP, branch, code, name: `পণ্য ${code}`,
    stock: 40, minStock: 5, isDeleted: false, clonedFrom: null,
    buyingPrice: 10, sellingPrice: 15, variants: [],
    isAvailableOnline: true, isFeaturedOnline: true, totalSold: 9,
    ...extra,
  };
  products.set(String(doc._id), doc);
  return doc;
}

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (k === '$or') return v.some((f) => matches(doc, f));
  if (k === '_id' && v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId)) {
    if (v.$in && !v.$in.some((x) => String(x) === String(doc._id))) return false;
    if (v.$gt && !(String(doc._id) > String(v.$gt))) return false;
    return true;
  }
  if (v && typeof v === 'object' && v.$regex) return new RegExp(v.$regex, v.$options).test(doc[k] || '');
  if (v && typeof v === 'object' && v.$in) return v.$in.some((x) => String(x) === String(doc[k]));
  if (v && typeof v === 'object' && v.$ne !== undefined) return doc[k] !== v.$ne;
  return String(doc[k]) === String(v);
});

const query = (rows) => {
  let out = rows;
  const q = {
    sort: () => { out = [...out].sort((a, b) => String(a._id).localeCompare(String(b._id))); return q; },
    limit: (n) => { out = out.slice(0, n); return q; },
    select: () => q,
    session: () => Promise.resolve(out),
    lean: () => Promise.resolve(out),
    then: (res, rej) => Promise.resolve(out).then(res, rej),
  };
  return q;
};

const ownerReq = (multi = true) => ({
  shop: { _id: SHOP, multiBranchEnabled: multi },
  branchId: multi ? BRANCH_A : null,
  user: { _id: USER, isOwner: true },
});

const inBranch = (b) => [...products.values()].filter((p) => String(p.branch) === String(b));

beforeEach(() => {
  products = new Map();
  mediaService.reconcileRefs.mockClear();

  jest.spyOn(Product, 'find').mockImplementation((f) =>
    query([...products.values()].filter((d) => matches(d, f))));
  jest.spyOn(Product, 'insertMany').mockImplementation((docs) => Promise.resolve(docs.map((d) => {
    const doc = { ...d, _id: oid() };
    products.set(String(doc._id), doc);
    return doc;
  })));
  jest.spyOn(Branch, 'validateBranchOwnership').mockImplementation((id) => Promise.resolve({ _id: id }));
  jest.spyOn(AuditLog, 'create').mockResolvedValue({});
  jest.spyOn(cacheService, 'delete').mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

const copy = (payload, req = ownerReq()) =>
  productService.copyProductsToBranch(SHOP, USER, { toBranch: BRANCH_B, ...payload }, req);

describe('copyProductsToBranch', () => {
  it('copies only what the destination lacks, at zero stock, online off', async () => {
    const rice = product({ code: 'RICE', branch: BRANCH_A });
    product({ code: 'DAL', branch: BRANCH_A });
    const destDal = product({ code: 'DAL', branch: BRANCH_B, extra: { sellingPrice: 99 } });

    const out = await copy({});

    expect(out).toMatchObject({ toCopy: 1, copied: 1, alreadyThere: 1 });
    const riceCopy = inBranch(BRANCH_B).find((p) => p.code === 'RICE');
    expect(riceCopy).toMatchObject({
      stock: 0, totalSold: 0, isAvailableOnline: false, isFeaturedOnline: false, shop: SHOP,
    });
    expect(String(riceCopy.clonedFrom)).toBe(String(rice._id));
    // The existing copy keeps its own price — branches may differ.
    expect(destDal.sellingPrice).toBe(99);
  });

  it('a second run copies nothing', async () => {
    product({ code: 'RICE', branch: BRANCH_A });
    await copy({});
    const again = await copy({});
    expect(again).toMatchObject({ copied: 0, alreadyThere: 1 });
  });

  it('dryRun counts and writes nothing', async () => {
    product({ code: 'RICE', branch: BRANCH_A });
    const out = await copy({ dryRun: true });
    expect(out).toMatchObject({ toCopy: 1, copied: 0 });
    expect(Product.insertMany).not.toHaveBeenCalled();
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it('skips combos, and codes a deleted destination row still holds — by name', async () => {
    product({ code: 'THALI', branch: BRANCH_A, extra: { type: 'combo' } });
    product({ code: 'OLD', branch: BRANCH_A });
    product({ code: 'OLD', branch: BRANCH_B, extra: { isDeleted: true } });

    const out = await copy({});

    expect(out).toMatchObject({ copied: 0, combos: 1, conflicts: 1, conflictNames: ['পণ্য OLD'] });
    expect(Product.insertMany).not.toHaveBeenCalled();
  });

  it('limits to one category when asked', async () => {
    const cat = oid();
    product({ code: 'RICE', branch: BRANCH_A, extra: { category: cat } });
    product({ code: 'SOAP', branch: BRANCH_A, extra: { category: oid() } });

    const out = await copy({ categoryId: cat });

    expect(out.copied).toBe(1);
    expect(inBranch(BRANCH_B).map((p) => p.code)).toEqual(['RICE']);
  });

  it('counts the copies\' photo references', async () => {
    const mediaId = oid();
    product({ code: 'RICE', branch: BRANCH_A, extra: { catalogImages: [{ url: 'x', mediaId }] } });
    await copy({});
    expect(mediaService.reconcileRefs).toHaveBeenCalledWith(SHOP, [], [mediaId]);
  });

  it('refuses a single-branch shop and a copy onto itself', async () => {
    await expect(copy({}, ownerReq(false))).rejects.toMatchObject({ statusCode: 400 });
    await expect(copy({ toBranch: BRANCH_A })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('the route is owner-only', () => {
    const layer = productRoutes.stack.find((l) => l.route?.path === '/copy-to-branch');
    expect(layer.route.methods.post).toBe(true);
    expect(layer.route.stack.map((s) => s.handle)).toContain(ownerOnly);
  });
});

describe('admin cloneBranchProducts', () => {
  it('counts the photo references its copies hold', async () => {
    const mediaId = oid();
    product({ code: 'RICE', branch: BRANCH_A, extra: { catalogImages: [{ url: 'x', mediaId }] } });
    jest.spyOn(Branch, 'findOne').mockResolvedValue({ _id: BRANCH_A });

    const copied = await adminService.cloneBranchProducts(SHOP, BRANCH_A, BRANCH_B);

    expect(copied).toBe(1);
    expect(mediaService.reconcileRefs).toHaveBeenCalledWith(SHOP, [], [mediaId]);
    // A whole new branch still mirrors the old one online.
    expect(inBranch(BRANCH_B)[0]).toMatchObject({ isAvailableOnline: true, stock: 0 });
  });
});

describe('copyProductsToBranch — same name, different code', () => {
  const twins = () => {
    const src = product({ code: 'MED0127', branch: BRANCH_A, extra: { name: 'ইষ্ট ৫০০ গ্রাম' } });
    const dest = product({ code: 'MTS2297', branch: BRANCH_B, extra: { name: 'ইষ্ট ৫০০ গ্রাম' } });
    return { src, dest };
  };

  beforeEach(() => {
    jest.spyOn(Product, 'bulkWrite').mockImplementation((ops) => {
      for (const { updateOne } of ops) {
        const doc = products.get(String(updateOne.filter._id));
        if (doc) doc.clonedFrom = updateOne.update.$set.clonedFrom;
      }
      return Promise.resolve({ matchedCount: ops.length });
    });
  });

  it('never copies a second one — it is counted as same-name', async () => {
    twins();
    const out = await copy({});
    expect(out).toMatchObject({ copied: 0, sameName: 1, linked: 0 });
    expect(out.sameNameExamples[0]).toMatchObject({ code: 'MED0127', otherCode: 'MTS2297' });
    expect(inBranch(BRANCH_B)).toHaveLength(1);
  });

  it('linkSameName links them, so transfers match from now on', async () => {
    const { src, dest } = twins();
    const out = await copy({ linkSameName: true });
    expect(out).toMatchObject({ copied: 0, linked: 1 });
    expect(String(dest.clonedFrom)).toBe(String(src._id));
    expect(dest.code).toBe('MTS2297'); // nothing the shopkeeper sees changes
  });

  it('dryRun links nothing', async () => {
    const { dest } = twins();
    await copy({ linkSameName: true, dryRun: true });
    expect(dest.clonedFrom).toBeNull();
  });
});

describe('getCopyCandidates — the picker', () => {
  const pick = (query = {}, r = ownerReq()) =>
    productService.getCopyCandidates(SHOP, { toBranch: BRANCH_B, ...query }, r);

  it('labels every row with what a copy would do to it', async () => {
    product({ code: 'RICE', branch: BRANCH_A });
    product({ code: 'DAL', branch: BRANCH_A });
    product({ code: 'DAL', branch: BRANCH_B });
    product({ code: 'MED0127', branch: BRANCH_A, extra: { name: 'ইষ্ট ৫০০ গ্রাম' } });
    product({ code: 'MTS2297', branch: BRANCH_B, extra: { name: 'ইষ্ট ৫০০ গ্রাম', unit: 'pack' } });
    product({ code: 'THALI', branch: BRANCH_A, extra: { type: 'combo' } });
    product({ code: 'OLD', branch: BRANCH_A });
    product({ code: 'OLD', branch: BRANCH_B, extra: { isDeleted: true } });

    const { items, truncated } = await pick();
    const by = Object.fromEntries(items.map((i) => [i.code, i]));

    expect(truncated).toBe(false);
    expect(by.RICE.status).toBe('missing');
    expect(by.DAL).toMatchObject({ status: 'exists', otherCode: 'DAL' });
    expect(by.MED0127).toMatchObject({ status: 'sameName', otherCode: 'MTS2297', otherUnit: 'pack' });
    expect(by.THALI.status).toBe('combo');
    expect(by.OLD.status).toBe('conflict');
    // Only this branch's products are offered.
    expect(items.every((i) => !['MTS2297'].includes(i.code))).toBe(true);
  });

  it('searches by name or code', async () => {
    product({ code: 'RICE', branch: BRANCH_A, extra: { name: 'চাল মিনিকেট' } });
    product({ code: 'SOAP', branch: BRANCH_A, extra: { name: 'সাবান' } });

    expect((await pick({ search: 'মিনি' })).items.map((i) => i.code)).toEqual(['RICE']);
    expect((await pick({ search: 'soap' })).items.map((i) => i.code)).toEqual(['SOAP']);
  });

  it('copying the ticked ids does exactly what the labels said', async () => {
    const rice = product({ code: 'RICE', branch: BRANCH_A });
    product({ code: 'SOAP', branch: BRANCH_A });
    const yeast = product({ code: 'MED0127', branch: BRANCH_A, extra: { name: 'ইষ্ট ৫০০ গ্রাম' } });
    const destYeast = product({ code: 'MTS2297', branch: BRANCH_B, extra: { name: 'ইষ্ট ৫০০ গ্রাম' } });
    jest.spyOn(Product, 'bulkWrite').mockImplementation((ops) => {
      for (const { updateOne } of ops) products.get(String(updateOne.filter._id)).clonedFrom = updateOne.update.$set.clonedFrom;
      return Promise.resolve({ matchedCount: ops.length });
    });

    const out = await copy({ productIds: [rice._id, yeast._id], linkSameName: true });

    expect(out).toMatchObject({ copied: 1, linked: 1 });
    expect(inBranch(BRANCH_B).map((p) => p.code).sort()).toEqual(['MTS2297', 'RICE']); // SOAP not ticked
    expect(String(destYeast.clonedFrom)).toBe(String(yeast._id));
  });

  it('the picker route is owner-only too', () => {
    const layer = productRoutes.stack.find((l) => l.route?.path === '/copy-to-branch/candidates');
    expect(layer.route.methods.get).toBe(true);
    expect(layer.route.stack.map((s) => s.handle)).toContain(ownerOnly);
  });
});

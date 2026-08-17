/**
 * Category onboarding — the contract behind "a new shop should not meet a wall".
 *
 * Registration used to pre-create the whole shop-type taxonomy (85 rows for a
 * grocery, 63 for a cloth shop) and the product form required one of them. Both
 * halves changed, and the pieces that replaced them all have a way of going
 * quietly wrong:
 *
 *   · find-or-create that is not case-insensitive silently mints "Shirt" beside
 *     "shirt", which the unique index then rejects at the worst moment;
 *   · a soft-deleted category still occupies its slot in that index, so
 *     re-adding a deleted name is a raw E11000 unless something revives it;
 *   · deleting a parent used to be allowed while its SUBCATEGORY held stock;
 *   · the suggestion template reads `shop.type`, and the registration payload
 *     calls the same thing `shopType` — reading the wrong one hands every shop
 *     the generic list while looking like it worked.
 *
 * Each of those is pinned below.
 */

const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Product = require('../models/Product.model');
const ShopCategory = require('../models/ShopCategory.model');
const mediaService = require('../services/media.service');
const cacheService = require('../services/cache.service');
const categoryService = require('../services/category.service');

const SHOP = new mongoose.Types.ObjectId();
const PARENT = new mongoose.Types.ObjectId();

/** A category row as `_findByName` returns it — a document, so `.save()` works. */
const doc = (fields) => ({
  _id: new mongoose.Types.ObjectId(),
  shop: SHOP,
  isActive: true,
  parent: null,
  imageMediaId: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...fields,
});

beforeEach(() => {
  // Neither of these is the subject of any test here, and both reach outside.
  jest.spyOn(mediaService, 'reconcileRefs').mockResolvedValue({ attached: [], detached: [] });
  jest.spyOn(cacheService, 'delete').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

const mockFindByName = (result) =>
  jest.spyOn(categoryService, '_findByName').mockResolvedValue(result);

describe('_findByName — the duplicate check itself', () => {
  it('matches case-insensitively and anchors the whole name', async () => {
    const spy = jest.spyOn(Category, 'findOne').mockResolvedValue(null);
    await categoryService._findByName(SHOP, '  Shirt  ');

    const query = spy.mock.calls[0][0];
    expect(query.shop).toBe(SHOP);
    expect(query.name.$options).toBe('i');
    // Trimmed, and anchored at both ends so "shirt" does not match "t-shirt".
    expect(query.name.$regex).toBe('^Shirt$');
  });

  it('escapes regex metacharacters in a shopkeeper-typed name', async () => {
    const spy = jest.spyOn(Category, 'findOne').mockResolvedValue(null);
    // Free text. Unescaped, this is an unbalanced group and throws.
    await expect(categoryService._findByName(SHOP, 'শার্ট (৪০%)')).resolves.toBeNull();
    expect(spy.mock.calls[0][0].name.$regex).toBe('^শার্ট \\(৪০%\\)$');
  });

  it('does NOT filter on isActive — a soft-deleted row still holds the index slot', async () => {
    const spy = jest.spyOn(Category, 'findOne').mockResolvedValue(null);
    await categoryService._findByName(SHOP, 'মশলা');
    expect(spy.mock.calls[0][0]).not.toHaveProperty('isActive');
  });
});

describe('createCategory — idempotent on name', () => {
  it('creates when nothing matches, and reports created: true', async () => {
    mockFindByName(null);
    const created = doc({ name: 'মশলা' });
    jest.spyOn(Category, 'create').mockResolvedValue(created);

    await expect(categoryService.createCategory(SHOP, { name: 'মশলা' }))
      .resolves.toEqual({ category: created, created: true });
  });

  it('trims the name before storing it', async () => {
    mockFindByName(null);
    const spy = jest.spyOn(Category, 'create').mockResolvedValue(doc({ name: 'মশলা' }));

    await categoryService.createCategory(SHOP, { name: '  মশলা  ' });
    expect(spy.mock.calls[0][0].name).toBe('মশলা');
  });

  it('refuses an empty or whitespace-only name', async () => {
    for (const empty of ['', '   ', null, undefined]) {
      await expect(categoryService.createCategory(SHOP, { name: empty }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('hands back the existing row instead of duplicating it', async () => {
    const existing = doc({ name: 'মশলা' });
    mockFindByName(existing);
    const create = jest.spyOn(Category, 'create').mockResolvedValue(doc({}));

    await expect(categoryService.createCategory(SHOP, { name: 'মশলা' }))
      .resolves.toEqual({ category: existing, created: false });
    // The point: no second row. This is what makes a double-tap harmless.
    expect(create).not.toHaveBeenCalled();
  });

  it('409s when the name is live somewhere ELSE in the tree', async () => {
    // "শার্ট" already exists as a subcategory; someone asks for it at top level.
    mockFindByName(doc({ name: 'শার্ট', parent: PARENT }));

    await expect(categoryService.createCategory(SHOP, { name: 'শার্ট', parent: null }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('revives a soft-deleted category rather than raising E11000', async () => {
    const buried = doc({ name: 'মশলা', isActive: false });
    mockFindByName(buried);
    const create = jest.spyOn(Category, 'create');

    const result = await categoryService.createCategory(SHOP, { name: 'মশলা' });

    expect(create).not.toHaveBeenCalled();
    expect(buried.isActive).toBe(true);
    expect(buried.save).toHaveBeenCalled();
    // Reported as created: from the shopkeeper's side a category that was gone
    // is now there, which is the thing the message has to describe.
    expect(result.created).toBe(true);
  });

  it('re-attaches the revived category\'s photo reference', async () => {
    const mediaId = new mongoose.Types.ObjectId();
    mockFindByName(doc({ name: 'মশলা', isActive: false, imageMediaId: mediaId }));

    await categoryService.createCategory(SHOP, { name: 'মশলা' });

    // deleteCategory released it; without this the image stays on the
    // reclamation clock while a live category points at it.
    expect(mediaService.reconcileRefs).toHaveBeenCalledWith(SHOP, [], [mediaId]);
  });

  it('re-reads the winner when a concurrent request wins the unique index', async () => {
    const winner = doc({ name: 'মশলা' });
    // Nothing on the first look; the row exists by the time create runs.
    jest.spyOn(categoryService, '_findByName')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    jest.spyOn(Category, 'create').mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    await expect(categoryService.createCategory(SHOP, { name: 'মশলা' }))
      .resolves.toEqual({ category: winner, created: false });
  });

  it('rethrows a create failure that is not a duplicate', async () => {
    mockFindByName(null);
    jest.spyOn(Category, 'create').mockRejectedValue(new Error('connection lost'));

    await expect(categoryService.createCategory(SHOP, { name: 'মশলা' }))
      .rejects.toThrow('connection lost');
  });
});

describe('findOrCreateByName — the looser sibling, for the product form and import', () => {
  it('takes an existing category WHEREVER it lives, without a 409', async () => {
    // The case that separates it from createCategory: the shopkeeper typed
    // "শার্ট" into the category box while it exists one level down.
    const elsewhere = doc({ name: 'শার্ট', parent: PARENT });
    mockFindByName(elsewhere);

    await expect(categoryService.findOrCreateByName(SHOP, 'শার্ট', { parent: null }))
      .resolves.toEqual({ category: elsewhere, created: false });
  });

  it('creates under the requested parent when nothing matches', async () => {
    mockFindByName(null);
    const spy = jest.spyOn(Category, 'create').mockResolvedValue(doc({ name: 'ফুল হাতা' }));

    await categoryService.findOrCreateByName(SHOP, 'ফুল হাতা', { parent: PARENT });
    expect(spy.mock.calls[0][0]).toMatchObject({ name: 'ফুল হাতা', parent: PARENT });
  });

  it('refuses a blank name', async () => {
    await expect(categoryService.findOrCreateByName(SHOP, '   '))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('deleteCategory — the subtree guard', () => {
  const mockTarget = (subcategories) => {
    jest.spyOn(Category, 'findOne').mockResolvedValue(doc({ name: 'পুরুষ পোশাক' }));
    jest.spyOn(Category, 'find').mockReturnValue({
      select: () => ({ lean: async () => subcategories }),
    });
    jest.spyOn(Category, 'updateMany').mockResolvedValue({});
  };

  it('counts the WHOLE subtree, not just the category itself', async () => {
    const subId = new mongoose.Types.ObjectId();
    mockTarget([{ _id: subId, imageMediaId: null }]);
    const count = jest.spyOn(Product, 'countDocuments').mockResolvedValue(0);

    await categoryService.deleteCategory(SHOP, PARENT);

    // The regression this exists for: a parent with no products of its own was
    // deletable while its subcategory held hundreds, and the cascade below then
    // deactivated that subcategory — leaving those products filed under a
    // category no screen would ever show again.
    const query = count.mock.calls[0][0];
    expect(query.$or[0].category.$in.map(String)).toContain(String(subId));
    expect(query.$or[1].subcategory.$in.map(String)).toContain(String(subId));
  });

  it('counts products that are merely switched off, not just active ones', async () => {
    mockTarget([]);
    const count = jest.spyOn(Product, 'countDocuments').mockResolvedValue(0);

    await categoryService.deleteCategory(SHOP, PARENT);

    // An inactive product is still the shop's product with real stock behind
    // it; it must not lose its category while it is switched off.
    expect(count.mock.calls[0][0]).toMatchObject({ isDeleted: { $ne: true } });
    expect(count.mock.calls[0][0]).not.toHaveProperty('isActive');
  });

  it('refuses, naming the count, when the subtree holds anything', async () => {
    mockTarget([{ _id: new mongoose.Types.ObjectId(), imageMediaId: null }]);
    jest.spyOn(Product, 'countDocuments').mockResolvedValue(40);

    await expect(categoryService.deleteCategory(SHOP, PARENT))
      .rejects.toMatchObject({ statusCode: 400, messageBn: expect.stringContaining('40') });
  });
});

describe('getSuggestions — the opt-in template', () => {
  const template = [
    { name: 'পুরুষ পোশাক', icon: 'shirt', order: 1, subcategories: [{ name: 'শার্ট', order: 1 }] },
    { name: 'মহিলা পোশাক', order: 2, subcategories: [] },
  ];

  const mockOwned = (names) =>
    jest.spyOn(Category, 'find').mockReturnValue({
      select: () => ({ lean: async () => names.map((name) => ({ name })) }),
    });

  it('reads shop.type, NOT shop.shopType', async () => {
    const spy = jest.spyOn(ShopCategory, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ defaultCategories: template }) }),
    });
    mockOwned([]);

    // `shopType` is what the REGISTRATION PAYLOAD calls it; the document field
    // is `type`. Reading the payload's name here yields undefined, falls
    // through to the 'other' template, and looks like it worked.
    await categoryService.getSuggestions({ _id: SHOP, type: 'cloth', shopType: 'grocery' });
    expect(spy.mock.calls[0][0]).toEqual({ key: 'cloth' });
  });

  it('flags rows the shop already has instead of hiding them', async () => {
    jest.spyOn(ShopCategory, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ defaultCategories: template }) }),
    });
    // Case-insensitively — the shop typed theirs by hand.
    mockOwned(['পুরুষ পোশাক']);

    const result = await categoryService.getSuggestions({ _id: SHOP, type: 'cloth' });
    expect(result.map((r) => [r.name, r.exists])).toEqual([
      ['পুরুষ পোশাক', true],
      ['মহিলা পোশাক', false],
    ]);
    // Re-runnable: the panel shows what is new, not a list that would no-op.
    expect(result[0].subcategories[0]).toMatchObject({ name: 'শার্ট', exists: false });
  });

  it('falls back to the static seeds when the DB template is empty', async () => {
    jest.spyOn(ShopCategory, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ defaultCategories: [] }) }),
    });
    mockOwned([]);

    const result = await categoryService.getSuggestions({ _id: SHOP, type: 'cloth' });
    // The same source `seeds/categorySeeder.js` used at registration — the two
    // must not fork now that only the timing changed.
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns an empty list for an unknown shop type rather than throwing', async () => {
    jest.spyOn(ShopCategory, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    mockOwned([]);

    await expect(categoryService.getSuggestions({ _id: SHOP, type: 'nonesuch' }))
      .resolves.toEqual([]);
  });
});

describe('applyTemplate — one collision must not lose the batch', () => {
  beforeEach(() => {
    jest.spyOn(categoryService, 'getSuggestions').mockResolvedValue([
      { name: 'মুদি', icon: null, order: 1, exists: false, subcategories: [{ name: 'চাল', order: 1 }] },
      { name: 'মসলা', icon: null, order: 2, exists: false, subcategories: [] },
    ]);
  });

  it('creates only what was ticked', async () => {
    const spy = jest.spyOn(categoryService, 'createCategory')
      .mockResolvedValue({ category: doc({}), created: true });

    const result = await categoryService.applyTemplate({ _id: SHOP, type: 'grocery' }, {
      names: ['মসলা'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ name: 'মসলা' });
    expect(result.categories).toBe(1);
  });

  it('leaves subcategories alone unless they were asked for', async () => {
    const spy = jest.spyOn(categoryService, 'createCategory')
      .mockResolvedValue({ category: doc({}), created: true });

    await categoryService.applyTemplate({ _id: SHOP }, { names: ['মুদি'] });

    // The default is parents only. This tick is what turns 8 rows into 64.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('creates subcategories under their parent when asked', async () => {
    const parent = doc({ name: 'মুদি' });
    const spy = jest.spyOn(categoryService, 'createCategory')
      .mockResolvedValueOnce({ category: parent, created: true })
      .mockResolvedValueOnce({ category: doc({ name: 'চাল' }), created: true });

    const result = await categoryService.applyTemplate({ _id: SHOP }, {
      names: ['মুদি'],
      includeSubcategories: true,
    });

    expect(spy.mock.calls[1][1]).toMatchObject({ name: 'চাল', parent: parent._id });
    expect(result).toMatchObject({ categories: 1, subcategories: 1 });
  });

  it('skips a name the shop already uses elsewhere and keeps going', async () => {
    jest.spyOn(categoryService, 'createCategory')
      .mockRejectedValueOnce(Object.assign(new Error('taken'), { statusCode: 409 }))
      .mockResolvedValueOnce({ category: doc({}), created: true });

    const result = await categoryService.applyTemplate({ _id: SHOP }, {
      names: ['মুদি', 'মসলা'],
    });

    // Without the per-row catch, one hand-made duplicate would 409 the whole
    // batch and lose every other category the shopkeeper ticked.
    expect(result).toMatchObject({ categories: 1, skipped: 1 });
  });

  it('refuses an empty selection', async () => {
    await expect(categoryService.applyTemplate({ _id: SHOP }, { names: [] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('bulkDelete — partial success is reported, not thrown', () => {
  it('reports which rows failed and why, having deleted the rest', async () => {
    const ok = new mongoose.Types.ObjectId();
    const busy = new mongoose.Types.ObjectId();

    jest.spyOn(categoryService, 'deleteCategory')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('has products'), {
        statusCode: 400,
        messageBn: 'এই ক্যাটাগরিতে ৩টি পণ্য আছে',
      }));
    jest.spyOn(Category, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ name: 'মুদি' }) }),
    });

    const result = await categoryService.bulkDelete(SHOP, [ok, busy]);

    // A row that gained a product between the screen loading and the button
    // being pressed is exactly what the shopkeeper needs told about.
    expect(result.deleted).toBe(1);
    expect(result.failed).toEqual([
      { _id: busy, name: 'মুদি', reason: 'এই ক্যাটাগরিতে ৩টি পণ্য আছে' },
    ]);
  });

  it('refuses an empty list and an oversized one', async () => {
    await expect(categoryService.bulkDelete(SHOP, []))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(categoryService.bulkDelete(SHOP, new Array(201).fill(PARENT)))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

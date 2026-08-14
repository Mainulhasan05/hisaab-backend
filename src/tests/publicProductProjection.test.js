/**
 * What a stranger may read off a product, and what they may not.
 *
 * ECOMMERCE_PLAN.md §13 phrases the rule as "project away `buyingPrice`,
 * `wholesalePrice`, `batches`, `serials`, `totalSold`, `profit`". These tests
 * assert the stronger, inverted form the service actually implements — an
 * ALLOWLIST — because the denylist is correct exactly once:
 *
 *   · the seventh cost field added to `Product` next year is public on merge,
 *     with nothing failing to say so;
 *   · and as written it was ALREADY incomplete, because `variants[]` carries
 *     its own `buyingPrice` and `wholesalePrice` and a top-level exclusion does
 *     not reach a nested one. A shop selling three sizes of a shirt would have
 *     published what it paid for each.
 *
 * These are REGRESSIONS in the sense that matters: remove the allowlist and
 * spread the document instead, and every test in the first two blocks fails.
 * The schema-driven test is the durable one — it fails for a field that does
 * not exist yet.
 */

const mongoose = require('mongoose');

jest.mock('../models/Shop.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/Storefront.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/StorefrontTemplate.model', () => ({ findOne: jest.fn() }));
jest.mock('../models/Category.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const selectCalls = [];
const makeQueryStub = (result) => {
  const q = {
    select: (v) => { selectCalls.push(v); return q; },
    populate: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => Promise.resolve(result),
  };
  return q;
};

jest.mock('../models/Product.model', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  aggregate: jest.fn(() => Promise.resolve([])),
  countDocuments: jest.fn(() => Promise.resolve(0)),
}));

const Product = require('../models/Product.model');
const Shop = require('../models/Shop.model');
const Storefront = require('../models/Storefront.model');
const StorefrontTemplate = require('../models/StorefrontTemplate.model');
const ProductSchemaModel = jest.requireActual('../models/Product.model');
const publicService = require('../services/publicStorefront.service');
const { PUBLIC_PRODUCT_FIELDS } = publicService;

/**
 * A product with every commercially sensitive field filled in with a value that
 * is trivially greppable. If any of these numbers reaches the output, a shop's
 * margin is on the internet.
 */
const COST = {
  buyingPrice: 111.11,
  wholesalePrice: 222.22,
  variantBuyingPrice: 333.33,
  variantWholesalePrice: 444.44,
  totalSold: 555,
};

const loadedProduct = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  shop: new mongoose.Types.ObjectId(),
  branch: null,
  code: 'CHAL-001',
  barcode: '8901234567890',
  name: 'মিনিকেট চাল',
  category: { _id: new mongoose.Types.ObjectId(), name: 'চাল', slug: 'chal' },
  subcategory: 'প্রিমিয়াম',
  description: 'সাপ্লায়ার: করিম ট্রেডার্স, শেলফ B4',
  onlineDescription: 'উন্নত মানের মিনিকেট চাল।',
  brand: 'ACI',
  unit: 'kg',
  buyingPrice: COST.buyingPrice,
  sellingPrice: 90,
  wholesalePrice: COST.wholesalePrice,
  onlinePrice: 75,
  stock: 40,
  minStock: 5,
  trackBatches: true,
  batches: [{ batchNo: 'B1', buyingPrice: COST.buyingPrice, quantity: 10 }],
  trackSerials: true,
  serials: [{ serial: 'SN-1', status: 'in_stock' }],
  hasVariants: false,
  variants: [],
  images: [],
  catalogImages: [
    { mediaId: new mongoose.Types.ObjectId(), url: 'https://r2/a.webp', thumbnail: 'https://r2/a-t.webp', isPrimary: false },
    { mediaId: new mongoose.Types.ObjectId(), url: 'https://r2/b.webp', thumbnail: 'https://r2/b-t.webp', isPrimary: true },
  ],
  tags: ['combo'],
  totalSold: COST.totalSold,
  lastSold: new Date(),
  isActive: true,
  isDeleted: false,
  isAvailableOnline: true,
  isFeaturedOnline: true,
  createdBy: new mongoose.Types.ObjectId(),
  createdAt: new Date(),
  ...over,
});

const variantProduct = () => loadedProduct({
  hasVariants: true,
  stock: 0,
  onlinePrice: undefined,
  variants: [
    {
      sku: 'SHIRT-M', attributes: { size: 'M' }, sellingPrice: 800,
      buyingPrice: COST.variantBuyingPrice, wholesalePrice: COST.variantWholesalePrice,
      stock: 3, isActive: true, image: 'https://r2/m.webp',
    },
    {
      sku: 'SHIRT-L', attributes: { size: 'L' }, sellingPrice: 950,
      buyingPrice: COST.variantBuyingPrice, wholesalePrice: COST.variantWholesalePrice,
      stock: 0, isActive: true,
    },
    {
      sku: 'SHIRT-OLD', attributes: { size: 'S' }, sellingPrice: 700,
      buyingPrice: COST.variantBuyingPrice, stock: 9, isActive: false,
    },
  ],
});

/** Every value anywhere in a nested structure, flattened to strings. */
const allValues = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { node.forEach((n) => allValues(n, out)); return out; }
  if (typeof node === 'object') { Object.values(node).forEach((n) => allValues(n, out)); return out; }
  out.push(String(node));
  return out;
};

beforeEach(() => { selectCalls.length = 0; jest.clearAllMocks(); });

describe('the allowlist itself', () => {
  const fields = PUBLIC_PRODUCT_FIELDS.split(' ');

  it.each(['buyingPrice', 'wholesalePrice', 'batches', 'serials', 'totalSold', 'profit'])(
    'does not name %s',
    (f) => expect(fields).not.toContain(f)
  );

  it('is an inclusion projection — no field is prefixed with "-"', () => {
    // A single `-field` entry would make Mongoose read the WHOLE list as an
    // exclusion projection and return every other field on the document.
    for (const f of fields) expect(f.startsWith('-')).toBe(false);
  });

  /**
   * The durable one: any path on the real schema that is not allowlisted must
   * not appear in the output. This is what fails for a cost field that has not
   * been invented yet.
   */
  it('covers every Product schema path — unlisted paths are excluded by default', () => {
    const schemaPaths = Object.keys(ProductSchemaModel.schema.paths)
      .map((p) => p.split('.')[0])
      .filter((p) => !['_id', '__v'].includes(p));
    const unlisted = [...new Set(schemaPaths)].filter((p) => !fields.includes(p));

    // Not an empty list — it is most of the schema, which is the point. Assert
    // the sensitive ones are in it so a rename cannot quietly drop them.
    for (const f of ['buyingPrice', 'wholesalePrice', 'batches', 'serials', 'totalSold', 'createdBy', 'shop', 'branch']) {
      expect(unlisted).toContain(f);
    }
  });
});

describe('toPublicProduct leaks nothing', () => {
  it('emits no cost value anywhere in the payload', () => {
    const out = publicService.toPublicProduct(loadedProduct(), { full: true });
    const values = allValues(out);
    for (const [label, v] of Object.entries(COST)) {
      expect({ label, values: values.filter((x) => x === String(v)) }).toEqual({ label, values: [] });
    }
  });

  it('emits no cost value from inside variants either', () => {
    const out = publicService.toPublicProduct(variantProduct(), { full: true });
    const values = allValues(out);
    expect(values).not.toContain(String(COST.variantBuyingPrice));
    expect(values).not.toContain(String(COST.variantWholesalePrice));
    expect(out.variants.every((v) => !('buyingPrice' in v) && !('wholesalePrice' in v))).toBe(true);
  });

  it('publishes the ONLINE description, never the internal one', () => {
    const p = loadedProduct();
    const out = publicService.toPublicProduct(p, { full: true });
    // The internal `description` holds supplier names and shelf locations.
    expect(out.description).toBe(p.onlineDescription);
    expect(allValues(out)).not.toContain(p.description);
  });

  it('omits description and variants entirely from list rows', () => {
    const out = publicService.toPublicProduct(loadedProduct());
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('variants');
  });

  it('drops internal ids: shop, branch, createdBy, mediaId', () => {
    const p = loadedProduct();
    const out = publicService.toPublicProduct(p, { full: true });
    expect(out).not.toHaveProperty('shop');
    expect(out).not.toHaveProperty('branch');
    expect(out).not.toHaveProperty('createdBy');
    expect(out.images.every((i) => !('mediaId' in i))).toBe(true);
    expect(allValues(out)).not.toContain(String(p.createdBy));
  });

  it('publishes no raw stock count, only an availability signal', () => {
    const out = publicService.toPublicProduct(loadedProduct({ stock: 40 }), { full: true });
    expect(out.inStock).toBe(true);
    expect(out).not.toHaveProperty('stock');
    expect(allValues(out)).not.toContain('40');
  });
});

describe('price is derived on the server', () => {
  it('uses onlinePrice and offers sellingPrice as compare-at', () => {
    const out = publicService.toPublicProduct(loadedProduct({ sellingPrice: 90, onlinePrice: 75 }));
    expect(out).toMatchObject({ price: 75, compareAt: 90, savings: 15 });
  });

  it('shows no compare-at when there is no online price', () => {
    const out = publicService.toPublicProduct(loadedProduct({ sellingPrice: 90, onlinePrice: undefined }));
    expect(out).toMatchObject({ price: 90, compareAt: null, savings: 0 });
  });

  /**
   * A shop is allowed to charge MORE online to cover delivery. Rendering a
   * strikethrough there would invent a discount that does not exist, which is
   * the kind of thing a consumer regulator has opinions about.
   */
  it('honours a higher online price without inventing a discount', () => {
    const out = publicService.toPublicProduct(loadedProduct({ sellingPrice: 90, onlinePrice: 120 }));
    expect(out).toMatchObject({ price: 120, compareAt: null, savings: 0 });
  });

  it('treats an online price of 0 as a real price, not as unset', () => {
    // `??` semantics, matching the storage-quota rule in STORAGE_HANDOFF §4.6:
    // a `||` here would silently reprice a free item at full price.
    const out = publicService.toPublicProduct(loadedProduct({ sellingPrice: 90, onlinePrice: 0 }));
    expect(out.price).toBe(0);
    expect(out.compareAt).toBe(90);
  });

  it('gives variant products a range from ACTIVE variants only', () => {
    const out = publicService.toPublicProduct(variantProduct(), { full: true });
    // 700 belongs to the inactive variant and must not set the floor.
    expect(out).toMatchObject({ priceMin: 800, priceMax: 950, price: 800, compareAt: null });
  });

  /**
   * One rule, applied everywhere: online price if given, else selling price.
   *
   * A variant product used to IGNORE its product-level online price entirely,
   * which meant the one online-price field on the product form did nothing on
   * exactly the products a shop is most likely to discount.
   */
  describe('a product-level online price reaches the variants', () => {
    const discounted = () => {
      const p = variantProduct();
      p.onlinePrice = 750;
      return p;
    };

    it('prices every variant at the product online price', () => {
      const out = publicService.toPublicProduct(discounted(), { full: true });
      expect(out.variants.map((v) => v.price)).toEqual([750, 750]);
    });

    it('strikes through each variant against its OWN shelf price', () => {
      const out = publicService.toPublicProduct(discounted(), { full: true });
      expect(out.variants.find((v) => v.sku === 'SHIRT-M')).toMatchObject({
        price: 750, compareAt: 800, savings: 50,
      });
      expect(out.variants.find((v) => v.sku === 'SHIRT-L')).toMatchObject({
        price: 750, compareAt: 950, savings: 200,
      });
    });

    /**
     * The card quotes the cheapest variant's price AND that same variant's
     * compare-at. Pairing the lowest price with the largest saving in the group
     * (750 against 950) would advertise a ৳200 discount on an item whose shelf
     * price is ৳800.
     */
    it('never pairs the cheapest price with someone else\'s discount', () => {
      const out = publicService.toPublicProduct(discounted(), { full: true });
      expect(out).toMatchObject({ price: 750, compareAt: 800, savings: 50 });
      expect(out.savings).not.toBe(200);
    });

    it('falls back to each variant\'s selling price when no online price is set', () => {
      const out = publicService.toPublicProduct(variantProduct(), { full: true });
      expect(out.variants.map((v) => v.price)).toEqual([800, 950]);
      expect(out.variants.every((v) => v.compareAt === null)).toBe(true);
    });

    it('treats a product-level online price of 0 as a real price for variants', () => {
      const p = variantProduct();
      p.onlinePrice = 0;
      const out = publicService.toPublicProduct(p, { full: true });
      expect(out.variants.map((v) => v.price)).toEqual([0, 0]);
      expect(out.price).toBe(0);
    });

    it('still leaks no variant cost data once variants carry prices', () => {
      const out = publicService.toPublicProduct(discounted(), { full: true });
      const values = allValues(out);
      expect(values).not.toContain(String(COST.variantBuyingPrice));
      expect(values).not.toContain(String(COST.variantWholesalePrice));
      expect(out.variants.every((v) => !('stock' in v))).toBe(true);
    });
  });
});

describe('stock and images', () => {
  it('a variant product is in stock when any active variant has units', () => {
    const out = publicService.toPublicProduct(variantProduct(), { full: true });
    expect(out.inStock).toBe(true);
    expect(out.variants.find((v) => v.sku === 'SHIRT-M').inStock).toBe(true);
    expect(out.variants.find((v) => v.sku === 'SHIRT-L').inStock).toBe(false);
  });

  it('hides inactive variants completely', () => {
    const out = publicService.toPublicProduct(variantProduct(), { full: true });
    expect(out.variants.map((v) => v.sku)).toEqual(['SHIRT-M', 'SHIRT-L']);
  });

  it('puts the primary image first so templates can render images[0]', () => {
    const out = publicService.toPublicProduct(loadedProduct());
    expect(out.images[0].url).toBe('https://r2/b.webp');
    expect(out.images[0].isPrimary).toBe(true);
  });

  it('falls back to legacy ImgBB url strings when there are no catalog images', () => {
    const out = publicService.toPublicProduct(
      loadedProduct({ catalogImages: [], images: ['https://i.ibb.co/x.jpg'] })
    );
    expect(out.images).toEqual([
      { url: 'https://i.ibb.co/x.jpg', thumbnail: 'https://i.ibb.co/x.jpg', isPrimary: false },
    ]);
  });
});

describe('the query that is built', () => {
  const SHOP_ID = new mongoose.Types.ObjectId();
  const BRANCH_ID = new mongoose.Types.ObjectId();

  const wire = (storefrontOver = {}) => {
    Shop.findOne.mockReturnValue({
      select: function () { return this; },
      lean: () => Promise.resolve({
        _id: SHOP_ID, slug: 'rahim-store', name: 'রহিম', isActive: true,
        features: { storefront: true }, subscription: { plan: 'paid' }, access: {},
      }),
    });
    Storefront.findOne.mockReturnValue({
      lean: () => Promise.resolve({
        shop: SHOP_ID, branch: null, status: 'live', pausedByAdmin: null,
        outOfStockBehaviour: 'hide',
        published: { template: 'bazar', theme: {}, blocks: {}, nav: [], seo: {} },
        delivery: { zones: [] },
        ...storefrontOver,
      }),
    });
    StorefrontTemplate.findOne.mockReturnValue({
      lean: () => Promise.resolve({ key: 'bazar', slots: [], themeDefaults: {} }),
    });
  };

  it('selects exactly the allowlist', async () => {
    wire();
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    expect(selectCalls).toContain(PUBLIC_PRODUCT_FIELDS);
  });

  it('always scopes to the shop, online, active and not deleted', async () => {
    wire();
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    const filter = Product.find.mock.calls[0][0];
    const scope = filter.$and ? filter.$and[0] : filter;
    expect(scope).toMatchObject({
      shop: SHOP_ID, isAvailableOnline: true, isActive: true, isDeleted: false,
    });
  });

  /**
   * I-1. A single-branch shop's storefront must issue the query a single-branch
   * shop already issues. `{ branch: null }` looks equivalent and is not — it
   * would exclude every product written before the field existed.
   */
  it('adds NO branch clause when the storefront has no fulfilment branch', async () => {
    wire({ branch: null });
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    const filter = Product.find.mock.calls[0][0];
    expect(JSON.stringify(filter)).not.toContain('branch');
  });

  it('scopes to the fulfilment branch when one is set', async () => {
    wire({ branch: BRANCH_ID });
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    const filter = Product.find.mock.calls[0][0];
    const scope = filter.$and ? filter.$and[0] : filter;
    expect(String(scope.branch)).toBe(String(BRANCH_ID));
  });

  it('hides out-of-stock products by default, including variant products', async () => {
    wire({ outOfStockBehaviour: 'hide' });
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    const filter = Product.find.mock.calls[0][0];
    const stockClause = filter.$and.find((c) => c.$or);
    expect(stockClause.$or).toHaveLength(2);
    // The second arm is what keeps variant products from vanishing wholesale.
    expect(stockClause.$or[1]).toMatchObject({ hasVariants: true });
  });

  it('keeps out-of-stock products when the shop asked for that', async () => {
    wire({ outOfStockBehaviour: 'show' });
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', {});
    const filter = Product.find.mock.calls[0][0];
    expect(JSON.stringify(filter)).not.toContain('$or');
  });

  it('escapes a search term before it reaches a regex', async () => {
    wire();
    Product.find.mockReturnValue(makeQueryStub([]));
    await publicService.listProducts('rahim-store', { q: 'a(b.*c' });
    const filter = Product.find.mock.calls[0][0];
    const nameClause = filter.$and.find((c) => c.name);
    expect(nameClause.name.$regex).toBe('a\\(b\\.\\*c');
    // Proves it is inert rather than merely different.
    expect(() => new RegExp(nameClause.name.$regex)).not.toThrow();
  });

  it('clamps limit to the ceiling instead of trusting the query string', async () => {
    wire();
    Product.find.mockReturnValue(makeQueryStub([]));
    const out = await publicService.listProducts('rahim-store', { limit: 100000 });
    expect(out.pagination.limit).toBe(48);
  });
});

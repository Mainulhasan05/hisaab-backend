/**
 * The storefront SEO block: what may be stored, and what a page falls back to.
 *
 * Three groups, and AGENT_WORKFLOW.md §7.1 asks which is which:
 *
 *   REGRESSIONS — the `normalizeSeo` refusals. Each fails if its guard is
 *     removed. A newline survives into a `<meta>` tag and truncates the snippet
 *     silently; a relative `ogImage` is resolved against Facebook's own origin
 *     and dropped, with nothing on the shop's screen to explain the blank card.
 *     Neither produces an error anywhere — they produce a worse-performing page
 *     that looks fine to us.
 *
 *   INVARIANT GUARD — `resolveSeo` is the ONLY fallback rule. The shop's editor
 *     renders a preview from it and the public pages render from it, so a second
 *     copy anywhere means the shop is shown a preview of a page that does not
 *     exist. Nothing has broken this; the test pins the contract both ends read.
 *
 *   INVARIANT GUARD — `listIndexableStorefronts` must not list a storefront that
 *     would go dark for a visitor. Submitting a URL that answers 404 is a crawl
 *     cost against the whole domain, and the failure is invisible: the sitemap
 *     is valid, the shop is simply never indexed and nobody is told.
 */

const mongoose = require('mongoose');

const {
  normalizeSeo,
  resolveSeo,
  cleanText,
  TITLE_MAX,
  DESCRIPTION_MAX,
} = require('../utils/storefrontSeo.util');

describe('normalizeSeo — what may reach a <meta> tag', () => {
  it('flattens the whitespace a WhatsApp paste brings with it', () => {
    // A newline here truncates the snippet in some crawlers and voids it in
    // others, and nothing on our side reports either.
    expect(normalizeSeo({ description: 'রহিম স্টোর\nচাল, ডাল\tও তেল' })).toEqual({
      description: 'রহিম স্টোর চাল, ডাল ও তেল',
    });
  });

  it('refuses a field it does not know rather than dropping it', () => {
    // Dropped, this is content the shop believes it saved and will never see.
    expect(() => normalizeSeo({ keywords: 'চাল, ডাল' })).toThrow(/Unknown SEO fields/);
  });

  it('refuses a relative ogImage', () => {
    // Facebook resolves it against its OWN origin and shows no picture.
    expect(() => normalizeSeo({ ogImage: '/uploads/og.png' })).toThrow(/absolute/);
    expect(normalizeSeo({ ogImage: 'https://cdn.example/og.png' })).toEqual({
      ogImage: 'https://cdn.example/og.png',
    });
  });

  it('treats an emptied ogImage as a real instruction, not a missing key', () => {
    // "Go back to the logo" is a choice a shop must be able to make. Coercing
    // this to undefined would leave the old image live with the screen
    // insisting it was gone.
    expect(normalizeSeo({ ogImage: '' })).toEqual({ ogImage: null });
  });

  it('refuses past the hard ceiling but allows past the Google guideline', () => {
    // 60 is where Google truncates; refusing there would tell a shop with a long
    // real name that their own name is invalid.
    expect(normalizeSeo({ title: 'ক'.repeat(80) }).title).toHaveLength(80);
    expect(() => normalizeSeo({ title: 'ক'.repeat(TITLE_MAX + 1) })).toThrow(/at most/);
    expect(() => normalizeSeo({ description: 'ক'.repeat(DESCRIPTION_MAX + 1) })).toThrow(/at most/);
  });

  it('leaves a key alone when the patch does not mention it', () => {
    // The editor saves one field at a time; a patch about the description must
    // not blank the title the shop wrote last week.
    expect(normalizeSeo({ description: 'x' })).not.toHaveProperty('title');
  });
});

describe('resolveSeo — one fallback rule, read by both ends', () => {
  const shop = { name: 'রহিম স্টোর', logo: 'https://cdn.example/logo.png' };

  it('falls back to the shop name and logo', () => {
    const out = resolveSeo(shop, {});
    expect(out.title).toBe('রহিম স্টোর');
    expect(out.description).toContain('রহিম স্টোর');
    expect(out.ogImage).toBe('https://cdn.example/logo.png');
  });

  it('reports which values are ours and which the shop wrote', () => {
    // The editor renders "স্বয়ংক্রিয়" from this. Without it a default reads as
    // authored text, nobody edits the field, and every shop on the platform
    // ships the same description forever.
    expect(resolveSeo(shop, {}).isDefault).toEqual({
      title: true, description: true, ogImage: true,
    });
    expect(resolveSeo(shop, { title: 'x', ogImage: 'https://a/b.png' }).isDefault).toEqual({
      title: false, description: true, ogImage: false,
    });
  });

  it('treats whitespace-only text as unwritten', () => {
    expect(resolveSeo(shop, { title: '   ' }).title).toBe('রহিম স্টোর');
    expect(resolveSeo(shop, { title: '   ' }).isDefault.title).toBe(true);
  });

  it('never returns an empty title, even for a shop with no name', () => {
    // A blank <title> is the one output that is strictly worse than a generic
    // one — it renders the URL as the search result's headline.
    expect(cleanText(resolveSeo({}, {}).title)).not.toBe('');
  });
});

describe('listIndexableStorefronts — who gets submitted to Google', () => {
  const SHOP = new mongoose.Types.ObjectId();
  const DAY = 24 * 60 * 60 * 1000;

  const liveDoc = (over = {}) => ({
    shop: SHOP,
    published: { publishedAt: new Date('2026-09-01T00:00:00Z') },
    updatedAt: new Date('2026-09-08T00:00:00Z'),
    ...over,
  });

  const okShop = (over = {}) => ({
    _id: SHOP,
    slug: 'rahim-store',
    isActive: true,
    features: { storefront: true },
    subscription: { plan: 'paid', expiresAt: new Date(Date.now() + 90 * DAY) },
    access: {},
    ...over,
  });

  let publicService;
  let Storefront;
  let Shop;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../models/Shop.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
    jest.doMock('../models/Storefront.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
    jest.doMock('../models/StorefrontTemplate.model', () => ({ findOne: jest.fn(), SLOT_KEYS: [] }));
    jest.doMock('../models/Product.model', () => ({
      find: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(),
    }));
    jest.doMock('../models/Category.model', () => ({ find: jest.fn(), findOne: jest.fn() }));
    jest.doMock('../utils/logger.util', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    Shop = require('../models/Shop.model');
    Storefront = require('../models/Storefront.model');
    publicService = require('../services/publicStorefront.service');
  });

  const wire = (storefronts, shops) => {
    Storefront.find.mockReturnValue({
      select: function () { return this; },
      lean: () => Promise.resolve(storefronts),
    });
    Shop.find.mockReturnValue({
      select: function () { return this; },
      lean: () => Promise.resolve(shops),
    });
  };

  it('lists a servable storefront, dated by its last PUBLISH', async () => {
    wire([liveDoc()], [okShop()]);
    const out = await publicService.listIndexableStorefronts();
    expect(out).toEqual([
      { slug: 'rahim-store', updatedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    // Not `updatedAt`: that moves on every draft autosave, and a lastmod that
    // changes without the public page changing teaches a crawler to ignore it.
    expect(out[0].updatedAt).not.toEqual(new Date('2026-09-08T00:00:00Z'));
  });

  it('drops a shop whose storefront capability was withdrawn', async () => {
    wire([liveDoc()], [okShop({ features: { storefront: false } })]);
    expect(await publicService.listIndexableStorefronts()).toEqual([]);
  });

  it('drops a shop whose subscription has lapsed', async () => {
    wire([liveDoc()], [okShop({
      subscription: { plan: 'paid', expiresAt: new Date(Date.now() - 90 * DAY) },
    })]);
    expect(await publicService.listIndexableStorefronts()).toEqual([]);
  });

  it('drops a storefront whose shop no longer exists', async () => {
    // The Shop read comes back short of the Storefront read. Without the
    // lookup guard this would emit `/s/undefined/sitemap.xml`.
    wire([liveDoc()], []);
    expect(await publicService.listIndexableStorefronts()).toEqual([]);
  });

  it('asks the database only for live, un-paused, published storefronts', async () => {
    wire([], []);
    await publicService.listIndexableStorefronts();
    expect(Storefront.find).toHaveBeenCalledWith({
      status: 'live',
      // `null`, not `false`: the field holds the ADMIN who paused it. Querying
      // it as a boolean is a CastError on every request — an always-empty
      // sitemap — and only a real database says so, which is why this
      // assertion pins the literal rather than trusting the mock.
      pausedByAdmin: null,
      'published.template': { $ne: null },
    });
  });

  it('does not submit a shop\'s old addresses', async () => {
    // They resolve, so shared links work — but submitting them asks Google to
    // index a second copy of a catalogue the rename is consolidating.
    wire([liveDoc()], [okShop({ previousSlugs: ['rahim-store-9x2b'] })]);
    const out = await publicService.listIndexableStorefronts();
    expect(out.map((s) => s.slug)).toEqual(['rahim-store']);
  });
});

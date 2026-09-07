/**
 * An empty template restriction means EVERY published template, not none.
 *
 * WHAT THIS FIXES: `Shop.storefront.allowedTemplates` defaults to `[]`, and
 * that used to mean "no templates granted". So the ordinary path — an admin
 * switches `features.storefront` on — produced a shop whose template picker
 * was empty: a website feature that could not pick a website. Making the site
 * work needed a SECOND admin action that nothing prompted for and nothing
 * failed without.
 *
 * Empty now means unrestricted. A non-empty list still restricts, exactly as
 * before, so a shop that was deliberately limited stays limited.
 *
 * Pure functions over plain objects — no database.
 */

const {
  hasTemplateRestriction,
  canApplyTemplate,
  offerableTemplateFilter,
} = require('../utils/storefrontTemplates.util');

const shopWith = (allowedTemplates) => ({ storefront: { allowedTemplates } });

describe('template restriction — the empty case', () => {
  it('treats an empty list as no restriction', () => {
    expect(hasTemplateRestriction(shopWith([]))).toBe(false);
    expect(canApplyTemplate(shopWith([]), 'bazar')).toBe(true);
    expect(canApplyTemplate(shopWith([]), 'poshak')).toBe(true);
  });

  /**
   * The states a real document actually arrives in. A shop created before
   * `storefront` existed has no sub-document at all, and it must read as
   * unrestricted rather than throwing or as restricted-to-nothing.
   */
  it('treats a missing or malformed list as no restriction', () => {
    expect(hasTemplateRestriction({})).toBe(false);
    expect(hasTemplateRestriction({ storefront: {} })).toBe(false);
    expect(hasTemplateRestriction(shopWith(undefined))).toBe(false);
    expect(hasTemplateRestriction(shopWith(null))).toBe(false);
    expect(canApplyTemplate({}, 'bazar')).toBe(true);
  });

  it('still restricts when a list is set', () => {
    const shop = shopWith(['bazar']);
    expect(hasTemplateRestriction(shop)).toBe(true);
    expect(canApplyTemplate(shop, 'bazar')).toBe(true);
    expect(canApplyTemplate(shop, 'poshak')).toBe(false);
  });
});

describe('offerableTemplateFilter', () => {
  it('offers every published template when unrestricted', () => {
    expect(offerableTemplateFilter(shopWith([]))).toEqual({ status: 'published' });
  });

  /**
   * I-11's read-side companion: the template a shop is RUNNING belongs in its
   * own picker even when it is retired or outside the restriction, so the
   * gallery can grey it and say why instead of showing a list that does not
   * contain the site the shop is looking at.
   */
  it('always includes the template in use, published or not', () => {
    expect(offerableTemplateFilter(shopWith([]), ['retired-one'])).toEqual({
      $or: [{ status: 'published' }, { key: { $in: ['retired-one'] } }],
    });

    const restricted = offerableTemplateFilter(shopWith(['bazar']), ['retired-one']);
    expect(restricted.key.$in).toEqual(expect.arrayContaining(['bazar', 'retired-one']));
  });

  it('narrows to the restriction when one is set', () => {
    expect(offerableTemplateFilter(shopWith(['bazar', 'poshak']))).toEqual({
      key: { $in: ['bazar', 'poshak'] },
    });
  });

  it('does not duplicate a key that is both restricted and in use', () => {
    const filter = offerableTemplateFilter(shopWith(['bazar']), ['bazar']);
    expect(filter.key.$in).toEqual(['bazar']);
  });

  /** A falsy active key (no template applied yet) must not reach the query. */
  it('ignores empty extra keys', () => {
    expect(offerableTemplateFilter(shopWith([]), [null, undefined, ''])).toEqual({
      status: 'published',
    });
  });
});

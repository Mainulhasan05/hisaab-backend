/**
 * Every path to `status: 'live'` runs the same gates.
 *
 * `publish` always did. `renew` did not — it set `status: 'live'` directly, so a
 * draft that had never been publishable (no order form, no offers, no expiry)
 * could be put on a public URL by renewing it. The page would render, an
 * advertisement could point at it, and it would take no orders.
 *
 * These tests use a stubbed `getById` rather than a database: the gates are pure
 * given a page document, and the point is to pin the control flow.
 */

const service = require('../services/landingPage.service');

const GOOD_HTML = `
  <form data-hisaab="order-form">
    <input name="customerName" required>
    <input name="phone" required>
    <textarea name="address" required></textarea>
    <select name="offer"><option value="5kg">৫ কেজি</option></select>
    <button data-hisaab="submit">অর্ডার</button>
  </form>
  <div data-hisaab="success"></div>`;

/** A page-shaped object with the `save()` a mongoose document would have. */
function fakePage(over = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    shop: '507f1f77bcf86cd799439012',
    title: 'আম ২০২৬',
    slug: 'aam-2026',
    html: GOOD_HTML,
    assets: {},
    offers: [{ key: '5kg', label: '৫ কেজি', price: 1800, isActive: true }],
    delivery: { zones: [{ key: 'inside-dhaka', name: 'ঢাকা', charge: 60, isActive: true }] },
    seo: {},
    expiresAt: new Date('2026-12-31T17:59:59.999Z'),
    graceDays: 0,
    renewCount: 0,
    status: 'draft',
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  // The refs sync talks to the media library; it is not what these tests are
  // about, and it is already covered by its own suite.
  jest.spyOn(service, '_syncMediaRefs').mockResolvedValue({ explicit: 0, scanned: 0 });
});

describe('_assertPublishable', () => {
  test('a complete page passes', async () => {
    await expect(service._assertPublishable(fakePage())).resolves.toMatchObject({
      issues: expect.any(Array),
    });
  });

  test('a page with no order form is refused with the issue list attached', async () => {
    await expect(service._assertPublishable(fakePage({ html: '<h1>আম</h1>' })))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' });

    try {
      await service._assertPublishable(fakePage({ html: '<h1>আম</h1>' }));
    } catch (err) {
      // The admin needs to know WHAT is wrong, not merely that something is.
      expect(err.issues.map((i) => i.code)).toContain('NO_FORM');
      expect(err.statusCode).toBe(422);
    }
  });

  test('a page with no expiry date is refused — the seasonal fee IS the expiry', async () => {
    await expect(service._assertPublishable(fakePage({ expiresAt: null })))
      .rejects.toThrow(/expiry date/i);
  });

  /**
   * The refusal and the report the author reads must be the same list.
   *
   * They were not: `publishIssues` said "ready to publish" on a page with no
   * expiry, the publish button stayed enabled, and the 422 that came back named
   * a requirement no screen had ever mentioned.
   */
  test('a missing expiry is a reported blocker, not just a refusal', async () => {
    const issues = service.publishIssues(fakePage({ expiresAt: null }));
    expect(issues.map((i) => i.code)).toContain('NO_EXPIRY');
    expect(issues.find((i) => i.code === 'NO_EXPIRY').severity).toBe('error');

    // And it rides on the error, so the editor can list it after a failed publish.
    try {
      await service._assertPublishable(fakePage({ expiresAt: null }));
      throw new Error('should have refused');
    } catch (err) {
      expect(err.issues.map((i) => i.code)).toContain('NO_EXPIRY');
    }

    // A complete page reports nothing blocking — the gate has not become a wall.
    expect(service.publishIssues(fakePage()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('a page whose offers were emptied is refused', async () => {
    await expect(service._assertPublishable(fakePage({ offers: [] })))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' });
  });
});

describe('publish', () => {
  test('sets the page live and stamps publishedAt once', async () => {
    const page = fakePage();
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await service.publish(page._id, 'admin-1');

    expect(page.status).toBe('live');
    expect(page.publishedAt).toBeInstanceOf(Date);
    expect(page.save).toHaveBeenCalled();
  });

  test('a broken page is never saved', async () => {
    const page = fakePage({ html: '<h1>nothing</h1>' });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await expect(service.publish(page._id, 'admin-1')).rejects.toMatchObject({ code: 'CONTRACT_INVALID' });
    expect(page.save).not.toHaveBeenCalled();
    expect(page.status).toBe('draft');
  });
});

describe('renew', () => {
  test('a valid expired page comes back live and counts the renewal', async () => {
    const page = fakePage({ status: 'expired', renewCount: 1 });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await service.renew(page._id, 'admin-1', { expiresAt: '2027-08-31' });

    expect(page.status).toBe('live');
    expect(page.renewCount).toBe(2);
    expect(page.renewedAt).toBeInstanceOf(Date);
  });

  test('the new expiry is stored as the END of a Bangladesh day', async () => {
    const page = fakePage({ status: 'expired' });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await service.renew(page._id, 'admin-1', { expiresAt: '2027-08-31' });

    // 2027-08-31 23:59:59.999 Dhaka is 17:59:59.999 UTC. Storing the raw date
    // would cost the trader their busiest evening.
    expect(page.expiresAt.toISOString()).toBe('2027-08-31T17:59:59.999Z');
  });

  test('REGRESSION: renewing a page that cannot take an order is refused', async () => {
    // The hole this file exists for. `renew` used to set `status: 'live'`
    // directly, so this page — no form, no submit — would have gone live.
    const page = fakePage({ status: 'draft', html: '<h1>আম</h1>' });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await expect(service.renew(page._id, 'admin-1', { expiresAt: '2027-08-31' }))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' });

    expect(page.status).toBe('draft');
    expect(page.save).not.toHaveBeenCalled();
  });

  test('REGRESSION: renewing a page whose offers were emptied is refused', async () => {
    // The realistic version: the page was fine last season, and someone cleared
    // the offers while it sat expired.
    const page = fakePage({ status: 'expired', offers: [] });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await expect(service.renew(page._id, 'admin-1', { expiresAt: '2027-08-31' }))
      .rejects.toMatchObject({ code: 'CONTRACT_INVALID' });
    expect(page.status).toBe('expired');
  });

  test('a renewal without a new date is refused before anything else', async () => {
    const page = fakePage({ status: 'expired' });
    jest.spyOn(service, 'getById').mockResolvedValue(page);

    await expect(service.renew(page._id, 'admin-1', {})).rejects.toThrow(/new expiry/i);
    expect(page.save).not.toHaveBeenCalled();
  });
});

describe('stats and customers tolerate a malformed id', () => {
  test('statsForPage returns zeroes rather than throwing on a bad id', async () => {
    // A malformed id here comes from a route parameter. An ObjectId cast error
    // would surface as a 500 where the caller expects a 404.
    await expect(service.statsForPage('not-an-id')).resolves.toMatchObject({
      received: 0,
      confirmationRate: 0,
    });
  });

  test('customersForPage returns an empty list rather than throwing', async () => {
    await expect(service.customersForPage('not-an-id')).resolves.toEqual([]);
  });
});

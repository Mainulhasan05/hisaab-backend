/**
 * The landing page contract parser and its publish-time gate.
 *
 * This is the layer where a mistake is invisible until it is expensive. A page
 * that publishes and then cannot take an order is the worst outcome the feature
 * has — the shop is paying for advertisements pointing at it, and nothing in the
 * system says anything is wrong. Every `error`-severity case below is a page
 * that must be refused.
 *
 * The parser is also the I-18 reconciler's input: `mediaUrls` is how a file an
 * admin pasted by hand rather than picked is discovered, and missing one means
 * the reclamation sweep eventually deletes an image off a live page.
 */

const {
  parseContract,
  validateContract,
  hasBlockingIssues,
  REQUIRED_FIELDS,
} = require('../utils/landingContract.util');

/** A minimal page that passes every gate — the baseline each case breaks. */
const GOOD_FORM = `
  <form data-hisaab="order-form">
    <input name="customerName" required>
    <input name="phone" required>
    <textarea name="address" required></textarea>
    <select name="offer">
      <option value="3kg">৩ কেজি</option>
      <option value="5kg">৫ কেজি</option>
    </select>
    <select name="zone">
      <option value="inside-dhaka">ঢাকার ভিতরে</option>
    </select>
    <button data-hisaab="submit">অর্ডার করুন</button>
  </form>
  <div data-hisaab="success" hidden></div>
`;

const PAGE = {
  offers: [
    { key: '3kg', label: '৩ কেজি', price: 1200, isActive: true },
    { key: '5kg', label: '৫ কেজি', price: 1800, isActive: true },
  ],
  delivery: { zones: [{ key: 'inside-dhaka', name: 'ঢাকার ভিতরে', charge: 60, isActive: true }] },
};

const codes = (issues) => issues.map((i) => i.code);
const errors = (issues) => issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('parseContract — the derived editor', () => {
  test('every marker kind becomes a manifest entry', () => {
    const { manifest } = parseContract(`
      <h1 data-hisaab-edit="hero-title">সেরা রাজশাহীর আম</h1>
      <div data-hisaab-rich="intro"><b>খাঁটি</b> আম</div>
      <img data-hisaab-img="hero-image" src="/x.webp">
      <a data-hisaab-href="video">ভিডিও</a>
      <li data-hisaab-repeat="review">রিভিউ</li>
      <section data-hisaab-show="faq">FAQ</section>
    `);

    expect(manifest.map((m) => m.kind).sort())
      .toEqual(['image', 'link', 'repeat', 'rich', 'text', 'toggle']);
    expect(manifest.find((m) => m.key === 'hero-title').preview).toBe('সেরা রাজশাহীর আম');
  });

  test('an unmarked design yields an empty manifest rather than throwing', () => {
    const { manifest } = parseContract('<div class="hero"><h1>Hello</h1></div>');
    expect(manifest).toEqual([]);
  });

  test('groups are inherited from the nearest marked ancestor', () => {
    const { manifest } = parseContract(`
      <section data-hisaab-group="হিরো">
        <h1 data-hisaab-edit="a">A</h1>
        <div data-hisaab-group="ভিতরে"><p data-hisaab-edit="b">B</p></div>
      </section>
      <p data-hisaab-edit="c">C</p>
    `);

    const byKey = Object.fromEntries(manifest.map((m) => [m.key, m.group]));
    expect(byKey.a).toBe('হিরো');
    expect(byKey.b).toBe('ভিতরে');
    expect(byKey.c).toBeNull();
  });

  test('manifest order follows document order — the order the reader scrolls past', () => {
    const { manifest } = parseContract(`
      <p data-hisaab-edit="third">3</p>
    `.repeat(0) + `
      <p data-hisaab-edit="one">1</p>
      <p data-hisaab-edit="two">2</p>
      <p data-hisaab-edit="three">3</p>
    `);
    expect(manifest.map((m) => m.key)).toEqual(['one', 'two', 'three']);
  });

  test('a key used twice is reported, because editing either would write to both', () => {
    const { duplicateKeys } = parseContract(`
      <p data-hisaab-edit="title">A</p><p data-hisaab-edit="title">B</p>
    `);
    expect(duplicateKeys).toEqual(['title']);
  });

  test('preview text is bounded and whitespace-collapsed', () => {
    const { manifest } = parseContract(`<p data-hisaab-edit="k">   a\n\n   b   </p>`);
    expect(manifest[0].preview).toBe('a b');

    const long = parseContract(`<p data-hisaab-edit="k">${'x'.repeat(500)}</p>`);
    expect(long.manifest[0].preview.length).toBeLessThanOrEqual(80);
  });

  test('a nested marker collects its own text as well as its parent\'s', () => {
    const { manifest } = parseContract(
      `<div data-hisaab-edit="outer">before <span data-hisaab-edit="inner">middle</span></div>`
    );
    const byKey = Object.fromEntries(manifest.map((m) => [m.key, m.preview]));
    expect(byKey.inner).toBe('middle');
    expect(byKey.outer).toContain('before');
  });
});

describe('parseContract — the form', () => {
  test('required fields inside the form are seen as inside it', () => {
    const { form } = parseContract(GOOD_FORM);
    expect(form.present).toBe(true);
    for (const field of REQUIRED_FIELDS) {
      expect(form.fields[field]).toBeDefined();
      expect(form.fields[field].inForm).toBe(true);
    }
  });

  test('REGRESSION: a field OUTSIDE the form is recorded as outside it', () => {
    // The page looks right and the value is never submitted. This distinction is
    // the whole reason `inForm` exists.
    const { form } = parseContract(`
      <input name="phone">
      <form data-hisaab="order-form"><input name="customerName"></form>
    `);
    expect(form.fields.phone.inForm).toBe(false);
    expect(form.fields.customerName.inForm).toBe(true);
  });

  test('option values are attributed to the select they belong to', () => {
    const { form, offerKeys, zoneKeys } = parseContract(GOOD_FORM);
    expect(form.fields.offer.values.sort()).toEqual(['3kg', '5kg']);
    expect(offerKeys.sort()).toEqual(['3kg', '5kg']);
    expect(zoneKeys).toEqual(['inside-dhaka']);
  });

  test('radio inputs carry their offer keys too', () => {
    const { offerKeys } = parseContract(`
      <form data-hisaab="order-form">
        <input type="radio" name="offer" value="3kg">
        <input type="radio" name="offer" value="5kg">
      </form>
    `);
    expect(offerKeys.sort()).toEqual(['3kg', '5kg']);
  });

  test('an unrelated field name is ignored rather than collected', () => {
    const { form } = parseContract(`<form data-hisaab="order-form"><input name="csrf"></form>`);
    expect(form.fields.csrf).toBeUndefined();
  });
});

describe('parseContract — media URLs for the I-18 reconciler', () => {
  test('src, poster, href and srcset are all collected', () => {
    const { mediaUrls } = parseContract(`
      <img src="https://pub-x.r2.dev/platform/a.webp">
      <img srcset="https://pub-x.r2.dev/platform/b.webp 1x, https://pub-x.r2.dev/platform/c.webp 2x">
      <video poster="https://pub-x.r2.dev/platform/d.webp"></video>
      <a href="https://pub-x.r2.dev/platform/e.pdf">x</a>
    `);

    expect(mediaUrls).toEqual(expect.arrayContaining([
      'https://pub-x.r2.dev/platform/a.webp',
      'https://pub-x.r2.dev/platform/b.webp',
      'https://pub-x.r2.dev/platform/c.webp',
      'https://pub-x.r2.dev/platform/d.webp',
      'https://pub-x.r2.dev/platform/e.pdf',
    ]));
  });

  test('REGRESSION: a URL pasted into raw HTML is found, not only picker-inserted ones', () => {
    // This is the I-18 failure in one line. An admin pastes an R2 URL, no slot
    // attachment exists, nothing holds a reference, and the sweep deletes the
    // hero image of a page currently spending ad money.
    const { mediaUrls, manifest } = parseContract(
      `<div style="x"><img src="https://pub-x.r2.dev/platform/pasted.webp"></div>`
    );
    expect(manifest).toEqual([]);          // no marker — the picker never saw it
    expect(mediaUrls).toContain('https://pub-x.r2.dev/platform/pasted.webp');
  });
});

describe('validateContract — what blocks a publish', () => {
  test('the baseline page passes with no errors', () => {
    const issues = validateContract(parseContract(GOOD_FORM), PAGE);
    expect(errors(issues)).toEqual([]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  test('no form at all is a single, clear error', () => {
    const issues = validateContract(parseContract('<h1>Hi</h1>'), PAGE);
    expect(codes(issues)).toEqual(['NO_FORM']);
    expect(hasBlockingIssues(issues)).toBe(true);
  });

  test.each(REQUIRED_FIELDS)('a missing "%s" field blocks publication', (field) => {
    const html = GOOD_FORM.replace(new RegExp(`<(input|textarea) name="${field}"[^>]*>(</textarea>)?`), '');
    const issues = validateContract(parseContract(html), PAGE);

    expect(errors(issues)).toContain(`MISSING_FIELD_${field}`);
    expect(hasBlockingIssues(issues)).toBe(true);
  });

  test('REGRESSION: a required field outside the form blocks publication', () => {
    const html = `
      <input name="phone" required>
      <form data-hisaab="order-form">
        <input name="customerName" required>
        <textarea name="address" required></textarea>
        <button data-hisaab="submit">ok</button>
      </form>`;
    expect(errors(validateContract(parseContract(html), PAGE)))
      .toContain('FIELD_OUTSIDE_FORM_phone');
  });

  test('a missing submit control blocks publication', () => {
    const html = GOOD_FORM.replace('data-hisaab="submit"', '');
    expect(errors(validateContract(parseContract(html), PAGE))).toContain('NO_SUBMIT');
  });

  test('two order forms block publication', () => {
    const issues = validateContract(parseContract(GOOD_FORM + GOOD_FORM), PAGE);
    expect(errors(issues)).toContain('MULTIPLE_FORMS');
  });

  test('an offer key in the HTML that is not configured blocks publication', () => {
    // The customer would pick it and the server would refuse the order.
    const html = GOOD_FORM.replace('value="5kg"', 'value="10kg"');
    expect(errors(validateContract(parseContract(html), PAGE))).toContain('UNKNOWN_OFFER_KEY');
  });

  test('a zone key in the HTML that is not configured blocks publication', () => {
    const html = GOOD_FORM.replace('value="inside-dhaka"', 'value="mars"');
    expect(errors(validateContract(parseContract(html), PAGE))).toContain('UNKNOWN_ZONE_KEY');
  });

  test('a page with no active offers blocks publication', () => {
    const issues = validateContract(parseContract(GOOD_FORM), { ...PAGE, offers: [] });
    expect(errors(issues)).toContain('NO_OFFERS');
  });

  test('several offers with no offer input blocks publication', () => {
    const html = GOOD_FORM.replace(/<select name="offer">[\s\S]*?<\/select>/, '');
    expect(errors(validateContract(parseContract(html), PAGE))).toContain('NO_OFFER_INPUT');
  });

  test('a SINGLE offer needs no picker', () => {
    const html = GOOD_FORM.replace(/<select name="offer">[\s\S]*?<\/select>/, '');
    const page = { ...PAGE, offers: [PAGE.offers[0]] };
    expect(errors(validateContract(parseContract(html), page))).toEqual([]);
  });

  test('an inactive offer does not count towards the picker requirement', () => {
    const html = GOOD_FORM.replace(/<select name="offer">[\s\S]*?<\/select>/, '');
    const page = { ...PAGE, offers: [PAGE.offers[0], { ...PAGE.offers[1], isActive: false }] };
    expect(errors(validateContract(parseContract(html), page))).toEqual([]);
  });
});

describe('validateContract — what only warns', () => {
  test('a configured offer missing from the HTML warns but does not block', () => {
    const html = GOOD_FORM.replace(/<option value="5kg">.*?<\/option>/, '');
    const issues = validateContract(parseContract(html), PAGE);

    expect(codes(issues)).toContain('OFFER_NOT_IN_HTML');
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  test('no success panel warns but does not block', () => {
    const html = GOOD_FORM.replace('<div data-hisaab="success" hidden></div>', '');
    const issues = validateContract(parseContract(html), PAGE);

    expect(codes(issues)).toContain('NO_SUCCESS_PANEL');
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  test('several zones with no zone input warns — the first is always used', () => {
    const html = GOOD_FORM.replace(/<select name="zone">[\s\S]*?<\/select>/, '');
    const page = {
      ...PAGE,
      delivery: { zones: [...PAGE.delivery.zones, { key: 'outside-dhaka', name: 'বাইরে', charge: 120, isActive: true }] },
    };
    const issues = validateContract(parseContract(html), page);

    expect(codes(issues)).toContain('NO_ZONE_INPUT');
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  test('every message carries Bengali the admin can act on', () => {
    const issues = validateContract(parseContract('<h1>x</h1>'), PAGE);
    for (const issue of issues) {
      expect(typeof issue.messageBn).toBe('string');
      expect(issue.messageBn.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The pasted document survives storage, and what it reaches for is reported.
 *
 * These tests pin the reversal described in `landingDocument.util`: scripts and
 * stylesheet links used to be stripped on save, which left a Tailwind-from-a-CDN
 * design as a white page with invisible text. They are now KEPT — the public
 * render path frames the document in an opaque origin instead — and the hosts
 * they come from are surfaced to the admin as warnings.
 *
 * The security assertion that matters is therefore no longer "the bytes are
 * inert". It is "we can still say what the bytes will do", which is what
 * `describeExternalHosts` answers.
 */

const {
  prepareLandingDocument,
  describeExternalHosts,
  isFullDocument,
  hostOf,
} = require('../utils/landingDocument.util');

const PASTED = `<!doctype html>
<html lang="bn">
<head>
  <title>আম ২০২৬</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { theme: { extend: { colors: { brand: '#f16334' } } } };</script>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hind+Siliguri">
  <style>.reveal { opacity: 0; } .reveal.active { opacity: 1; }</style>
</head>
<body class="bg-secondary text-white">
  <section class="reveal"><h1 class="text-brand">প্রিমিয়াম আম</h1></section>
  <form data-hisaab="order-form">
    <input name="customerName"><input name="phone"><textarea name="address"></textarea>
    <button data-hisaab="submit">অর্ডার</button>
  </form>
</body>
</html>`;

describe('the design survives the save', () => {
  test('the CDN script that the whole design depends on is kept', () => {
    const { html } = prepareLandingDocument(PASTED);
    expect(html).toContain('cdn.tailwindcss.com');
    // The inline config carries the custom colours — `text-brand` is nothing
    // without it.
    expect(html).toContain('tailwind.config');
  });

  test('stylesheet links, <style>, <head> and classes all survive', () => {
    const { html } = prepareLandingDocument(PASTED);
    expect(html).toContain('fonts.googleapis.com');
    expect(html).toContain('.reveal.active');
    expect(html).toContain('<head>');
    expect(html).toContain('class="text-brand"');
  });

  test('<base> is removed — it re-points every relative URL, the form included', () => {
    const { html, notes } = prepareLandingDocument(
      '<html><head><base href="https://elsewhere.example/"></head><body>x</body></html>'
    );
    expect(html).not.toMatch(/<base/i);
    expect(notes.strippedBase).toBe(1);
  });

  test('a fragment saved before this change is left alone and still reads as a fragment', () => {
    const { html, notes } = prepareLandingDocument('<section><h1>আম</h1></section>');
    expect(html).toBe('<section><h1>আম</h1></section>');
    expect(notes.isDocument).toBe(false);
  });

  test('empty and non-string input do not throw', () => {
    expect(prepareLandingDocument('').html).toBe('');
    expect(prepareLandingDocument(null).html).toBe('');
    expect(prepareLandingDocument(undefined).notes.isDocument).toBe(false);
  });
});

describe('what the document reaches for is reported', () => {
  test('every off-origin host is named, grouped by what pulls it in', () => {
    const hosts = describeExternalHosts(PASTED);
    expect(hosts.scripts).toEqual(['cdn.tailwindcss.com']);
    expect(hosts.styles).toEqual(['fonts.googleapis.com']);
    expect(hosts.frames).toEqual([]);
  });

  test('our own bucket is not reported — it is not a third party', () => {
    const html = '<img src="https://pub-abc.r2.dev/a.webp"><img src="https://cdn.other.example/b.jpg">';
    const hosts = describeExternalHosts(html, { ownHosts: ['pub-abc.r2.dev'] });
    expect(hosts.images).toEqual(['cdn.other.example']);
  });

  test('relative URLs resolve to us and are not reported', () => {
    expect(describeExternalHosts('<img src="/hero.webp">').images).toEqual([]);
    expect(hostOf('/hero.webp')).toBeNull();
  });

  test('a protocol-relative URL is NOT mistaken for a relative one', () => {
    // `//evil.example/x.js` is a third-party script that merely looks local.
    expect(describeExternalHosts('<script src="//evil.example/x.js"></script>').scripts)
      .toEqual(['evil.example']);
  });

  test('one host used ten times is named once', () => {
    const html = Array.from({ length: 10 }, () => '<img src="https://cdn.example/a.jpg">').join('');
    expect(describeExternalHosts(html).images).toEqual(['cdn.example']);
  });
});

describe('isFullDocument', () => {
  test('tells a whole document from a fragment', () => {
    expect(isFullDocument(PASTED)).toBe(true);
    expect(isFullDocument('<div>hi</div>')).toBe(false);
    // Not fooled by the word appearing in text or in an unrelated attribute.
    expect(isFullDocument('<p>the html document</p>')).toBe(false);
  });
});

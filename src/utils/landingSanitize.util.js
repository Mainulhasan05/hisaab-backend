/**
 * Sanitise admin-authored landing page HTML for INLINE rendering.
 *
 * ── NOT ON THE PUBLIC PATH ANY MORE ─────────────────────────────────────────
 *
 * `/p/<slug>` now serves the pasted document from its own URL and frames it with
 * `sandbox` and no `allow-same-origin`, so the document runs in an opaque origin
 * and its scripts are kept — see `landingDocument.util` for why that is both
 * safe for us and necessary for the feature to work at all. The save path calls
 * `prepareLandingDocument`, not this.
 *
 * This module stays because the policy it encodes is the right one for anything
 * that renders landing HTML *inside one of our own documents*, and because that
 * is an easy mistake to make later. If you are about to `dangerouslySetInnerHTML`
 * a landing page, this — not the stored bytes — is what makes it safe.
 *
 * This is the largest new attack surface the platform has ever taken on: raw
 * HTML, possibly written by a language model, served from `hisaab.bd` to
 * strangers who clicked an advertisement.
 *
 * ── SANITISED ON WRITE, NOT ON READ (I-15) ──────────────────────────────────
 *
 * A stored document must never be dangerous. Sanitising on render means every
 * future read path — a preview, an export, an email, a debug endpoint — has to
 * remember to do it, and the one that forgets is the one that ships. So the
 * bytes in `LandingPage.html` are already safe, and the render path is dumb.
 *
 * ── WHY `<style>` AND `style=` ARE ALLOWED WHEN ALMOST NOTHING ELSE IS ──────
 *
 * A bought or generated design is mostly CSS. Stripping it would leave an
 * unstyled document and defeat the feature, so CSS is allowed — and then filtered
 * for the two things CSS can actually do to us:
 *
 *   `@import`  — pulls in a stylesheet from a host we do not control, which is
 *                both a tracking beacon and a way to change the page after
 *                review.
 *   `url(...)` — the classic CSS exfiltration channel: an attribute selector
 *                plus a background image sends form contents to a third party
 *                one character at a time.
 *
 * Both are rewritten rather than refused, because refusing a whole page for one
 * font import means an admin editing generated CSS by hand at midnight.
 *
 * ── WHAT IS NOT DEFENDED HERE ───────────────────────────────────────────────
 *
 * This function is one of three layers, and it is not the last one. The public
 * route serves its own CSP (`script-src 'self'`, `form-action 'none'`), and the
 * page is never rendered inside an authenticated admin or shop route — preview
 * is an iframe pointed at the public URL. A gap here should be closed here, but
 * it is not a single point of failure.
 */

const sanitizeHtml = require('sanitize-html');

/**
 * Hosts an `<iframe>` may point at.
 *
 * Video is the only legitimate embed on a landing page, and an unrestricted
 * iframe is a full bypass of everything above — it renders a document we do not
 * control, with its own scripts, inside our origin's visual frame.
 */
const IFRAME_HOSTS = Object.freeze([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'player.vimeo.com',
  'www.facebook.com',
  'web.facebook.com',
]);

/** Hosts a `src`, `href` or CSS `url()` may resolve to, beyond our own R2. */
const ASSET_HOSTS = Object.freeze([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

const ALLOWED_TAGS = Object.freeze([
  // Structure
  'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'figcaption',
  // Text
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'u', 's',
  'small', 'mark', 'sub', 'sup', 'blockquote', 'cite', 'q', 'abbr', 'time', 'code', 'pre',
  'br', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Media
  'img', 'picture', 'source', 'video', 'iframe',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Interactive — the order form lives here
  'a', 'form', 'label', 'input', 'select', 'option', 'optgroup', 'textarea', 'button',
  'details', 'summary',
  // Presentation
  'style', 'svg', 'path', 'g', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'title',
]);

/**
 * SVG tags that are deliberately absent from the list above.
 *
 * `use` can reference an external document; `foreignObject` embeds arbitrary
 * HTML inside SVG and is a well-known sanitiser bypass; `script` and
 * `animate`/`set` can carry or trigger execution. Icons need none of them.
 */
const REJECTED_SVG = Object.freeze(['use', 'foreignObject', 'script', 'animate', 'set', 'handler']);

const sanitizeOptions = {
  allowedTags: [...ALLOWED_TAGS],

  allowedAttributes: {
    // `data-*` is what makes the whole contract work — strip it and the page
    // renders but takes no orders (§5.2). `class`, `id` and `style` carry the
    // design. Everything else is per-tag below.
    '*': ['class', 'id', 'style', 'title', 'role', 'aria-*', 'data-*', 'hidden', 'lang', 'dir'],
    a: ['href', 'target', 'rel', 'download'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    source: ['src', 'srcset', 'sizes', 'type', 'media'],
    video: ['src', 'poster', 'width', 'height', 'controls', 'autoplay', 'muted', 'loop', 'playsinline', 'preload'],
    iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'loading', 'title', 'sandbox', 'referrerpolicy'],
    form: ['id', 'novalidate'],
    input: ['type', 'name', 'value', 'placeholder', 'required', 'checked', 'min', 'max', 'step', 'maxlength', 'pattern', 'inputmode', 'autocomplete'],
    select: ['name', 'required', 'multiple'],
    option: ['value', 'selected', 'disabled', 'label'],
    textarea: ['name', 'placeholder', 'required', 'rows', 'cols', 'maxlength'],
    button: ['type', 'disabled', 'value'],
    label: ['for'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    col: ['span'],
    time: ['datetime'],
    svg: ['viewbox', 'viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'width', 'height', 'preserveAspectRatio'],
    path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'opacity'],
    g: ['fill', 'stroke', 'transform', 'opacity', 'clip-path'],
    circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'opacity'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'opacity'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'opacity'],
    line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width'],
    polyline: ['points', 'fill', 'stroke', 'stroke-width'],
    polygon: ['points', 'fill', 'stroke', 'stroke-width'],
    linearGradient: ['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits'],
    radialGradient: ['id', 'cx', 'cy', 'r', 'gradientUnits'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    clipPath: ['id'],
  },

  // `javascript:` is the obvious one. `data:` is excluded deliberately too: a
  // base64 image inflates the document past its size cap and is a known vector
  // in older engines, and every real image here belongs in the media library.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'srcset', 'cite', 'poster'],
  allowProtocolRelative: false,

  // Required by sanitize-html before it will keep `<style>`. The CSS that
  // survives is filtered by `filterCss` below; see the header for why allowing
  // it at all is the right call.
  allowVulnerableTags: true,

  // Keep every class — the design's entire layout depends on them.
  allowedClasses: false,

  // Everything inside a dropped tag goes with it. The default keeps the text,
  // which for a stripped `<script>` means its source code rendered as prose.
  nonTextTags: ['script', 'textarea', 'noscript', 'style'],

  transformTags: {
    /** Submission is ours. An `action` here would post a stranger's data offsite. */
    form: (tagName, attribs) => ({
      tagName,
      attribs: stripKeys(attribs, ['action', 'method', 'target', 'enctype']),
    }),

    /** Same, from the other direction: a button can carry its own `formaction`. */
    button: (tagName, attribs) => ({
      tagName,
      attribs: stripKeys(attribs, ['formaction', 'formmethod', 'formtarget']),
    }),
    input: (tagName, attribs) => ({
      tagName,
      attribs: stripKeys(attribs, ['formaction', 'formmethod', 'formtarget']),
    }),

    /**
     * An off-host link opened with `target="_blank"` hands the opened page a
     * `window.opener` reference to ours. Modern browsers imply `noopener`, older
     * ones on the phones this traffic arrives from do not.
     */
    a: (tagName, attribs) => {
      const out = { ...attribs };
      if (out.target === '_blank') out.rel = 'noopener noreferrer';
      return { tagName, attribs: out };
    },

    // `iframe` is not here: it needs to record what it rejected, so it is built
    // per-call inside `sanitizeLandingHtml` where the notes object is in scope.
  },

  /**
   * The CSS filter, applied to `<style>` bodies.
   *
   * `nonTextTags` above removes `<style>` content wholesale, so the tag is
   * re-admitted here through `textFilter` instead — see `sanitizeLandingHtml`.
   */
  textFilter: (text) => text,
};

/** Drop a set of attribute names, case-insensitively. */
function stripKeys(attribs, keys) {
  const lower = keys.map((k) => k.toLowerCase());
  const out = {};
  for (const [k, v] of Object.entries(attribs || {})) {
    if (!lower.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Is this URL's host one we are willing to frame? */
function isAllowedIframe(src) {
  const host = hostOf(src);
  return Boolean(host) && IFRAME_HOSTS.includes(host);
}

function hostOf(url) {
  try {
    return new URL(String(url), 'https://placeholder.invalid').hostname.toLowerCase();
  } catch (err) {
    return null;
  }
}

/**
 * May a `url()` or `src` point here?
 *
 * Our own R2 hosts are discovered at call time rather than hard-coded, because
 * the bucket's public hostname changes when the custom domain lands
 * (R2_STORAGE_PLAN.md §৭.৩) and a constant here would silently start rewriting
 * every image the day it does.
 */
function isAllowedAssetUrl(url, ownHosts = []) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  // Relative URLs resolve against our own origin, which is always fine.
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;

  const host = hostOf(raw);
  if (!host) return false;
  return ownHosts.includes(host) || ASSET_HOSTS.includes(host);
}

/**
 * Strip the two things CSS can do to us, and report what was stripped.
 *
 * Not a CSS parser — a targeted rewrite. A full parser would be more precise and
 * would also be a second place for a bypass to hide; these two constructs are
 * the whole of the risk, and both are recognisable without one.
 */
function filterCss(css, ownHosts = []) {
  const notes = [];
  let out = String(css || '');

  out = out.replace(/@import[^;]*;?/gi, () => {
    notes.push('@import');
    return '';
  });

  // `expression()` and `behavior:` are legacy IE execution vectors. Cheap to
  // remove and there is no legitimate use in a 2026 landing page.
  out = out.replace(/expression\s*\(/gi, () => { notes.push('expression()'); return 'none('; });
  out = out.replace(/behavior\s*:/gi, () => { notes.push('behavior'); return 'x-behavior:'; });

  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    if (isAllowedAssetUrl(url, ownHosts)) return match;
    notes.push(url.slice(0, 120));
    return 'none';
  });

  return { css: out, notes };
}

/**
 * Sanitise one landing page.
 *
 * @param {string} html
 * @param {Object} [options]
 * @param {string[]} [options.ownHosts]  hostnames of our own R2 public base URLs
 * @returns {{ html: string, notes: { rejectedIframes: string[], strippedCss: string[], externalImages: string[] } }}
 */
function sanitizeLandingHtml(html, { ownHosts = [] } = {}) {
  const notes = { rejectedIframes: [], strippedCss: [], externalImages: [] };
  const hosts = ownHosts.map((h) => String(h).toLowerCase()).filter(Boolean);

  const options = {
    ...sanitizeOptions,
    transformTags: {
      ...sanitizeOptions.transformTags,
      // `<style>` bodies are pulled out, filtered and put back. Doing it through
      // sanitize-html's own text handling is not possible while `style` is in
      // `nonTextTags`, and taking it out of that list would let a dropped
      // `<style>` leak its declarations into the document as visible text.
      style: (tagName, attribs) => ({ tagName, attribs }),

      /**
       * Refuse the iframe rather than the whole page when the host is not
       * whitelisted, and record WHICH one — silently vanishing content is how
       * an author concludes the editor is broken.
       *
       * The rejected URL goes into `notes`, never into the stored document. An
       * earlier version parked it in a `data-hisaab-rejected` attribute so a
       * later regex could scrape it back out; that left an attacker-supplied
       * URL sitting in the saved HTML forever, for no benefit. Closing over
       * `notes` here is both simpler and cleaner.
       */
      iframe: (tagName, attribs) => {
        if (!isAllowedIframe(attribs.src)) {
          notes.rejectedIframes.push(String(attribs.src || '').slice(0, 200));
          return { tagName: 'div', attribs: {} };
        }
        return {
          tagName,
          attribs: {
            ...attribs,
            // Applied unconditionally: a whitelisted host is still a document
            // we do not control.
            sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups',
            referrerpolicy: 'no-referrer',
            loading: attribs.loading || 'lazy',
          },
        };
      },
    },
  };

  // Pre-pass: filter every <style> body before sanitize-html sees the document,
  // so what it stores is already clean.
  const preFiltered = String(html || '').replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (match, attrs, css) => {
      const { css: clean, notes: cssNotes } = filterCss(css, hosts);
      notes.strippedCss.push(...cssNotes);
      return `<style${attrs}>${clean}</style>`;
    }
  );

  const withStyleKept = {
    ...options,
    nonTextTags: sanitizeOptions.nonTextTags.filter((t) => t !== 'style'),
  };

  let out = sanitizeHtml(preFiltered, withStyleKept);

  // Post-pass: inline `style="..."` attributes get the same CSS filter. They
  // survive sanitize-html untouched because `allowedStyles` is not set, which is
  // deliberate — whitelisting properties would break arbitrary designs.
  out = out.replace(/\sstyle="([^"]*)"/gi, (match, css) => {
    const { css: clean, notes: cssNotes } = filterCss(css, hosts);
    notes.strippedCss.push(...cssNotes);
    return ` style="${clean}"`;
  });

  // Images hosted elsewhere are KEPT but reported. Removing them would break a
  // page at save time over something that currently works; naming them lets the
  // admin move the file into the library before that other server goes down.
  for (const [, src] of out.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
    if (!isAllowedAssetUrl(src, hosts)) notes.externalImages.push(src.slice(0, 200));
  }

  return { html: out, notes };
}

module.exports = {
  sanitizeLandingHtml,
  filterCss,
  isAllowedIframe,
  isAllowedAssetUrl,
  hostOf,
  IFRAME_HOSTS,
  ASSET_HOSTS,
  ALLOWED_TAGS,
  REJECTED_SVG,
};

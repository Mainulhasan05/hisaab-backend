/**
 * Prepare a pasted landing page document for storage.
 *
 * ── WHY THIS EXISTS BESIDE `landingSanitize.util` ───────────────────────────
 *
 * The original design rendered authored HTML INLINE, in our own document, which
 * made sanitising on write the only defensible option (I-15): a `<script>` in
 * that position runs with our origin, our cookies and our DOM. So scripts,
 * `<link>`, `<head>` and every foreign iframe were stripped.
 *
 * That is a coherent policy and it defeated the feature. What an admin actually
 * pastes is a whole document — almost always Tailwind-from-a-CDN plus a little
 * JavaScript for scroll reveals — and stripping the script tags left a page
 * whose classes resolved to nothing and whose `.reveal { opacity: 0 }` rules
 * never got their `.active`. The result was a white screen with invisible text,
 * which is worse than a refusal because it looks like it worked.
 *
 * The render path changed instead: the document is now served from its own URL
 * and framed with `sandbox` and NO `allow-same-origin`, so it lives in an opaque
 * origin. It cannot read our cookies, our storage or our DOM, and it cannot
 * navigate the top frame. Scripts inside it are then no more dangerous to us
 * than any other page on the internet, so they are kept — and the design works.
 *
 * ── WHAT IS STILL REMOVED, AND WHY SO LITTLE ────────────────────────────────
 *
 * Only `<base>`. It re-points every relative URL in the document, including the
 * form our own runtime binds, and nothing a design needs depends on it.
 *
 * Everything else is REPORTED rather than removed (`describeExternalHosts`), and
 * surfaces in the editor's contract report as warnings. The admin pasting the
 * document is the platform operator; what they need is to be told that the page
 * they just pasted loads code from `cdn.example.com`, not to have it silently
 * deleted and be left wondering why the design is gone.
 *
 * ── WHAT THE SANDBOX DOES NOT COVER ─────────────────────────────────────────
 *
 * It protects US. It does not protect the CUSTOMER from the document: a paste
 * carrying an exfiltration snippet can still read what the customer types into
 * the order form and send it to a third party. That risk is accepted knowingly
 * and is why the host inventory is shown at publish time — an unexpected host in
 * that list is the signal.
 */

/** Tags whose `src`/`href` tells us the document reaches off-origin. */
const HOST_PATTERNS = Object.freeze([
  { key: 'scripts', re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi },
  { key: 'styles', re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi },
  { key: 'frames', re: /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi },
  { key: 'images', re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi },
]);

/** Is this a whole document, or a fragment to be wrapped in one? */
function isFullDocument(html) {
  return /<html[\s>]/i.test(String(html || ''));
}

function hostOf(url) {
  try {
    const raw = String(url || '').trim();
    // Relative URLs resolve against the page's own origin, which is ours.
    if (!raw || (raw.startsWith('/') && !raw.startsWith('//'))) return null;
    return new URL(raw, 'https://placeholder.invalid').hostname.toLowerCase();
  } catch (err) {
    return null;
  }
}

/**
 * Every off-origin host the document reaches for, grouped by what pulls it in.
 *
 * Deliberately a scan of the stored bytes rather than a parse: it runs on every
 * save and at publish time, and the answer only has to be good enough to put a
 * hostname in front of an admin.
 *
 * @returns {{ scripts: string[], styles: string[], frames: string[], images: string[] }}
 */
function describeExternalHosts(html, { ownHosts = [] } = {}) {
  const source = String(html || '');
  const ours = ownHosts.map((h) => String(h).toLowerCase()).filter(Boolean);
  const out = { scripts: [], styles: [], frames: [], images: [] };

  for (const { key, re } of HOST_PATTERNS) {
    const seen = new Set();
    for (const [, url] of source.matchAll(re)) {
      const host = hostOf(url);
      if (!host || ours.includes(host) || seen.has(host)) continue;
      seen.add(host);
      out[key].push(host);
    }
  }

  return out;
}

/**
 * Store what was pasted.
 *
 * @param {string} html
 * @param {Object} [options]
 * @param {string[]} [options.ownHosts]  hostnames of our own R2 public base URLs
 * @returns {{ html: string, notes: Object }}
 */
function prepareLandingDocument(html, { ownHosts = [] } = {}) {
  const notes = { strippedBase: 0, externalHosts: null, isDocument: false };

  let out = String(html || '');

  out = out.replace(/<base\b[^>]*>/gi, () => {
    notes.strippedBase += 1;
    return '';
  });

  notes.isDocument = isFullDocument(out);
  notes.externalHosts = describeExternalHosts(out, { ownHosts });

  return { html: out, notes };
}

module.exports = {
  prepareLandingDocument,
  describeExternalHosts,
  isFullDocument,
  hostOf,
};

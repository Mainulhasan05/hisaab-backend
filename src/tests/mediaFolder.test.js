/**
 * The pure half of `mediaFolder.service` — the parts that decide something.
 *
 * `planMove` and `rollUpUsage` are extracted precisely because they are the two
 * places this feature can be wrong without failing: a move that quietly buries a
 * subtree past the depth cap, or a storage screen whose folder totals do not add
 * up to what the pool actually holds. Neither throws on its own.
 *
 * `slugify` is here because a folder whose name is Bengali — which is the normal
 * case for this platform — must still produce a usable ASCII path segment.
 */

const {
  slugify,
  escapeRegex,
  planMove,
  rollUpUsage,
} = require('../services/mediaFolder.service');

const MAX_DEPTH = 2; // three levels, matching MediaFolder.MAX_DEPTH

const folder = (over = {}) => ({
  _id: 'f1',
  slug: 'aam-2026',
  path: '/aam-2026',
  depth: 0,
  parent: null,
  ...over,
});

describe('slugify', () => {
  test('an English name becomes a clean segment', () => {
    expect(slugify('Aam 2026')).toBe('aam-2026');
    expect(slugify('  Hero   Images  ')).toBe('hero-images');
  });

  test('punctuation collapses rather than surviving', () => {
    expect(slugify('Eid!! Offer -- 2026')).toBe('eid-offer-2026');
  });

  test('a Bengali name yields nothing, and that is not an error', () => {
    // The caller falls back to 'folder', 'folder-2', … — `name` is the label and
    // `slug` is only the path segment, so this must not throw or produce mojibake.
    expect(slugify('আমের সিজন')).toBe('');
  });

  test('the result never starts or ends with a hyphen', () => {
    expect(slugify('---abc---')).toBe('abc');
    expect(slugify('!!!')).toBe('');
  });

  test('length is bounded, and truncation cannot leave a trailing hyphen', () => {
    const out = slugify(`${'a'.repeat(63)} b`);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('escapeRegex', () => {
  test('a path with regex metacharacters is neutralised', () => {
    // Paths are ASCII by construction, but this guards the prefix queries that
    // drive `subtreeIds` and the move rewrite — a stray metacharacter there
    // would match the wrong subtree, not merely fail.
    const escaped = escapeRegex('/a+b(c)');
    expect(new RegExp(`^${escaped}$`).test('/a+b(c)')).toBe(true);
    expect(new RegExp(`^${escaped}$`).test('/aab c')).toBe(false);
  });
});

describe('planMove — refusals', () => {
  test('a folder cannot be moved into itself', () => {
    const f = folder();
    expect(() => planMove(f, f, [], MAX_DEPTH)).toThrow(/into itself/i);
  });

  test('a folder cannot be moved into its own child', () => {
    const f = folder();
    const child = { _id: 'f2', path: '/aam-2026/hero', depth: 1 };
    expect(() => planMove(f, child, [child], MAX_DEPTH)).toThrow(/subfolder/i);
  });

  test('a folder cannot be moved into its own grandchild', () => {
    const f = folder();
    const grandchild = { _id: 'f3', path: '/aam-2026/hero/mobile', depth: 2 };
    expect(() => planMove(f, grandchild, [grandchild], MAX_DEPTH)).toThrow(/subfolder/i);
  });

  test('a sibling whose path merely SHARES A PREFIX is not a descendant', () => {
    // '/aam-2026-old' starts with '/aam-2026' as a string but is not inside it.
    // Testing the prefix without the trailing slash would refuse this move.
    const f = folder();
    const sibling = { _id: 'f9', path: '/aam-2026-old', depth: 0 };
    expect(() => planMove(f, sibling, [], MAX_DEPTH)).not.toThrow();
  });
});

describe('planMove — the depth cap is measured on the deepest descendant', () => {
  test('REGRESSION: a two-level subtree may not be moved one level down', () => {
    // The moved folder would land at depth 1, comfortably inside the cap — but
    // its grandchild would land at depth 3. Checking only the moved folder's own
    // new depth lets this through and buries the leaves.
    const f = folder({ depth: 0 });
    const descendants = [{ depth: 1 }, { depth: 2 }];
    const target = { _id: 'x', path: '/other', depth: 0 };

    expect(() => planMove(f, target, descendants, MAX_DEPTH)).toThrow(/levels|স্তর/);
  });

  test('the same subtree moves freely to the root', () => {
    const f = folder({ depth: 1, path: '/other/aam-2026', parent: 'x' });
    const descendants = [{ depth: 2 }];
    const plan = planMove(f, null, descendants, MAX_DEPTH);

    expect(plan.newDepth).toBe(0);
    expect(plan.shift).toBe(-1);
    expect(plan.newPath).toBe('/aam-2026');
  });

  test('a leaf folder may be moved to the deepest allowed level', () => {
    const f = folder({ depth: 0 });
    const target = { _id: 'x', path: '/a/b', depth: 1 };
    const plan = planMove(f, target, [], MAX_DEPTH);

    expect(plan.newDepth).toBe(MAX_DEPTH);
    expect(plan.newPath).toBe('/a/b/aam-2026');
  });

  test('and not past it', () => {
    const f = folder({ depth: 0 });
    const target = { _id: 'x', path: '/a/b/c', depth: 2 };
    expect(() => planMove(f, target, [], MAX_DEPTH)).toThrow(/levels|স্তর/);
  });
});

describe('rollUpUsage', () => {
  const tree = [
    { _id: 'a', parent: null, depth: 0, path: '/a' },
    { _id: 'b', parent: 'a', depth: 1, path: '/a/b' },
    { _id: 'c', parent: 'b', depth: 2, path: '/a/b/c' },
    { _id: 'd', parent: null, depth: 0, path: '/d' },
  ];

  const find = (out, id) => out.folders.find((f) => String(f._id) === id);

  test('own totals are per folder, cumulative totals include the subtree', () => {
    const out = rollUpUsage(tree, [
      { _id: 'a', bytes: 100, files: 1 },
      { _id: 'b', bytes: 200, files: 2 },
      { _id: 'c', bytes: 400, files: 4 },
      { _id: 'd', bytes: 50, files: 1 },
    ]);

    expect(find(out, 'c').totalBytes).toBe(400);
    expect(find(out, 'b').totalBytes).toBe(600);
    expect(find(out, 'a').totalBytes).toBe(700);
    expect(find(out, 'a').ownBytes).toBe(100);
    expect(find(out, 'd').totalBytes).toBe(50);
  });

  test('REGRESSION: a grandchild is counted once, not once per ancestor', () => {
    const out = rollUpUsage(tree, [{ _id: 'c', bytes: 1000, files: 1 }]);

    expect(find(out, 'a').totalBytes).toBe(1000);
    expect(find(out, 'a').totalFiles).toBe(1);
  });

  test('files outside every folder surface at the root instead of vanishing', () => {
    const out = rollUpUsage(tree, [
      { _id: null, bytes: 900, files: 3 },
      { _id: 'a', bytes: 100, files: 1 },
    ]);

    expect(out.root.ownBytes).toBe(900);
    expect(out.root.ownFiles).toBe(3);
    expect(find(out, 'a').totalBytes).toBe(100);
  });

  test('a folder with no files reports zeroes rather than undefined', () => {
    const out = rollUpUsage(tree, []);
    expect(find(out, 'a').ownBytes).toBe(0);
    expect(find(out, 'a').totalBytes).toBe(0);
    expect(out.root.ownBytes).toBe(0);
  });

  test('bytes under a folder whose parent is missing are not silently dropped', () => {
    // 'b' points at a parent that is not in the list. Its bytes must still be
    // reported on 'b' itself — losing them would make the screen's totals
    // disagree with the pool for a reason nobody could see.
    const orphaned = [{ _id: 'b', parent: 'gone', depth: 1, path: '/gone/b' }];
    const out = rollUpUsage(orphaned, [{ _id: 'b', bytes: 250, files: 2 }]);

    expect(find(out, 'b').totalBytes).toBe(250);
  });
});

/**
 * `utils/crypto.util` — the thing standing between a Mongo dump and someone
 * else's DeleteObject rights on every shop's product photos.
 *
 * The tests that matter here are the failure ones. Round-tripping a string is
 * table stakes; what must never happen is a silent fallback that stores the
 * plaintext, or a tampered blob decrypting to something usable.
 */

const crypto = require('crypto');
const {
  encrypt,
  decrypt,
  isEncrypted,
  isConfigured,
  mask,
  VERSION,
} = require('../utils/crypto.util');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

const withKey = (key, fn) => {
  const previous = process.env.STORAGE_ENC_KEY;
  if (key === null) delete process.env.STORAGE_ENC_KEY;
  else process.env.STORAGE_ENC_KEY = key;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.STORAGE_ENC_KEY;
    else process.env.STORAGE_ENC_KEY = previous;
  }
};

describe('round trip', () => {
  it('returns the original string', () => {
    withKey(KEY_A, () => {
      const secret = 'a1b2c3d4e5f6g7h8i9j0-r2-secret-access-key';
      expect(decrypt(encrypt(secret))).toBe(secret);
    });
  });

  it('produces a different ciphertext every time (random IV)', () => {
    withKey(KEY_A, () => {
      const a = encrypt('same input');
      const b = encrypt('same input');
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(decrypt(b));
    });
  });

  it('handles unicode', () => {
    withKey(KEY_A, () => {
      expect(decrypt(encrypt('দোকান-কী-১২৩'))).toBe('দোকান-কী-১২৩');
    });
  });

  it('emits the versioned four-part format', () => {
    withKey(KEY_A, () => {
      const parts = encrypt('x').split(':');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe(VERSION);
    });
  });
});

describe('it fails loudly rather than leaking plaintext', () => {
  it('throws when the key is absent — never returns the input', () => {
    withKey(null, () => {
      expect(() => encrypt('secret')).toThrow(/STORAGE_ENC_KEY/);
    });
  });

  it('throws when the key is malformed', () => {
    withKey('not-hex', () => {
      expect(() => encrypt('secret')).toThrow(/STORAGE_ENC_KEY/);
    });
    withKey('abc123', () => {
      expect(() => encrypt('secret')).toThrow(/STORAGE_ENC_KEY/);
    });
  });

  it('rejects an empty payload instead of storing an empty blob', () => {
    withKey(KEY_A, () => {
      expect(() => encrypt('')).toThrow();
      expect(() => encrypt(null)).toThrow();
    });
  });
});

describe('authentication', () => {
  it('refuses a ciphertext encrypted under a different key', () => {
    const blob = withKey(KEY_A, () => encrypt('secret'));
    withKey(KEY_B, () => {
      expect(() => decrypt(blob)).toThrow(/STORAGE_ENC_KEY has changed|corrupt/);
    });
  });

  it('refuses a tampered ciphertext (GCM tag)', () => {
    withKey(KEY_A, () => {
      const parts = encrypt('secret').split(':');
      // flip a nibble in the payload
      const flipped = parts[3].slice(0, -1) + (parts[3].slice(-1) === '0' ? '1' : '0');
      expect(() => decrypt([parts[0], parts[1], parts[2], flipped].join(':'))).toThrow();
    });
  });

  it('refuses an unversioned / malformed blob', () => {
    withKey(KEY_A, () => {
      expect(() => decrypt('plaintext-key')).toThrow(/Unrecognised/);
      expect(() => decrypt('v9:a:b:c')).toThrow(/Unrecognised/);
    });
  });
});

describe('isEncrypted — tolerating a half-migrated collection', () => {
  it('recognises our own output', () => {
    withKey(KEY_A, () => expect(isEncrypted(encrypt('x'))).toBe(true));
  });

  it('reads a legacy plaintext secret as not-encrypted rather than corrupt', () => {
    expect(isEncrypted('AKIAIOSFODNN7EXAMPLE')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});

describe('isConfigured', () => {
  it('is false without a usable key and true with one', () => {
    withKey(null, () => expect(isConfigured()).toBe(false));
    withKey('short', () => expect(isConfigured()).toBe(false));
    withKey(KEY_A, () => expect(isConfigured()).toBe(true));
  });
});

describe('mask', () => {
  it('shows only the ends of a long secret', () => {
    const masked = mask('abcdefghijklmnopqrstuvwxyz');
    expect(masked).toBe('abcd••••••••wxyz');
    expect(masked).not.toContain('ijklmnop');
  });

  it('fully masks a short secret rather than revealing most of it', () => {
    expect(mask('short')).toBe('••••••••');
    expect(mask('123456789012')).toBe('••••••••');
  });

  it('is empty-safe', () => {
    expect(mask('')).toBe('');
    expect(mask(null)).toBe('');
  });
});

/**
 * Symmetric encryption for secrets that must live in MongoDB.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `GeminiKey.apiKey` is stored in plaintext. That was tolerable-ish: leaking a
 * Gemini key costs quota. An R2 secret access key is a different animal — it
 * grants DeleteObject on a bucket holding every shop's product photos, and a
 * Mongo dump (backup, screen-share, compromised read-only user) hands that over
 * with no further work. So R2 credentials are encrypted at rest and the
 * plaintext exists only inside `storage.service` at the moment a client is
 * constructed.
 *
 * AES-256-GCM, not CBC: GCM is authenticated, so a tampered ciphertext fails
 * loudly at decrypt instead of yielding garbage bytes that then get sent to
 * Cloudflare as a credential.
 *
 * ── FORMAT ───────────────────────────────────────────────────────────────────
 *   v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>
 *
 * The `v1` prefix is not decoration. When the key is rotated or the algorithm
 * changes, `decrypt` must be able to tell an old blob from a new one; without a
 * version marker the only way to find out is to try and fail. It also makes an
 * encrypted value obvious at a glance in Compass.
 *
 * ── THE KEY ──────────────────────────────────────────────────────────────────
 * `STORAGE_ENC_KEY`, 64 hex chars (32 bytes). Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Losing it means every stored R2 credential is unrecoverable — they must be
 * re-entered from the Cloudflare dashboard. It is NOT derived from JWT_SECRET
 * on purpose: rotating a JWT secret is a routine security action and must not
 * silently brick storage.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;   // GCM standard; 12 bytes is what every implementation agrees on
const KEY_BYTES = 32;  // AES-256

/**
 * The raw key buffer, or null when unconfigured.
 *
 * Read fresh each call rather than cached at module load: `validateEnv` runs
 * before the app boots, but tests and scripts set the variable after requiring
 * this module, and a cached null would make them silently unencryptable.
 *
 * @returns {Buffer|null}
 */
function getKey() {
  const raw = process.env.STORAGE_ENC_KEY;
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;

  return Buffer.from(trimmed, 'hex');
}

/** Whether encryption is available at all. Callers gate features on this. */
function isConfigured() {
  return getKey() !== null;
}

/**
 * Encrypt a UTF-8 string.
 *
 * Throws rather than returning the plaintext on a missing key. A silent
 * fallback here is exactly how a secret ends up in the database in the clear
 * with nobody noticing for six months.
 *
 * @param {string} plaintext
 * @returns {string} `v1:iv:tag:ciphertext`, all hex
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt() requires a non-empty string');
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      'STORAGE_ENC_KEY is missing or malformed (need 64 hex chars). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypt a value produced by `encrypt`.
 *
 * @param {string} payload
 * @returns {string} plaintext
 * @throws when the key is wrong, the blob is malformed, or the tag does not verify
 */
function decrypt(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('decrypt() requires a non-empty string');
  }

  const key = getKey();
  if (!key) {
    throw new Error('STORAGE_ENC_KEY is missing or malformed — cannot decrypt stored secrets');
  }

  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Unrecognised ciphertext format (expected "${VERSION}:iv:tag:data")`);
  }

  const [, ivHex, tagHex, dataHex] = parts;

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // The underlying message ("Unsupported state or unable to authenticate
    // data") tells an operator nothing about what to do next.
    throw new Error(
      'Failed to decrypt stored secret — STORAGE_ENC_KEY has changed, or the value is corrupt. ' +
      'Re-enter the credential from the provider dashboard.'
    );
  }
}

/**
 * Whether a string looks like one of our ciphertexts.
 *
 * Used by migrations and by the storage service, which must tolerate a
 * half-migrated collection without treating a plaintext key as corrupt.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/**
 * Mask a secret for display: first 4 and last 4 characters, dots between.
 *
 * Mirrors `GeminiKey.getMaskedKey()`. Short values are fully masked rather
 * than partially revealed — a 6-character secret showing 8 characters of
 * context would leak all of it.
 *
 * @param {string} value plaintext secret
 * @returns {string}
 */
function mask(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 12) return '••••••••';
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  isConfigured,
  mask,
  // exported for tests
  VERSION,
  KEY_BYTES,
};

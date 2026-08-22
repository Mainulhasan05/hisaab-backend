/**
 * The provider registry — the ONLY place a gateway is named.
 *
 * Adding a third gateway is: one new adapter file, one line in FACTORIES, one
 * entry in PROVIDER_NAMES. Nothing else in the codebase should ever contain a
 * literal 'mimsms' or 'automas'.
 *
 * Adapters are singletons because they hold nothing but immutable config read at
 * construction. Never put per-request state on one — it is shared by every send
 * in the process.
 */

const MimSmsAdapter = require('./adapters/mimsms.adapter');
const AutomasAdapter = require('./adapters/automas.adapter');
const logger = require('../../utils/logger.util');

const FACTORIES = {
  mimsms: () => new MimSmsAdapter(),
  automas: () => new AutomasAdapter(),
};

/** Stable, storable identifiers. These land in the database — do not rename. */
const PROVIDER_NAMES = Object.keys(FACTORIES);

/**
 * Names that used to mean something else.
 *
 * When a gateway is retired, alias its old name to its replacement here so
 * stored settings and in-flight queue jobs referencing the dead name keep
 * resolving instead of throwing.
 */
const ALIASES = {
  mim: 'mimsms',
  mimsms_bd: 'mimsms',
};

const instances = new Map();

/** Canonical form of a possibly-aliased, possibly-messy provider name. */
function normalizeName(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return ALIASES[key] || key;
}

/**
 * Get the adapter singleton for a provider.
 *
 * Throws on an unknown name rather than falling back silently — a typo in a
 * setting should be loud at the point of the typo, not a month later when
 * someone notices every message went out on the wrong gateway.
 */
function getAdapter(name) {
  const key = normalizeName(name);
  if (!key || !FACTORIES[key]) {
    throw new Error(
      `Unknown SMS provider '${name}'. Available: ${PROVIDER_NAMES.join(', ')}`
    );
  }
  if (!instances.has(key)) {
    instances.set(key, FACTORIES[key]());
  }
  return instances.get(key);
}

/** Is this a provider we know about? Never throws — for validating user input. */
function isKnownProvider(name) {
  const key = normalizeName(name);
  return Boolean(key && FACTORIES[key]);
}

/** Every registered provider, whether configured or not. */
function listProviders() {
  return [...PROVIDER_NAMES];
}

/** Providers whose credentials are actually present. */
function listConfiguredProviders() {
  return PROVIDER_NAMES.filter((name) => {
    try {
      return getAdapter(name).isConfigured();
    } catch {
      return false;
    }
  });
}

/**
 * The platform default, from env.
 *
 * This is the floor beneath the admin-panel setting: it answers before the
 * database has been read, and it answers if the setting is missing or names a
 * provider that has since been removed.
 */
function getDefaultProviderName() {
  const configured = normalizeName(process.env.SMS_DEFAULT_PROVIDER);
  if (configured && FACTORIES[configured]) return configured;
  return 'mimsms';
}

/**
 * A configured provider that is NOT the one named.
 *
 * The last-resort backup when failover is on but the chosen fallback is missing
 * its credentials. Returns null rather than the same provider — retrying the
 * gateway that just refused is not failover, it is a second identical refusal.
 */
function getAnyOtherConfigured(excludeName) {
  const exclude = normalizeName(excludeName);
  for (const name of PROVIDER_NAMES) {
    if (name === exclude) continue;
    try {
      if (getAdapter(name).isConfigured()) return getAdapter(name);
    } catch (err) {
      logger.warn(`[sms] provider ${name} unavailable: ${err.message}`);
    }
  }
  return null;
}

/** Shape the admin providers screen reads. Never throws. */
function getAllProviderInfo() {
  return PROVIDER_NAMES.map((name) => {
    try {
      return getAdapter(name).getProviderInfo();
    } catch (err) {
      return { name, configured: false, baseUrl: null, senderId: null, error: err.message };
    }
  });
}

/** Test seam — drops cached singletons so env changes take effect. */
function resetAdapters() {
  instances.clear();
}

module.exports = {
  PROVIDER_NAMES,
  getAdapter,
  isKnownProvider,
  normalizeName,
  listProviders,
  listConfiguredProviders,
  getDefaultProviderName,
  getAnyOtherConfigured,
  getAllProviderInfo,
  resetAdapters,
};

/**
 * The dispatcher — one entry point for every send, and the only place failover
 * is decided.
 *
 * The shape of every function here is the same three steps: try the primary,
 * classify what went wrong, decide whether a different gateway could do better.
 * Callers get back a normalised result stamped with the provider that actually
 * sent it, plus — when it failed over — enough detail to explain the charge.
 *
 * ── What must never happen here ──────────────────────────────────────────────
 *
 * · Failing over on a `permanent` error. An invalid number, an unapproved sender
 *   or a spam rejection is a fact about the message, not about the gateway. The
 *   second gateway refuses it identically and the shop pays twice to learn that.
 *
 * · Failing over to the gateway that just failed. That is a retry wearing a
 *   costume, and for an `auth` failure it is a guaranteed second refusal.
 *
 * · Failing over when the caller said not to. An OTP flow that double-sends
 *   gives the user two codes and invalidates the one they are typing.
 */

const registry = require('./registry');
const routing = require('./routing');
const { ERROR_CATEGORY, FAILOVER_CATEGORIES } = require('./adapters/base.adapter');
const logger = require('../../utils/logger.util');

/**
 * Work out which adapter goes first.
 *
 * `providerName` pins a specific gateway — used by the admin "test this
 * provider" action and by a retry that must go back to the same place. When it
 * is absent the platform routing decides.
 */
async function resolvePlan({ providerName = null, routingConfig = null } = {}) {
  if (providerName) {
    const adapter = registry.getAdapter(providerName);
    return { primary: adapter, config: routingConfig, pinned: true };
  }

  const config = routingConfig || await routing.resolve();
  return { primary: registry.getAdapter(config.primaryProvider), config, pinned: false };
}

/**
 * The backup gateway, or null if there is honestly no backup.
 *
 * Order: the configured failover if it has credentials, otherwise any other
 * configured provider. The second branch matters — a platform with two working
 * gateways and a misconfigured setting should still survive one of them going
 * down, rather than discovering the setting was wrong during the outage.
 */
function pickFailover(config, failedAdapter) {
  if (!config?.failoverEnabled) return null;

  const failedName = failedAdapter?.name;

  if (config.failoverProvider && config.failoverProvider !== failedName) {
    try {
      const candidate = registry.getAdapter(config.failoverProvider);
      if (candidate.isConfigured()) return candidate;
      logger.warn(
        `[sms] failover provider '${config.failoverProvider}' has no credentials — looking for another`
      );
    } catch (err) {
      logger.warn(`[sms] failover provider unusable: ${err.message}`);
    }
  }

  return registry.getAnyOtherConfigured(failedName);
}

/** Should this failure send us to a different gateway at all? */
function shouldFailover(adapter, error) {
  const category = adapter.categorizeError(error);
  return { category, failover: FAILOVER_CATEGORIES.has(category) };
}

/** Uniform error for "both gateways said no", naming both so the log is legible. */
function bothFailedError(primaryName, primaryErr, backupName, backupErr) {
  const err = new Error(
    `Both SMS gateways failed — ${primaryName}: ${primaryErr.message} | ${backupName}: ${backupErr.message}`
  );
  err.primaryProvider = primaryName;
  err.primaryError = primaryErr.message;
  err.failoverProvider = backupName;
  err.failoverError = backupErr.message;
  err.gatewayResponse = backupErr.gatewayResponse || primaryErr.gatewayResponse || null;
  err.allProvidersFailed = true;
  return err;
}

/**
 * Run `attempt` against the primary, and against a backup if that is warranted.
 *
 * Shared by all three send shapes so the failover rules cannot drift between
 * them — a bug fixed for single sends but not for campaigns is the failure this
 * indirection exists to prevent.
 */
async function withFailover(attempt, { providerName, routingConfig, disableFailover }) {
  const { primary, config, pinned } = await resolvePlan({ providerName, routingConfig });

  try {
    const result = await attempt(primary);
    return { ...result, provider: primary.name, failedOver: false };
  } catch (primaryErr) {
    const { category } = shouldFailover(primary, primaryErr);

    // A pinned provider means the caller wanted THIS gateway's answer. Giving
    // them a different gateway's answer makes the admin test screen useless.
    if (disableFailover || pinned) {
      primaryErr.provider = primary.name;
      primaryErr.errorCategory = category;
      throw primaryErr;
    }

    if (category === ERROR_CATEGORY.PERMANENT) {
      logger.warn(
        `[sms] ${primary.name} refused permanently (${primaryErr.message}) — not failing over`
      );
      primaryErr.provider = primary.name;
      primaryErr.errorCategory = category;
      throw primaryErr;
    }

    const backup = pickFailover(config, primary);
    if (!backup) {
      primaryErr.provider = primary.name;
      primaryErr.errorCategory = category;
      primaryErr.failoverAttempted = false;
      throw primaryErr;
    }

    logger.warn(
      `[sms] ${primary.name} failed (${category}: ${primaryErr.message}) — failing over to ${backup.name}`
    );

    try {
      const result = await attempt(backup);
      return {
        ...result,
        provider: backup.name,
        failedOver: true,
        failedProvider: primary.name,
        failedReason: primaryErr.message,
        failedCategory: category,
      };
    } catch (backupErr) {
      throw bothFailedError(primary.name, primaryErr, backup.name, backupErr);
    }
  }
}

/**
 * Send one message.
 *
 * @param {string} phone
 * @param {string} message
 * @param {object} [options]
 * @param {string} [options.senderId]        override the gateway's default sender
 * @param {string} [options.providerName]    pin a gateway; disables failover
 * @param {object} [options.routingConfig]   pre-resolved routing, to skip the lookup
 * @param {boolean} [options.disableFailover]
 */
async function sendSingle(phone, message, options = {}) {
  const { senderId = null } = options;
  return withFailover(
    (adapter) => adapter.sendSingle(phone, message, senderId),
    options
  );
}

/**
 * Send one identical message to many recipients.
 *
 * Note what does NOT happen on failure: there is no drop to per-recipient
 * individual sends here. That decision belongs to the campaign engine, which is
 * the only layer that knows which recipients have already been charged and
 * logged. Splitting a batch here would re-send to recipients the gateway had
 * already accepted.
 */
async function sendBulk(phones, message, options = {}) {
  const { senderId = null } = options;
  return withFailover(
    (adapter) => adapter.sendBulk(phones, message, senderId),
    options
  );
}

/** Send a personalised message per recipient. */
async function sendDynamic(messages, options = {}) {
  const { senderId = null } = options;
  return withFailover(
    (adapter) => adapter.sendDynamic(messages, senderId),
    options
  );
}

/**
 * Balance for every registered provider.
 *
 * Runs them concurrently and never rejects — one gateway being unreachable must
 * not blank the whole admin screen.
 */
async function checkAllBalances() {
  const names = registry.listProviders();
  return Promise.all(names.map(async (name) => {
    try {
      return await registry.getAdapter(name).checkBalance();
    } catch (err) {
      return { success: false, balance: null, provider: name, error: err.message };
    }
  }));
}

module.exports = {
  sendSingle,
  sendBulk,
  sendDynamic,
  checkAllBalances,
  pickFailover,
  shouldFailover,
  ERROR_CATEGORY,
};

/**
 * SMS gateway administration.
 *
 * Owns three things the controller must not do for itself: validating a routing
 * change, writing it through to the caches that the send path reads, and
 * leaving an audit trail of who changed the platform's messaging.
 */

const PlatformSetting = require('../models/PlatformSetting.model');
const AuditLog = require('../models/AuditLog.model');
const registry = require('./sms/registry');
const routing = require('./sms/routing');
const earnings = require('./sms/earnings');
const dispatcher = require('./sms/dispatcher');
const { formatPhone, isValidPhone } = require('../utils/phone.util');
const logger = require('../utils/logger.util');

class SmsProviderService {
  /**
   * Everything the providers screen needs: each gateway's configuration state
   * and live balance, plus what is currently routing.
   */
  async overview({ withBalance = true } = {}) {
    const [config, balances] = await Promise.all([
      routing.describe(),
      withBalance ? dispatcher.checkAllBalances() : Promise.resolve([]),
    ]);

    const balanceBy = new Map(balances.map((b) => [b.provider, b]));
    const rates = await earnings.platformRates({ force: true });

    const providers = registry.getAllProviderInfo().map((info) => {
      const balance = balanceBy.get(info.name);
      return {
        ...info,
        isPrimary: info.name === config.primaryProvider,
        isFailover: info.name === config.failoverProvider,
        balance: balance?.success ? balance.balance : null,
        balanceError: balance?.success === false ? balance.error : null,
        // `null` means the rate has never been entered, and the screen must say
        // so rather than print ৳0.00 next to real spending.
        unitCost: rates.providerCost?.[info.name] ?? rates.fallbackCost ?? null,
        unitCostSource: rates.providerCost?.[info.name] != null
          ? 'provider'
          : (rates.fallbackCost != null ? 'platform_default' : 'unset'),
      };
    });

    return { providers, routing: config, available: registry.listProviders() };
  }

  async getRouting() {
    return routing.describe();
  }

  /**
   * Change the routing.
   *
   * ── Merge, do not replace ──────────────────────────────────────────────────
   *
   * An omitted field means "leave it alone"; an explicit `null` means "clear
   * it". A PATCH that names only `primaryProvider` must not wipe the failover
   * configuration — treating absent as null is how a whole platform silently
   * loses its backup gateway because someone changed the primary.
   */
  async updateRouting({ primaryProvider, failoverProvider, failoverEnabled }, actor = {}) {
    const settings = await PlatformSetting.current();

    const before = {
      primaryProvider: settings.smsPrimaryProvider,
      failoverProvider: settings.smsFailoverProvider,
      failoverEnabled: settings.smsFailoverEnabled,
    };

    const next = { ...before };

    if (primaryProvider !== undefined) {
      next.primaryProvider = this._validateProvider(primaryProvider, 'primaryProvider');
    }
    if (failoverProvider !== undefined) {
      next.failoverProvider = this._validateProvider(failoverProvider, 'failoverProvider');
    }
    if (failoverEnabled !== undefined) {
      next.failoverEnabled = Boolean(failoverEnabled);
    }

    /* A gateway cannot fail over to itself — but HOW that collision arose
     * decides what to do about it, and the two cases are genuinely different.
     *
     *   Asked for explicitly (both fields in one request, naming the same
     *   gateway) → REFUSE. The operator asked for something impossible and
     *   should be told, not quietly given something else.
     *
     *   Produced by the merge (they changed only the primary, to whatever the
     *   untouched failover already was) → RESOLVE IT. They did not mention
     *   failover, so refusing on its behalf blocks a perfectly ordinary action:
     *   promoting the backup to primary. With two gateways the obvious result is
     *   a swap, and that is almost always the intent.
     */
    const effectivePrimary = next.primaryProvider || registry.getDefaultProviderName();
    if (next.failoverProvider && next.failoverProvider === effectivePrimary) {
      const bothNamed = primaryProvider !== undefined && failoverProvider !== undefined;
      if (bothNamed) {
        const err = new Error('Failover provider must differ from the primary provider');
        err.statusCode = 400;
        err.messageBn = 'ফলব্যাক গেটওয়ে প্রাইমারি গেটওয়ে থেকে আলাদা হতে হবে';
        throw err;
      }

      // The promoted gateway's old partner takes over as the backup. Falls back
      // to any other configured gateway, then to no backup at all.
      const demoted = before.primaryProvider && before.primaryProvider !== effectivePrimary
        ? before.primaryProvider
        : registry.getAnyOtherConfigured(effectivePrimary)?.name || null;

      logger.info(
        `[sms] primary changed to ${effectivePrimary}, which was the failover — failover moved to ${demoted || 'none'}`
      );
      next.failoverProvider = demoted;
    }

    /* Turning failover ON without naming a backup would arm a switch with
     * nothing behind it. Pick the other configured gateway instead of storing a
     * setting that reads as protection and provides none. */
    if (next.failoverEnabled && !next.failoverProvider) {
      const auto = registry.getAnyOtherConfigured(effectivePrimary);
      if (auto) {
        next.failoverProvider = auto.name;
        logger.info(`[sms] failover enabled with no backup named — selected ${auto.name}`);
      }
    }

    settings.smsPrimaryProvider = next.primaryProvider;
    settings.smsFailoverProvider = next.failoverProvider;
    settings.smsFailoverEnabled = next.failoverEnabled;
    if (actor.id) settings.updatedBy = actor.id;
    await settings.save();

    /* Write through from the MERGED RESULT, not from the request body.
     *
     * The send path reads a cached copy; invalidating from what the caller sent
     * would leave any field they did not mention stale in cache while the
     * database has moved on. Dropping the whole entry is both simpler and
     * correct — the next send re-reads it. */
    routing.invalidate();

    await AuditLog.create({
      admin: actor.id,
      action: 'sms_routing_updated',
      actionBn: 'এসএমএস রাউটিং পরিবর্তন',
      description: `SMS routing: primary ${before.primaryProvider || 'default'} → ${next.primaryProvider || 'default'}, `
        + `failover ${before.failoverEnabled ? before.failoverProvider : 'off'} → ${next.failoverEnabled ? next.failoverProvider : 'off'}`,
      descriptionBn: 'এসএমএস গেটওয়ে রাউটিং পরিবর্তন করা হয়েছে',
      entity: { type: 'platform_setting', id: settings._id, name: 'SMS routing' },
      changes: { before, after: next },
    }).catch((err) => logger.error(`[sms] routing audit log failed: ${err.message}`));

    return routing.describe();
  }

  /** Per-gateway cost per segment. Same merge rule as routing. */
  async updateCosts(costs, actor = {}) {
    const settings = await PlatformSetting.current();
    const before = {
      mimsms: settings.smsProviderCost?.mimsms ?? null,
      automas: settings.smsProviderCost?.automas ?? null,
    };
    const after = { ...before };

    for (const name of registry.listProviders()) {
      if (costs[name] === undefined) continue; // omitted = keep
      const raw = costs[name];
      if (raw === null || raw === '') {
        after[name] = null; // explicit clear = back to the platform default
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        const err = new Error(`Invalid cost for ${name}`);
        err.statusCode = 400;
        err.messageBn = 'গেটওয়ে খরচ সঠিক নয়';
        throw err;
      }
      after[name] = value;
    }

    settings.smsProviderCost = after;
    if (actor.id) settings.updatedBy = actor.id;
    await settings.save();

    earnings.invalidate();

    await AuditLog.create({
      admin: actor.id,
      action: 'sms_gateway_cost_updated',
      actionBn: 'গেটওয়ে খরচ পরিবর্তন',
      description: `SMS gateway cost updated: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      descriptionBn: 'এসএমএস গেটওয়ের খরচ পরিবর্তন করা হয়েছে',
      entity: { type: 'platform_setting', id: settings._id, name: 'SMS gateway cost' },
      changes: { before, after },
    }).catch((err) => logger.error(`[sms] cost audit log failed: ${err.message}`));

    return after;
  }

  /**
   * Send one real message through a named gateway.
   *
   * Failover is OFF. A test whose whole purpose is "does Automas work" must not
   * quietly answer using MimSMS — that is worse than no test, because it reports
   * a gateway healthy at exactly the moment it is not.
   */
  async testProvider(name, { phone, message }, actor = {}) {
    if (!registry.isKnownProvider(name)) {
      const err = new Error(`Unknown SMS provider '${name}'. Available: ${registry.listProviders().join(', ')}`);
      err.statusCode = 400;
      err.messageBn = 'অজানা এসএমএস গেটওয়ে';
      throw err;
    }

    if (!phone || !isValidPhone(phone)) {
      const err = new Error('A valid phone number is required');
      err.statusCode = 400;
      err.messageBn = 'সঠিক মোবাইল নম্বর দিন';
      throw err;
    }

    const adapter = registry.getAdapter(name);
    if (!adapter.isConfigured()) {
      const err = new Error(`${name} has no credentials configured`);
      err.statusCode = 400;
      err.messageBn = 'এই গেটওয়ের কনফিগারেশন নেই';
      throw err;
    }

    const body = message || `Hisaab test message via ${name}. Ignore.`;
    const to = formatPhone(phone);

    const started = Date.now();
    try {
      const result = await dispatcher.sendSingle(to, body, {
        providerName: name,
        disableFailover: true,
      });

      await this._auditTest(actor, name, to, true, null);

      return {
        success: true,
        provider: result.provider,
        messageId: result.messageId,
        statusCode: result.statusCode,
        senderId: result.senderIdUsed,
        durationMs: Date.now() - started,
        raw: result.data,
      };
    } catch (error) {
      await this._auditTest(actor, name, to, false, error.message);
      return {
        success: false,
        provider: name,
        error: error.message,
        // The category is the actionable part: `auth` means fix the key,
        // `permanent` means the number or sender is wrong, `retryable` means try
        // again. Without it the operator only sees the gateway's own wording.
        category: adapter.categorizeError(error),
        durationMs: Date.now() - started,
        raw: error.gatewayResponse || null,
      };
    }
  }

  async _auditTest(actor, provider, phone, ok, error) {
    return AuditLog.create({
      admin: actor.id,
      action: 'sms_provider_tested',
      actionBn: 'গেটওয়ে টেস্ট',
      description: `Test SMS via ${provider} to ${phone}: ${ok ? 'delivered' : `failed — ${error}`}`,
      descriptionBn: 'এসএমএস গেটওয়ে টেস্ট করা হয়েছে',
      entity: { type: 'sms_provider', name: provider },
    }).catch((err) => logger.error(`[sms] test audit log failed: ${err.message}`));
  }

  /** `null` clears the override; anything else must name a registered gateway. */
  _validateProvider(value, field) {
    if (value === null || value === '') return null;
    const name = registry.normalizeName(value);
    if (!registry.isKnownProvider(name)) {
      const err = new Error(
        `Unknown SMS provider '${value}' for ${field}. Available: ${registry.listProviders().join(', ')}`
      );
      err.statusCode = 400;
      err.messageBn = 'অজানা এসএমএস গেটওয়ে';
      throw err;
    }
    return name;
  }
}

module.exports = new SmsProviderService();

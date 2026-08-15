/**
 * Platform → shopkeeper messaging.
 *
 * The operator's own outbound channel: expiry chasers, quota warnings, downtime
 * notices, feature announcements. Until this existed, the admin panel could
 * sell SMS credits and read SMS logs but could not send a single message to the
 * people who pay for the product — SUBSCRIPTION_PLAN.md §11.5 named the gap
 * ("no outbound reminders … collection is driven from the admin worklist") and
 * the worklist was a phone-call list as a result.
 *
 * ── Audiences are resolved HERE, from a name ─────────────────────────────────
 *
 * The panel posts the word `expiring`, never a list of phone numbers. This is
 * the same rule `sms.service.resolveAudience` enforces for a shop's customers,
 * and it holds for the same three reasons, in the same order:
 *
 *   1. Correctness. "Expiring in 3 days" is a question about `subscription`,
 *    `access` and per-shop `graceDays`, answered by `resolveSubscription`. A
 *    client filtering a page of shops it happens to have loaded gets a
 *    different — and quietly wrong — answer, and the shops it misses are the
 *    ones nobody then chases.
 *   2. Trust. A client that names its own recipients can text anyone, from the
 *    platform's masked sender ID, at the platform's expense.
 *   3. Scale. The audience is every shop on the platform. It should not have to
 *    travel to a browser and back to be counted.
 *
 * `manual` is the one exception and is deliberately narrow: a short typed list,
 * capped, for the "text these two owners back" case. Everything else is a name.
 */

const Shop = require('../models/Shop.model');
const User = require('../models/User.model');
const SMSQuota = require('../models/SMSQuota.model');
const SMSLog = require('../models/SMSLog.model');
const AuditLog = require('../models/AuditLog.model');
const PlatformSetting = require('../models/PlatformSetting.model');
const smsService = require('./sms.service');
const logger = require('../utils/logger.util');
const { AppError } = require('../middleware/error.middleware');
const { normalizeRecipients } = require('../utils/smsRecipients.util');
const { countSms } = require('../utils/smsCounter.util');
const { resolveSubscription } = require('../utils/subscriptionState.util');
const {
  PLATFORM_PLACEHOLDERS,
  isPlatformPersonalized,
  personalizePlatformMessage,
} = require('../utils/platformSmsPersonalize.util');

/** How many numbers a `manual` send may carry. A broadcast uses an audience. */
const MAX_MANUAL_RECIPIENTS = 50;

/** Below this remaining balance a shop counts as "about to run out". */
const LOW_QUOTA_THRESHOLD = Number(process.env.SMS_LOW_QUOTA_THRESHOLD) || 20;

/**
 * The audiences the panel may ask for.
 *
 * `transactional` is not decoration. Bangladeshi gateways separate
 * transactional traffic (billing, account state — sendable at any hour, to any
 * number) from promotional (marketing, subject to DND rules and time windows).
 * Sending an announcement down the transactional route is a compliance problem
 * for the masking ID the whole platform shares, so the route is a property of
 * the AUDIENCE rather than a dropdown the operator can get wrong: everything
 * derived from a shop's billing state is transactional, `all` and `manual`
 * default to promotional and can be raised deliberately.
 */
const AUDIENCES = {
  all: {
    label: 'All shop owners',
    labelBn: 'সব দোকান মালিক',
    description: 'Every owner of an active shop.',
    transactional: false,
  },
  expiring: {
    label: 'Expiring soon',
    labelBn: 'মেয়াদ শেষ হচ্ছে',
    description: 'Owners whose subscription runs out within the warning window.',
    transactional: true,
  },
  expired: {
    label: 'Expired',
    labelBn: 'মেয়াদ শেষ',
    description: 'Owners whose subscription has already lapsed, grace included.',
    transactional: true,
  },
  blocked: {
    label: 'Blocked',
    labelBn: 'ব্লক করা',
    description: 'Owners of shops an operator has switched off.',
    transactional: true,
  },
  trial: {
    label: 'On trial',
    labelBn: 'ট্রায়ালে আছে',
    description: 'Owners still inside their trial period.',
    transactional: true,
  },
  low_sms: {
    label: 'Low SMS balance',
    labelBn: 'এসএমএস কম',
    description: `Owners with SMS enabled and under ${LOW_QUOTA_THRESHOLD} left.`,
    transactional: true,
  },
  staff: {
    label: 'All staff',
    labelBn: 'সব স্টাফ',
    description: 'Every active staff account, owners excluded.',
    transactional: false,
  },
  shop: {
    label: 'One shop',
    labelBn: 'একটি দোকান',
    description: 'The owner, or the whole team, of a single shop.',
    transactional: true,
    needsShop: true,
  },
  manual: {
    label: 'Typed numbers',
    labelBn: 'নম্বর লিখে',
    description: `Up to ${MAX_MANUAL_RECIPIENTS} numbers, entered by hand.`,
    transactional: false,
  },
};

class PlatformSmsService {
  /** What broadcasts sign off as. Configurable, because the brand can change. */
  senderName() {
    return process.env.PLATFORM_SMS_SENDER_NAME || 'Hisaab';
  }

  /**
   * Every shop that could be messaged, with its resolved subscription state.
   *
   * One pass. Every audience below is a filter over this list rather than its
   * own query, because the expensive part is not the `Shop` scan — it is
   * `resolveSubscription`, which has to run per shop and needs `graceDays` and
   * `warningDays` alongside the raw dates. Running it once and filtering six
   * ways is what lets `getAudienceCounts` answer the whole panel in one call
   * instead of six round trips that each re-read the collection.
   *
   * Deactivated shops are excluded everywhere. A shop with `isActive: false` has
   * been switched off by the operator; texting its owner about their expiring
   * subscription is a message about an account that no longer exists.
   */
  async _shopUniverse() {
    const settings = await PlatformSetting.current().catch(() => null);
    const warningDays = settings?.warningDays ?? 3;

    const shops = await Shop.find({ isActive: true })
      .select('name phone owner subscription access billing isActive')
      .populate('owner', 'name phone isActive')
      .lean();

    // `now` is the second positional arg, options the third — passing options
    // where `now` goes resolves every shop against an invalid date.
    const now = new Date();
    return shops.map((shop) => ({
      shop,
      state: resolveSubscription(shop, now, { warningDays }),
    }));
  }

  /**
   * One recipient row, in the shape the campaign engine and the preview share.
   *
   * `name` is the person; `shopName` is their shop. Both are carried because a
   * broadcast can address either ("Dear Karim" / "your shop Rahman Store"), and
   * a placeholder with nothing behind it renders as a literal `{brace}` in a
   * message somebody actually reads.
   */
  _recipient({ user, shop, state, quota }) {
    return {
      phone: user?.phone || shop?.phone || '',
      name: user?.name || 'Shop owner',
      customerName: user?.name || shop?.name || '',
      shopId: shop?._id || null,
      shopName: shop?.name || '',
      daysLeft: state?.daysRemaining ?? null,
      expiresOn: state?.expiresOn || null,
      monthlyPrice: shop?.billing?.monthlyPrice ?? null,
      smsBalance: quota?.remainingQuota ?? null,
    };
  }

  /**
   * Who a broadcast would go to.
   *
   * @param {string} audience  A key of `AUDIENCES`.
   * @param {object} [options]
   * @param {string} [options.shopId]   Required for the `shop` audience.
   * @param {boolean} [options.includeStaff=false]  `shop` audience: whole team.
   * @param {Array<{phone: string, name?: string}>} [options.phones]  `manual`.
   * @returns {Promise<Array>} recipient rows, before hygiene.
   */
  async resolveAudience(audience, options = {}) {
    const { shopId, includeStaff = false, phones = [] } = options;

    if (!AUDIENCES[audience]) {
      throw new AppError(
        `Unknown audience "${audience}"`,
        'অজানা প্রাপক তালিকা',
        400
      );
    }

    if (audience === 'manual') {
      if (!Array.isArray(phones) || phones.length === 0) {
        throw new AppError('Enter at least one number', 'অন্তত একটি নম্বর দিন', 400);
      }
      if (phones.length > MAX_MANUAL_RECIPIENTS) {
        throw new AppError(
          `A typed list is capped at ${MAX_MANUAL_RECIPIENTS} numbers — pick an audience for anything larger`,
          `হাতে লেখা তালিকায় সর্বোচ্চ ${MAX_MANUAL_RECIPIENTS}টি নম্বর দেওয়া যাবে`,
          400
        );
      }
      return phones.map((entry) => ({
        phone: typeof entry === 'string' ? entry : entry?.phone,
        name: (typeof entry === 'object' && entry?.name) || 'there',
        customerName: (typeof entry === 'object' && entry?.name) || '',
        shopId: null,
        shopName: '',
        daysLeft: null,
        expiresOn: null,
        monthlyPrice: null,
        smsBalance: null,
      }));
    }

    if (audience === 'shop') {
      if (!shopId) {
        throw new AppError('Pick a shop first', 'একটি দোকান নির্বাচন করুন', 400);
      }

      const shop = await Shop.findById(shopId)
        .select('name phone owner subscription access billing isActive')
        .lean();
      if (!shop) {
        throw new AppError('Shop not found', 'দোকান পাওয়া যায়নি', 404);
      }

      const [people, quota] = await Promise.all([
        // The owner always; the staff only when asked. `isOwner` rather than a
        // role name, because roles are per-shop documents and a shop can rename
        // its owner role.
        User.find(
          includeStaff
            ? { shop: shop._id, isActive: true }
            : { shop: shop._id, isActive: true, isOwner: true }
        ).select('name phone isOwner').lean(),
        SMSQuota.findOne({ shop: shop._id }).select('remainingQuota').lean(),
      ]);

      const state = resolveSubscription(shop);
      return people.map((user) => this._recipient({ user, shop, state, quota }));
    }

    if (audience === 'staff') {
      // Staff of active shops only, and never the owners — "all staff" and "all
      // owners" are different audiences, and a message written for one reads
      // wrong to the other.
      const activeShops = await Shop.find({ isActive: true }).select('name').lean();
      const shopById = new Map(activeShops.map((s) => [String(s._id), s]));

      const staff = await User.find({
        shop: { $in: activeShops.map((s) => s._id) },
        isActive: true,
        isOwner: false,
      })
        .select('name phone shop')
        .lean();

      return staff.map((user) =>
        this._recipient({ user, shop: shopById.get(String(user.shop)) })
      );
    }

    // Everything else is a filter over the one shop pass.
    const universe = await this._shopUniverse();

    const matches = universe.filter(({ state }) => {
      switch (audience) {
        case 'all': return true;
        case 'expiring': return state.state === 'expiring';
        case 'expired': return state.state === 'expired' || state.state === 'grace';
        case 'blocked': return state.state === 'blocked';
        case 'trial': return state.state === 'trial';
        default: return false;
      }
    });

    if (audience === 'low_sms') {
      // Asked of the quota collection rather than filtered out of the shop
      // pass, because "low" is a fact about a document the pass never read.
      const quotas = await SMSQuota.find({
        isEnabled: true,
        remainingQuota: { $lte: LOW_QUOTA_THRESHOLD },
      })
        .select('shop remainingQuota')
        .lean();

      const quotaByShop = new Map(quotas.map((q) => [String(q.shop), q]));
      return universe
        .filter(({ shop }) => quotaByShop.has(String(shop._id)))
        .map(({ shop, state }) =>
          this._recipient({
            user: shop.owner,
            shop,
            state,
            quota: quotaByShop.get(String(shop._id)),
          })
        );
    }

    return matches
      // An owner whose own account was deactivated is not a person to text.
      .filter(({ shop }) => shop.owner && shop.owner.isActive !== false)
      .map(({ shop, state }) => this._recipient({ user: shop.owner, shop, state }));
  }

  /**
   * How many each audience holds, and how many carry a usable number.
   *
   * Both figures, always. "সব দোকান মালিক — ৮২০" next to a send that reaches
   * 780 of them is a quote wrong by forty messages, and the operator finds out
   * only afterwards. The composer shows the reachable count next to the total
   * and prices off the reachable one.
   */
  async getAudienceCounts() {
    const keys = Object.keys(AUDIENCES).filter(
      (key) => !AUDIENCES[key].needsShop && key !== 'manual'
    );

    const entries = await Promise.all(
      keys.map(async (key) => {
        try {
          const list = await this.resolveAudience(key);
          return [key, {
            total: list.length,
            reachable: normalizeRecipients(list).valid.length,
          }];
        } catch (err) {
          logger.error(`[platformSms] audience ${key} failed: ${err.message}`);
          return [key, { total: 0, reachable: 0, error: true }];
        }
      })
    );

    return {
      audiences: AUDIENCES,
      counts: Object.fromEntries(entries),
      placeholders: PLATFORM_PLACEHOLDERS,
      senderName: this.senderName(),
      lowQuotaThreshold: LOW_QUOTA_THRESHOLD,
      maxManualRecipients: MAX_MANUAL_RECIPIENTS,
    };
  }

  /**
   * Cost and reach of a broadcast, before it is sent.
   *
   * Priced off the SIGNED, personalised body — the same one the gateway will
   * receive — because the sign-off and a long shop name are both billable, and
   * a quote that ignores them is short by a segment per recipient at exactly
   * the scale where that matters.
   */
  async preview(audience, { message, shopId, includeStaff, phones } = {}) {
    const body = String(message || '');
    if (!body.trim()) {
      throw new AppError('Write a message first', 'আগে বার্তা লিখুন', 400);
    }

    const senderName = this.senderName();
    const personalized = isPlatformPersonalized(body);
    const { appendShopSignature } = require('../utils/smsTemplates.util');

    const contacts = await this.resolveAudience(audience, { shopId, includeStaff, phones });

    // Rendered BEFORE the list is cleaned, in exactly the order `send` does it.
    // `normalizeRecipients` returns a narrowed row — phone, id, name, message —
    // so personalising after it runs would substitute `{shop_name}` and
    // `{days_left}` against fields that no longer exist, and quote the operator
    // a preview reading "your shop - expires in - days" for a send that will go
    // out correct. Preview and send have to walk the same path to promise the
    // same thing.
    const rendered = personalized
      ? contacts.map((c) => ({ ...c, message: personalizePlatformMessage(body, c, senderName) }))
      : contacts;

    const { valid, skipped, skippedCount } = normalizeRecipients(rendered, {
      requireMessage: personalized,
    });

    // The LONGEST rendered body sets the segment count shown, not the first: a
    // 3-character shop name and a 30-character one are not the same price, and
    // quoting the short one understates the bill by a segment per recipient at
    // exactly the scale where that matters.
    let sample;
    let totalSegments = 0;
    let maxSegments = 0;

    if (personalized) {
      for (const recipient of valid) {
        const signed = appendShopSignature(recipient.message, senderName);
        const segments = countSms(signed).segments || 1;
        totalSegments += segments;
        if (segments > maxSegments || sample === undefined) {
          maxSegments = segments;
          sample = signed;
        }
      }
      // An audience that resolved to nobody still has to show the operator what
      // they wrote, rather than an empty preview panel.
      if (sample === undefined) sample = appendShopSignature(body, senderName);
    } else {
      sample = appendShopSignature(personalizePlatformMessage(body, {}, senderName), senderName);
      maxSegments = countSms(sample).segments || 1;
      totalSegments = maxSegments * valid.length;
    }

    const info = countSms(sample);

    return {
      audience,
      personalized,
      senderName,
      total: contacts.length,
      reachable: valid.length,
      skippedCount,
      skipped: skipped.slice(0, 20),
      sample,
      characters: info.characterCount,
      charsPerSegment: info.charsPerSegment,
      remainingChars: info.remainingChars,
      encoding: info.encoding,
      segments: maxSegments,
      totalSegments,
      transactionType: AUDIENCES[audience]?.transactional ? 'T' : 'P',
    };
  }

  /**
   * Send it.
   *
   * @param {{ id: any, name: string }} admin
   * @param {object} payload
   * @param {string} payload.audience
   * @param {string} payload.message
   * @param {string} [payload.shopId]
   * @param {boolean} [payload.includeStaff]
   * @param {Array} [payload.phones]
   * @param {boolean} [payload.promotional] Force the promotional route.
   */
  async send(admin, payload = {}) {
    const { audience, message, shopId, includeStaff, phones, promotional } = payload;

    const body = String(message || '').trim();
    if (!body) {
      throw new AppError('Write a message first', 'আগে বার্তা লিখুন', 400);
    }

    const contacts = await this.resolveAudience(audience, { shopId, includeStaff, phones });
    if (contacts.length === 0) {
      throw new AppError(
        'That audience is empty right now',
        'এই তালিকায় এখন কেউ নেই',
        400
      );
    }

    const senderName = this.senderName();
    const personalized = isPlatformPersonalized(body);

    // Billing and account-state messages ride the transactional route; anything
    // else is promotional unless the audience is inherently transactional. The
    // operator can push a message DOWN to promotional but never silently up.
    const transactionType =
      promotional === true ? 'P' : AUDIENCES[audience]?.transactional ? 'T' : 'P';

    const recipients = personalized
      ? contacts.map((c) => ({ ...c, message: personalizePlatformMessage(body, c, senderName) }))
      : contacts;

    const result = await smsService.sendPlatformCampaign({
      recipients,
      message: personalized ? '' : personalizePlatformMessage(body, {}, senderName),
      personalized,
      senderName,
      audience: `platform_${audience}`,
      transactionType,
      admin,
    });

    // Audited even when the send fails. A broadcast is an outbound action taken
    // in the platform's name against people who did not ask for it; the record
    // that it was attempted is the point, and a gateway outage does not make it
    // less true that somebody pressed the button.
    await AuditLog.create({
      admin: admin?.id,
      action: 'platform_sms_broadcast',
      actionBn: 'প্ল্যাটফর্ম এসএমএস',
      description:
        `Broadcast to "${audience}" (${result.totalRecipients ?? result.sentCount ?? 0} recipients, ` +
        `${transactionType === 'T' ? 'transactional' : 'promotional'}): ${body.slice(0, 120)}`,
      descriptionBn: `${audience} তালিকায় এসএমএস পাঠানো হয়েছে`,
      entity: shopId
        ? { type: 'shop', id: shopId }
        : { type: 'platform', name: 'SMS broadcast' },
    }).catch((err) => logger.error(`[platformSms] audit log failed: ${err.message}`));

    return result;
  }

  /** Progress of a running broadcast, for the composer to poll. */
  async getCampaign(campaignId) {
    return smsService.getPlatformCampaign(campaignId);
  }

  /**
   * Past broadcasts.
   *
   * `shop: null` is the whole filter — it is what separates the platform's own
   * messaging from the ~everything else in this collection.
   */
  async history({ page = 1, limit = 20 } = {}) {
    const skip = (Number(page) - 1) * Number(limit);
    const filter = { shop: null, sentByAdmin: { $ne: null } };

    const [data, total] = await Promise.all([
      SMSLog.find(filter)
        .select('-recipients -skipped -apiResponse')
        .populate('sentByAdmin', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      SMSLog.countDocuments(filter),
    ]);

    return {
      data,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    };
  }

  /**
   * The platform's own balance at MimSMS.
   *
   * `sms.service.checkBalance` has existed since the gateway was wired up and
   * was never reachable from anywhere — so the operator has been selling credits
   * against an upstream float they could not see. Never throws: a gateway that
   * is down must show as "unknown" on a dashboard, not take the page with it.
   */
  async gatewayBalance() {
    try {
      const data = await smsService.checkBalance();
      // MimSMS spells the field differently across its endpoints; take whichever
      // is present rather than guessing, and keep the raw body for the operator.
      const raw = data?.balance ?? data?.Balance ?? data?.balanceAmount ?? null;
      const balance = raw === null ? null : Number(raw);

      return {
        available: true,
        balance: Number.isFinite(balance) ? balance : null,
        raw: data,
        checkedAt: new Date(),
      };
    } catch (err) {
      logger.error(`[platformSms] gateway balance check failed: ${err.message}`);
      return {
        available: false,
        balance: null,
        error: err.message,
        checkedAt: new Date(),
      };
    }
  }
}

module.exports = new PlatformSmsService();
module.exports.AUDIENCES = AUDIENCES;
module.exports.MAX_MANUAL_RECIPIENTS = MAX_MANUAL_RECIPIENTS;

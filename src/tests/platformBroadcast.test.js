/**
 * Platform broadcasts, pinned.
 *
 * A shop's campaign reaches its own customers and is billed to a balance the
 * shop bought. A broadcast reaches every shopkeeper on the platform and is
 * billed to the platform. The differences between those two facts are the whole
 * risk surface of this feature, and none of them are visible once a send is in
 * flight — so they are pinned here:
 *
 *   · a broadcast must NOT reserve a shop's SMS quota;
 *   · it must be signed by the platform, not by whichever shop received it;
 *   · billing and account-state messages ride the transactional route,
 *     marketing does not;
 *   · a typed recipient list stays small, because an audience is the supported
 *     way to reach a crowd;
 *   · the substitutions match `hisaab-frontend/lib/sms/platformPersonalize.js`,
 *     which draws the composer's preview and its price quote.
 *
 * The last one is a tripwire, not a unit test: a failure means the mirror needs
 * the same edit in the same commit, or the operator is quoted for one message
 * and eight hundred owners receive a different one.
 */

const {
  PLATFORM_PLACEHOLDERS,
  isPlatformPersonalized,
  personalizePlatformMessage,
} = require('../utils/platformSmsPersonalize.util');
const { appendShopSignature } = require('../utils/smsTemplates.util');
const { normalizeRecipients } = require('../utils/smsRecipients.util');

describe('platform placeholders (mirrored in lib/sms/platformPersonalize.js)', () => {
  it('substitutes every token the composer offers', () => {
    // Every token the UI can insert must be substituted here. One that is not
    // reaches a shopkeeper's phone as a literal `{brace}`.
    const template = PLATFORM_PLACEHOLDERS.map((p) => p.token).join(' ');
    const rendered = personalizePlatformMessage(
      template,
      {
        name: 'Karim',
        shopName: 'Rahman Store',
        daysLeft: 3,
        expiresOn: '2026-08-20',
        smsBalance: 42,
        monthlyPrice: 800,
      },
      'Hisaab'
    );

    expect(rendered).toBe('Karim Rahman Store 3 2026-08-20 42 800');
    expect(rendered).not.toMatch(/[{}]/);
  });

  it('renders an unknown value as a dash, never as zero', () => {
    // "your subscription ends in 0 days" is a lie told to a shop on an
    // unlimited plan. The dash is visible in the preview before it is visible
    // in an inbox.
    const rendered = personalizePlatformMessage(
      '{days_left} {sms_balance} {monthly_price}',
      { daysLeft: null, smsBalance: undefined, monthlyPrice: '' },
      'Hisaab'
    );
    expect(rendered).toBe('- - -');
  });

  it('falls back to a neutral greeting rather than an empty one', () => {
    expect(personalizePlatformMessage('Dear {name},', {}, 'Hisaab')).toBe('Dear there,');
  });

  it('treats a zero balance as zero, not as unknown', () => {
    // The shop that most needs a "top up" message is the one at exactly 0.
    expect(personalizePlatformMessage('{sms_balance}', { smsBalance: 0 }, 'Hisaab')).toBe('0');
  });

  it('counts any token as making the message per-recipient', () => {
    // Unlike the shop-side rule, `{shop_name}` DOES vary here — it is the
    // recipient's own shop. A message using it cannot go out as one bulk body.
    expect(isPlatformPersonalized('Dear {name}')).toBe(true);
    expect(isPlatformPersonalized('{shop_name} expires soon')).toBe(true);
    expect(isPlatformPersonalized('Maintenance tonight at 2am')).toBe(false);
  });
});

describe('broadcast signing', () => {
  it('signs with the platform name, not a shop name', () => {
    // The failure this guards: an announcement signed as whichever shop
    // received it, because the shop-side signature helper was reused with the
    // wrong argument.
    const body = appendShopSignature('Maintenance tonight.', 'Hisaab');
    expect(body).toBe('Maintenance tonight.\n- Hisaab');
    expect(body).not.toContain('Rahman Store');
  });

  it('does not sign twice when the operator typed the sign-off', () => {
    const body = appendShopSignature('Maintenance tonight.\n- Hisaab', 'Hisaab');
    expect(body.match(/Hisaab/g)).toHaveLength(1);
  });
});

describe('broadcast recipient hygiene', () => {
  it('drops duplicates so one owner is not texted twice', () => {
    // Two shops owned by the same person is common, and `all` walks shops.
    const { valid, skipped } = normalizeRecipients([
      { phone: '01712345678', customerName: 'Karim' },
      { phone: '+8801712345678', customerName: 'Karim (second shop)' },
    ]);

    expect(valid).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate_phone');
  });

  it('prices the audience off reachable numbers, not the headline count', () => {
    // Quoting the total when some rows have no number is a quote that is wrong
    // by the difference, discovered only after the send.
    const contacts = [
      { phone: '01712345678' },
      { phone: '' },
      { phone: '028912345' },
    ];
    const { valid, skippedCount } = normalizeRecipients(contacts);

    expect(contacts).toHaveLength(3);
    expect(valid).toHaveLength(1);
    expect(skippedCount).toBe(2);
  });
});

describe('audience definitions', () => {
  // Required lazily: the service pulls in models, which need mongoose loaded.
  const { AUDIENCES, MAX_MANUAL_RECIPIENTS } = require('../services/platformSms.service');

  it('routes billing and account-state audiences as transactional', () => {
    // These are legitimately transactional and may be sent at any hour.
    for (const key of ['expiring', 'expired', 'blocked', 'trial', 'low_sms', 'shop']) {
      expect(AUDIENCES[key].transactional).toBe(true);
    }
  });

  it('routes broad audiences as promotional by default', () => {
    // A marketing blast down the transactional route is a compliance problem
    // for the masked sender ID that every shop's own messages share.
    expect(AUDIENCES.all.transactional).toBe(false);
    expect(AUDIENCES.staff.transactional).toBe(false);
    expect(AUDIENCES.manual.transactional).toBe(false);
  });

  it('keeps the typed-number list small', () => {
    // The cap is what stops `manual` becoming a way to bypass server-side
    // audience resolution with a pasted list of five thousand numbers.
    expect(MAX_MANUAL_RECIPIENTS).toBeLessThanOrEqual(50);
  });

  it('marks the one audience that cannot resolve without a shop', () => {
    expect(AUDIENCES.shop.needsShop).toBe(true);
    expect(AUDIENCES.all.needsShop).toBeUndefined();
  });
});

describe('quota isolation', () => {
  const smsService = require('../services/sms.service');

  it('never reserves quota on the platform path', async () => {
    // The single most expensive mistake available here: charging a shop for the
    // platform's own messaging, out of credits they paid for. Worse, quota
    // starts disabled — so a quota-gated broadcast would silently skip every
    // shop that has never bought SMS, which is exactly the set most in need of
    // chasing.
    const SMSQuota = require('../models/SMSQuota.model');
    const reserve = jest.spyOn(SMSQuota, 'reserve');
    const refund = jest.spyOn(SMSQuota, 'refund');

    // No valid recipients: returns before any gateway or log write, which is
    // enough to prove the quota is not consulted on the way in.
    const result = await smsService.sendPlatformCampaign({
      recipients: [{ phone: 'not-a-number' }],
      message: 'Hello',
      senderName: 'Hisaab',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_valid_recipients');
    expect(reserve).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();

    reserve.mockRestore();
    refund.mockRestore();
  });
});

/**
 * Online-order status SMS: the exact strings, the cost, and the client mirror.
 *
 * ── WHY THE STRINGS ARE PINNED ─────────────────────────────────────────────
 *
 * The order screen previews these bodies to the shopkeeper as "this is what
 * your customer will receive", and quotes a segment count they are billed
 * against. That promise is only as good as the two copies agreeing:
 * `hisaab-backend/src/utils/smsTemplates.util.js` builds what is SENT,
 * `hisaab-frontend/lib/sms/templates.js` builds what is SHOWN.
 *
 * A preview that has drifted from the message is worse than no preview — it is
 * a wrong answer delivered confidently, and the shop pays for the difference.
 * So the strings are pinned here and the mirror is checked against this file's
 * own output, not eyeballed.
 *
 * ── WHY ENGLISH, ASSERTED ──────────────────────────────────────────────────
 *
 * One Bangla character puts a message in UCS-2 and cuts the per-segment budget
 * from 160 characters to 70. An online shop sends up to five of these per
 * order. The GSM-7 assertion below is a cost guard, not a style preference: if
 * somebody translates these bodies, every shop's SMS bill roughly doubles and
 * nothing else in the system would notice.
 */

const fs = require('fs');
const path = require('path');
const {
  ORDER_SMS_KINDS,
  buildOrderStatusSms,
  appendShopSignature,
} = require('../utils/smsTemplates.util');
const { countSms } = require('../utils/smsCounter.util');

const ORDER_NO = 'ORD-260908-0001';
const build = (kind, over = {}) =>
  buildOrderStatusSms({ kind, orderNo: ORDER_NO, total: 1450, ...over });

describe('order status SMS — the exact bodies', () => {
  it('says what each transition means, in English', () => {
    expect(build('confirmed')).toBe(
      `Order ${ORDER_NO} confirmed. Total Tk1450, cash on delivery.`
    );
    expect(build('packed')).toBe(
      `Order ${ORDER_NO} is packed and will be sent soon.`
    );
    expect(build('shipped')).toBe(
      `Order ${ORDER_NO} is on the way. Please keep Tk1450 ready.`
    );
    expect(build('delivered')).toBe(
      `Order ${ORDER_NO} is complete. Thank you for shopping with us.`
    );
    expect(build('cancelled')).toBe(
      `Order ${ORDER_NO} has been cancelled. Please call us for details.`
    );
  });

  /**
   * "On the way" is wrong for an order the customer is collecting, and "keep
   * the money ready" is wrong at their own front door.
   */
  it('changes wording for a pickup order where it would otherwise be wrong', () => {
    expect(build('confirmed', { isPickup: true })).toBe(
      `Order ${ORDER_NO} confirmed. Total Tk1450, pay when you collect it.`
    );
    expect(build('shipped', { isPickup: true })).toBe(
      `Order ${ORDER_NO} is ready. Please collect it from our shop.`
    );
    // The rest read identically either way.
    expect(build('packed', { isPickup: true })).toBe(build('packed'));
    expect(build('delivered', { isPickup: true })).toBe(build('delivered'));
  });

  /**
   * A placed order has been looked at by nobody, nothing is reserved for it,
   * and the confirmation page already told the customer it arrived. Texting
   * then spends the shop's money to repeat what is on screen.
   */
  it('has no message for `pending`, and refuses an unknown kind', () => {
    expect(ORDER_SMS_KINDS).not.toContain('pending');
    expect(buildOrderStatusSms({ kind: 'pending', orderNo: ORDER_NO })).toBeNull();
    expect(buildOrderStatusSms({ kind: 'nonsense', orderNo: ORDER_NO })).toBeNull();
  });

  it('refuses to build a message with no order number', () => {
    expect(buildOrderStatusSms({ kind: 'confirmed', orderNo: '' })).toBeNull();
    expect(buildOrderStatusSms({ kind: 'confirmed' })).toBeNull();
  });
});

describe('cost — the reason these are English', () => {
  it('stays inside ONE GSM-7 segment for a latin-named shop', () => {
    for (const kind of ORDER_SMS_KINDS) {
      const signed = appendShopSignature(build(kind), 'M/S Emdad');
      const count = countSms(signed);
      expect(count.encoding).toBe('GSM-7');
      expect(count.segments).toBe(1);
    }
  });

  /**
   * The shop's own name is the one part the template cannot control, so a
   * Bangla-named shop lands in UCS-2 regardless. The bodies are kept short
   * enough that even at 67 characters a segment it never exceeds two — which
   * is what the preview will quote them.
   */
  it('never exceeds two segments even for a Bangla-named shop', () => {
    for (const kind of ORDER_SMS_KINDS) {
      const signed = appendShopSignature(build(kind), 'হিসাব ফ্যাশন গ্যালারী');
      expect(countSms(signed).segments).toBeLessThanOrEqual(2);
    }
  });

  /** The body itself must carry no non-GSM character of its own. */
  it('contains no Bangla in the message body', () => {
    for (const kind of ORDER_SMS_KINDS) {
      expect(countSms(build(kind)).encoding).toBe('GSM-7');
    }
  });
});

describe('the client mirror does not drift', () => {
  /**
   * Structural rather than behavioural: jest cannot import the frontend's ESM
   * copy, so this reads it as text and asserts that every body this file
   * produces exists there as the same template literal.
   *
   * Crude, and it catches the failure that actually happens — somebody edits
   * one file and not the other. `smsTemplates.util.js`'s header states the
   * rule; this is what enforces it.
   */
  const mirror = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'hisaab-frontend', 'lib', 'sms', 'templates.js'),
    'utf8'
  );

  it('carries every body the server sends', () => {
    for (const kind of ORDER_SMS_KINDS) {
      for (const isPickup of [false, true]) {
        const body = buildOrderStatusSms({
          kind, orderNo: 'X1', total: 5, isPickup,
        });
        // Restore the interpolations so the literal can be found in source.
        const shape = body.replace('X1', '${no}').replace('Tk5', '${amount}');
        expect(mirror).toContain(shape);
      }
    }
  });

  it('exports the same kind list and the preview helper', () => {
    expect(mirror).toContain("export const ORDER_SMS_KINDS = ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled']");
    expect(mirror).toContain('export function buildOrderStatusSms(');
    // The one function the order screen should call — it applies the shop
    // signature the same way the server does, so the count it quotes is real.
    expect(mirror).toContain('export function previewOrderStatusSms(');
  });
});

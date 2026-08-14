/**
 * The SMS bodies, pinned.
 *
 * These strings are shown to the shopkeeper as a preview before every send, by
 * a mirrored copy of the builders living in
 * `hisaab-frontend/lib/sms/templates.js`. If a body changes on one side only,
 * the dashboard starts promising one message and the gateway delivers another —
 * and the shop pays per segment for the difference.
 *
 * So these assertions are not "does the function work". They are a tripwire: a
 * failure here means the client mirror needs the same edit, in the same commit.
 * The expected strings are written out literally rather than composed from the
 * builders, because a test that builds its own expectation with the code under
 * test cannot detect a change to it.
 */

const {
  formatSmsAmount,
  gsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
  buildShopSignature,
  hasShopSignature,
  appendShopSignature,
} = require('../utils/smsTemplates.util');
const { countSms } = require('../utils/smsCounter.util');

describe('SMS templates (mirrored in hisaab-frontend/lib/sms/templates.js)', () => {
  describe('formatSmsAmount', () => {
    it('prints whole taka without decimals', () => {
      expect(formatSmsAmount(1500)).toBe('1500');
      expect(formatSmsAmount(0)).toBe('0');
    });

    it('keeps paisa when there are any', () => {
      expect(formatSmsAmount(1500.5)).toBe('1500.50');
      expect(formatSmsAmount(99.99)).toBe('99.99');
    });

    it('treats null/undefined as zero rather than printing NaN', () => {
      expect(formatSmsAmount(null)).toBe('0');
      expect(formatSmsAmount(undefined)).toBe('0');
    });

    it('passes a non-numeric string through so template placeholders survive', () => {
      // Without this the SMS page's picker offers "Your due: Tk0".
      expect(formatSmsAmount('{due_amount}')).toBe('{due_amount}');
    });

    it('still formats a numeric string', () => {
      expect(formatSmsAmount('1500')).toBe('1500');
    });
  });

  describe('gsmSafeShopName', () => {
    it('falls back to the product name so a message never ends on a bare dash', () => {
      expect(gsmSafeShopName('')).toBe('Hisaab');
      expect(gsmSafeShopName(null)).toBe('Hisaab');
      expect(gsmSafeShopName(undefined)).toBe('Hisaab');
    });

    it('passes a real shop name through untouched', () => {
      expect(gsmSafeShopName('Rahim Store')).toBe('Rahim Store');
    });
  });

  describe('buildSaleReceipt', () => {
    it('renders the exact receipt body', () => {
      expect(
        buildSaleReceipt({
          invoiceNo: 'INV-20260814-0042',
          total: 2500,
          paid: 1500,
          due: 1000,
          shopName: 'Rahim Store',
        })
      ).toBe(
        'Inv:INV-20260814-0042\nTotal:Tk2500\nPaid:Tk1500\nDue:Tk1000\nThanks for visiting\n- Rahim Store'
      );
    });

    it('names the shop once, at the sign-off only', () => {
      const message = buildSaleReceipt({
        invoiceNo: 'INV-1',
        total: 100,
        paid: 100,
        due: 0,
        shopName: 'Rahim Store',
      });
      expect(message.split('Rahim Store')).toHaveLength(2);
    });

    it('stays inside one GSM-7 segment for a typical sale', () => {
      const info = countSms(
        buildSaleReceipt({
          invoiceNo: 'INV-20260814-0042',
          total: 2500,
          paid: 1500,
          due: 1000,
          shopName: 'Rahim Store',
        })
      );
      expect(info.encoding).toBe('GSM-7');
      expect(info.segments).toBe(1);
    });
  });

  describe('buildPaymentReceipt', () => {
    it('renders the exact payment body, opening with the bare customer name', () => {
      expect(
        buildPaymentReceipt({
          customerName: 'Rahim Mia',
          amount: 500,
          remainingDue: 1000,
          shopName: 'Rahim Store',
        })
      ).toBe('Rahim Mia,\nTk500 payment received.\nCurrent due: Tk1000\nThank you - Rahim Store');
    });
  });

  describe('buildDueReminder', () => {
    it('renders the exact reminder body', () => {
      expect(
        buildDueReminder({
          customerName: 'Rahim Mia',
          due: 1500,
          shopName: 'Rahim Store',
        })
      ).toBe(
        'Dear Rahim Mia,\nYour due: Tk1500\nPlease pay as soon as possible.\nThank you - Rahim Store'
      );
    });
  });

  describe('buildOtp', () => {
    it('renders the exact OTP body', () => {
      expect(buildOtp('123456')).toBe('Your Hisaab OTP: 123456\nValid for 5 minutes');
    });
  });

  /**
   * The sign-off every message ends on.
   *
   * These rules decide whether a shopkeeper's free-text campaign carries one
   * shop name, two, or none — and the segment count, and therefore the bill,
   * moves with that answer. Mirrored in `hisaab-frontend/lib/sms/templates.js`.
   */
  describe('appendShopSignature', () => {
    it('appends the sign-off on its own line', () => {
      expect(appendShopSignature('Eid offer 20% off', 'Rahim Store')).toBe(
        'Eid offer 20% off\n- Rahim Store'
      );
    });

    it('leaves a body that already signs off alone', () => {
      // Every built template ends this way. A second sign-off would be ~14
      // wasted characters out of a 160-character segment.
      const reminder = buildDueReminder({
        customerName: 'Rahim',
        due: 1500,
        shopName: 'Rahim Store',
      });
      expect(appendShopSignature(reminder, 'Rahim Store')).toBe(reminder);
    });

    it('is idempotent — the composer and the service both run it', () => {
      const once = appendShopSignature('Eid offer', 'Rahim Store');
      expect(appendShopSignature(once, 'Rahim Store')).toBe(once);
    });

    it('matches a hand-typed sign-off regardless of case', () => {
      expect(appendShopSignature('Eid offer - rahim store', 'Rahim Store')).toBe(
        'Eid offer - rahim store'
      );
    });

    it('still signs a message that only mentions the shop mid-sentence', () => {
      expect(appendShopSignature('Rahim Store is closed Friday', 'Rahim Store')).toBe(
        'Rahim Store is closed Friday\n- Rahim Store'
      );
    });

    it('trims trailing whitespace so the sign-off never floats on a blank line', () => {
      expect(appendShopSignature('Eid offer\n\n  ', 'Rahim Store')).toBe(
        'Eid offer\n- Rahim Store'
      );
    });

    it('falls back to the product name rather than signing with a bare dash', () => {
      expect(appendShopSignature('Eid offer', '')).toBe('Eid offer\n- Hisaab');
      expect(buildShopSignature(null)).toBe('- Hisaab');
    });

    it('signs an empty draft with just the sign-off', () => {
      expect(appendShopSignature('', 'Rahim Store')).toBe('- Rahim Store');
    });

    it('reports whether a body is already signed', () => {
      expect(hasShopSignature('Eid offer - Rahim Store', 'Rahim Store')).toBe(true);
      expect(hasShopSignature('Rahim Store is closed', 'Rahim Store')).toBe(false);
    });

    it('counts the sign-off into the segment budget', () => {
      // Why the service signs BEFORE counting: 155 characters is one segment,
      // the same message signed is two, and the shop pays for two.
      const draft = 'A'.repeat(155);
      expect(countSms(draft).segments).toBe(1);
      expect(countSms(appendShopSignature(draft, 'Rahim Store')).segments).toBe(2);
    });
  });
});

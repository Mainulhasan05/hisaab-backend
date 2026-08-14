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
});

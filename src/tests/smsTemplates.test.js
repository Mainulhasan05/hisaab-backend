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
    it('renders the exact Bangla receipt body', () => {
      expect(
        buildSaleReceipt({
          invoiceNo: 'INV-20260814-0042',
          total: 2500,
          paid: 1500,
          due: 1000,
          shopName: 'Rahim Store',
        })
      ).toBe(
        'চালান INV-20260814-0042\nবিল ৳2500\nজমা ৳1500\nবাকি ৳1000\nধন্যবাদ\n- Rahim Store'
      );
    });

    it('renders the exact English receipt body when the shop chose en', () => {
      expect(
        buildSaleReceipt({
          invoiceNo: 'INV-20260814-0042',
          total: 2500,
          paid: 1500,
          due: 1000,
          shopName: 'Rahim Store',
          language: 'en',
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

    /* ── The balance line ────────────────────────────────────────────────────
     *
     * The reported bug: a customer carrying a ৳2,600 খাতা bought ৳890 and paid
     * ৳500. The receipt said `Due:Tk390` and stopped — true about the invoice,
     * and the only figure they were given. */
    it("prints the customer's whole balance when it exceeds this invoice's due", () => {
      const message = buildSaleReceipt({
        invoiceNo: '12345',
        total: 890,
        paid: 500,
        due: 390,
        totalDue: 2990,
        shopName: 'Rahim Store',
      });
      expect(message).toContain('বাকি ৳390');
      expect(message).toContain('মোট বাকি ৳2990');
    });

    it('omits the balance line when the invoice due IS the whole balance', () => {
      const message = buildSaleReceipt({
        invoiceNo: '12345',
        total: 890,
        paid: 500,
        due: 390,
        totalDue: 390,
        shopName: 'Rahim Store',
      });
      expect(message).not.toContain('মোট বাকি');
    });

    // A caller that cannot compute the balance must print nothing rather than
    // print ৳0 and tell a customer who owes ৳2,990 that they are clear.
    it('omits the balance line when the caller did not supply one', () => {
      const message = buildSaleReceipt({
        invoiceNo: '12345',
        total: 890,
        paid: 500,
        due: 390,
        shopName: 'Rahim Store',
      });
      expect(message).not.toContain('মোট বাকি');
    });

    it('drops the zero lines a cash sale and a credit sale do not need', () => {
      const cash = buildSaleReceipt({
        invoiceNo: 'INV-1', total: 100, paid: 100, due: 0, shopName: 'Rahim Store',
      });
      expect(cash).not.toContain('বাকি');
      expect(cash).toContain('জমা ৳100');

      const credit = buildSaleReceipt({
        invoiceNo: 'INV-1', total: 100, paid: 0, due: 100, shopName: 'Rahim Store',
      });
      expect(credit).not.toContain('জমা');
      expect(credit).toContain('বাকি ৳100');
    });

    it('names the settled khata on a settling sale', () => {
      const message = buildSaleReceipt({
        invoiceNo: 'INV-1',
        total: 500,
        paid: 2700,
        due: 0,
        dueSettled: 2200,
        totalDue: 400,
        shopName: 'Rahim Store',
      });
      expect(message).toContain('আগের বাকি জমা ৳2200');
      expect(message).toContain('মোট বাকি ৳400');
    });

    /* ── Cost ────────────────────────────────────────────────────────────────
     *
     * Bangla is UCS-2, so the budget is 70 characters alone and 67 per part of a
     * multipart. Two segments is the ceiling this body is designed to; the test
     * uses the longest realistic shape — a generated invoice number, a
     * settlement, and a running balance all at once. */
    it('stays within two segments for the longest realistic Bangla receipt', () => {
      const info = countSms(
        buildSaleReceipt({
          invoiceNo: 'INV-MAIN-20260822-0001',
          total: 2500,
          paid: 12000,
          due: 0,
          dueSettled: 9500,
          totalDue: 4300,
          shopName: 'হিসাব ফ্যাশন গ্যালারী',
        })
      );
      expect(info.encoding).toBe('Unicode');
      expect(info.segments).toBeLessThanOrEqual(2);
    });

    it('stays inside one GSM-7 segment for an en shop with an ASCII name', () => {
      const info = countSms(
        buildSaleReceipt({
          invoiceNo: 'INV-20260814-0042',
          total: 2500,
          paid: 1500,
          due: 1000,
          totalDue: 4300,
          shopName: 'Rahim Store',
          language: 'en',
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

/* ────────────────────────────────────────────────────────────────────────────
 * Per-shop invoice templates
 *
 * Same tripwire discipline as above: every one of these functions is mirrored
 * in `hisaab-frontend/lib/sms/templates.js`, and the admin panel's editor
 * previews a shop's receipt with the mirror before an operator saves a template
 * this file's copy will send. A failure here means the mirror needs the same
 * edit, in the same commit.
 * ──────────────────────────────────────────────────────────────────────────── */

const {
  toLocalDigits,
  formatTemplateMoney,
  formatTemplateDate,
  renderInvoiceTemplate,
  validateInvoiceTemplate,
  buildInvoiceSms,
  INVOICE_SMS_TOKENS,
  INVOICE_SMS_SAMPLES,
  MAX_INVOICE_TEMPLATE_LENGTH,
} = require('../utils/smsTemplates.util');

/** The template from the request this feature was built for, verbatim. */
const SHOP_TEMPLATE = [
  'আসসালামু আলাইকুম',
  '{customer_name}',
  'ইনভয়েস নম্বর: #{invoice_no}',
  'তারিখ: {date}',
  '*মোট ক্রয়: ৳{total}',
  '*পূর্বের বাকি: ৳{previous_due}',
  '*সর্বমোট বাকি : ৳{total_due}',
  'ধন্যবাদ আমাদের সাথে কেনাকাটার জন্য!',
].join('\n');

describe('per-shop invoice SMS templates', () => {
  describe('toLocalDigits', () => {
    it('leaves digits alone unless the shop asked for Bangla', () => {
      expect(toLocalDigits('1,80,350')).toBe('1,80,350');
      expect(toLocalDigits('1,80,350', 'en')).toBe('1,80,350');
    });

    it('converts every digit, and only digits', () => {
      expect(toLocalDigits('17/8/2026', 'bn')).toBe('১৭/৮/২০২৬');
      // Separators and Bangla text pass through untouched.
      expect(toLocalDigits('বাকি ৳1,250', 'bn')).toBe('বাকি ৳১,২৫০');
    });
  });

  describe('formatTemplateMoney', () => {
    it('groups in lakhs, the way the figure is written on a paper khata', () => {
      expect(formatTemplateMoney(180350)).toBe('1,80,350');
      expect(formatTemplateMoney(9000)).toBe('9,000');
      expect(formatTemplateMoney(180350, 'bn')).toBe('১,৮০,৩৫০');
    });

    it('keeps paisa when there are any and drops them when there are not', () => {
      expect(formatTemplateMoney(1500)).toBe('1,500');
      expect(formatTemplateMoney(1500.5)).toBe('1,500.50');
    });

    it('treats null/undefined as zero rather than printing NaN', () => {
      expect(formatTemplateMoney(null)).toBe('0');
      expect(formatTemplateMoney(undefined, 'bn')).toBe('০');
    });
  });

  describe('formatTemplateDate', () => {
    it('renders Dhaka local, unpadded', () => {
      expect(formatTemplateDate('2026-08-17T06:00:00.000Z')).toBe('17/8/2026');
      expect(formatTemplateDate('2026-08-17T06:00:00.000Z', 'bn')).toBe('১৭/৮/২০২৬');
    });

    it('uses the Dhaka day, not UTC — a 9pm sale is not dated yesterday', () => {
      // 2026-08-17T18:30Z is 2026-08-18 00:30 in Dhaka (UTC+6).
      expect(formatTemplateDate('2026-08-17T18:30:00.000Z')).toBe('18/8/2026');
    });

    it('renders nothing rather than "Invalid Date" for junk', () => {
      expect(formatTemplateDate('not-a-date')).toBe('');
    });
  });

  describe('renderInvoiceTemplate', () => {
    it('renders the shop’s template exactly as the shop wrote it', () => {
      const khata = INVOICE_SMS_SAMPLES.find((s) => s.id === 'khata');
      expect(renderInvoiceTemplate(SHOP_TEMPLATE, khata.facts, 'bn')).toBe(
        [
          'আসসালামু আলাইকুম',
          'মোঃ পারভেজ ইসলাম',
          'ইনভয়েস নম্বর: #১৬২৮৫',
          'তারিখ: ১৭/৮/২০২৬',
          '*মোট ক্রয়: ৳৯,০০০',
          '*পূর্বের বাকি: ৳১,৮০,৩৫০',
          '*সর্বমোট বাকি : ৳১,৮৯,৩৫০',
          'ধন্যবাদ আমাদের সাথে কেনাকাটার জন্য!',
        ].join('\n')
      );
    });

    it('drops the balance lines for a customer who owes nothing', () => {
      // The whole point of the empty-line rule: a cash walk-in is not texted
      // `*পূর্বের বাকি: ৳০`, which is true, useless and billed for.
      const cash = INVOICE_SMS_SAMPLES.find((s) => s.id === 'cash');
      expect(renderInvoiceTemplate(SHOP_TEMPLATE, cash.facts, 'bn')).toBe(
        [
          'আসসালামু আলাইকুম',
          'রহিম উদ্দিন',
          'ইনভয়েস নম্বর: #১৬২৮৬',
          'তারিখ: ১৭/৮/২০২৬',
          '*মোট ক্রয়: ৳১,২৫০',
          'ধন্যবাদ আমাদের সাথে কেনাকাটার জন্য!',
        ].join('\n')
      );
    });

    it('keeps a line when only SOME of its money tokens are zero', () => {
      expect(
        renderInvoiceTemplate('জমা {paid} · বাকি {due}', { paid: 0, due: 500 })
      ).toBe('জমা 0 · বাকি 500');
    });

    it('never drops a line that carries no money token', () => {
      expect(
        renderInvoiceTemplate('আসসালামু আলাইকুম\n{customer_name}\n{total}', {
          customerName: 'রহিম',
          total: 0,
        })
      ).toBe('আসসালামু আলাইকুম\nরহিম');
    });

    it('leaves an unknown token in place so the caller can refuse to send it', () => {
      expect(renderInvoiceTemplate('আগের {previus_due}', {})).toBe('আগের {previus_due}');
    });

    it('does not group the invoice number — it is an identifier, not money', () => {
      expect(renderInvoiceTemplate('#{invoice_no}', { invoiceNo: '16285' }, 'bn')).toBe('#১৬২৮৫');
    });
  });

  describe('validateInvoiceTemplate', () => {
    const countSegments = (message) => require('../utils/smsCounter.util').countSms(message).segments;

    it('accepts an empty template — that is the off switch', () => {
      expect(validateInvoiceTemplate('')).toMatchObject({ valid: true, empty: true });
      expect(validateInvoiceTemplate('   ')).toMatchObject({ valid: true, empty: true });
      expect(validateInvoiceTemplate(null)).toMatchObject({ valid: true, empty: true });
    });

    it('accepts the shop template from the original request', () => {
      expect(
        validateInvoiceTemplate(SHOP_TEMPLATE, {
          shopName: 'হিসাব ফ্যাশন',
          numerals: 'bn',
          countSegments,
        })
      ).toMatchObject({ valid: true, segments: 3 });
    });

    it('names every misspelt placeholder rather than the first', () => {
      const result = validateInvoiceTemplate('{previus_due} and {totl}');
      expect(result.valid).toBe(false);
      expect(result.unknownTokens).toEqual(['{previus_due}', '{totl}']);
      expect(result.reasonBn).toContain('{previus_due}');
    });

    it('refuses a body that would be billed above the segment ceiling', () => {
      const long = `${'পূর্বের বাকি {previous_due}\n'.repeat(12)}`;
      const result = validateInvoiceTemplate(long, {
        shopName: 'হিসাব ফ্যাশন',
        numerals: 'bn',
        countSegments,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/segments/);
    });

    it('refuses a body longer than the schema will store', () => {
      const result = validateInvoiceTemplate('ক'.repeat(MAX_INVOICE_TEMPLATE_LENGTH + 1));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/characters/);
    });

    it('cannot be fooled by a stale regex lastIndex across calls', () => {
      // `tokenPattern()` is built per call precisely so this holds; a shared
      // /g regex would report the second call clean.
      expect(validateInvoiceTemplate('{nope}').unknownTokens).toEqual(['{nope}']);
      expect(validateInvoiceTemplate('{nope}').unknownTokens).toEqual(['{nope}']);
    });
  });

  describe('buildInvoiceSms', () => {
    const facts = {
      invoiceNo: 'INV-20260814-0042',
      total: 2500,
      paid: 1500,
      due: 1000,
      shopName: 'Rahim Store',
    };

    it('sends the platform receipt, byte for byte, when the shop has no template', () => {
      // The regression that matters most: every shop on the platform has an
      // empty template, and none of their receipts may change.
      expect(buildInvoiceSms(facts)).toBe(
        'চালান INV-20260814-0042\nবিল ৳2500\nজমা ৳1500\nবাকি ৳1000\nধন্যবাদ\n- Rahim Store'
      );
      expect(buildInvoiceSms({ ...facts, template: '' })).toBe(buildInvoiceSms(facts));
      expect(buildInvoiceSms({ ...facts, template: '   ' })).toBe(buildInvoiceSms(facts));
    });

    it('sends the shop’s wording when it has one', () => {
      expect(
        buildInvoiceSms({
          ...facts,
          template: 'বিল {total}\nবাকি {due}',
        })
      ).toBe('বিল 2,500\nবাকি 1,000');
    });

    it('falls back rather than text a customer a literal placeholder', () => {
      // Save-time validation cannot protect a template that was stored before a
      // token was renamed. A standard receipt is a cosmetic regression; `৳{x}`
      // on a customer's phone is the shop looking broken at its own expense.
      expect(buildInvoiceSms({ ...facts, template: 'বাকি ৳{previus_due}' })).toBe(
        buildInvoiceSms(facts)
      );
    });

    it('falls back when the template renders to nothing at all', () => {
      // Every line was a zero-valued money line, so the empty-line rule ate the
      // whole body. Sending nothing is not an option; the platform body is.
      expect(buildInvoiceSms({ ...facts, due: 0, paid: 0, template: 'বাকি {due}' })).toBe(
        buildInvoiceSms({ ...facts, due: 0, paid: 0 })
      );
    });

    it('honours the shop’s numerals', () => {
      expect(buildInvoiceSms({ ...facts, template: 'বিল {total}', numerals: 'bn' })).toBe(
        'বিল ২,৫০০'
      );
    });

    it('offers previous_due, which the platform body has no line for', () => {
      expect(
        buildInvoiceSms({ ...facts, previousDue: 180350, template: 'আগের {previous_due}' })
      ).toBe('আগের 1,80,350');
    });
  });

  describe('the token palette', () => {
    it('is the same set the renderer substitutes', () => {
      // The admin editor builds its insert buttons from INVOICE_SMS_TOKENS. A
      // button offering a token the renderer does not know is how a literal
      // brace reaches a customer.
      for (const { token } of INVOICE_SMS_TOKENS) {
        expect(validateInvoiceTemplate(token).valid).toBe(true);
      }
    });

    it('resolves every token to something, given a full sample', () => {
      const body = renderInvoiceTemplate(
        INVOICE_SMS_TOKENS.map((t) => `x${t.token}`).join('\n'),
        { ...INVOICE_SMS_SAMPLES[2].facts, shopName: 'Rahim Store' }
      );
      expect(body).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
    });
  });
});

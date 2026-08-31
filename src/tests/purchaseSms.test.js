/**
 * Phase I — texting a SUPPLIER what the challan says.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Not a receipt: the vendor already has the paper, they wrote it. It exists to
 * confirm what the SHOP believes it now owes, so a disagreement surfaces this
 * week rather than at month end. That is also why it is manual — a shop texting
 * every vendor on every delivery is a bill it did not ask for.
 *
 * Groups (AGENT_WORKFLOW.md §7.1):
 *
 *   A. THE BODY — the exact strings, pinned. This is a billed message and the
 *      shopkeeper is shown it before it goes.
 *
 *   B. THE TOKEN SETS STAY APART — a customer must never be texted the word
 *      সরবরাহকারী, and the only thing preventing it is that the validator is
 *      handed the right set.
 *
 *   C. PARITY — the client mirror and this file must agree, or the preview is
 *      a wrong answer delivered confidently and the shop pays the difference.
 */

const fs = require('fs');
const path = require('path');
const {
  buildPurchaseReceipt,
  buildPurchaseSms,
  validateInvoiceTemplate,
  PURCHASE_SMS_TOKENS,
  PURCHASE_TOKEN_KINDS,
  PURCHASE_SMS_SAMPLES,
  INVOICE_TOKEN_KINDS,
} = require('../utils/smsTemplates.util');

/* ── A. THE BODY ──────────────────────────────────────────────────────────── */

describe('the built-in চালান confirmation', () => {
  it('names the vendor\'s own bill number when we have it', () => {
    // Ours means nothing to them — they cannot look up `PUR2026080014`.
    const body = buildPurchaseReceipt({
      invoiceNo: 'PUR2026080014', supplierInvoiceNo: 'RT-9912',
      total: 9000, paid: 9000, due: 0, shopName: 'হিসাব',
    });
    expect(body.split('\n')[0]).toBe('চালান RT-9912');
  });

  it('falls back to ours when they gave us nothing', () => {
    const body = buildPurchaseReceipt({
      invoiceNo: 'PUR-1', total: 9000, paid: 9000, due: 0, shopName: 'হিসাব',
    });
    expect(body.split('\n')[0]).toBe('চালান PUR-1');
  });

  it('drops every line that would say nothing', () => {
    // Billed by the segment: `পরিশোধ ৳0` on a pure credit purchase and
    // `বাকি ৳0` on a cash one are noise the vendor reads past, and on a UCS-2
    // body either can be the line that buys another segment.
    const cash = buildPurchaseReceipt({
      invoiceNo: 'PUR-2', total: 2440, paid: 2440, due: 0, totalDue: 0, shopName: 'হিসাব',
    });
    expect(cash).toBe('চালান PUR-2\nমোট ৳2440\nপরিশোধ ৳2440\n- হিসাব');
  });

  it('prints the running balance only when it differs from this challan', () => {
    // A vendor with no খাতা would otherwise read the same figure twice and take
    // it as two debts — the same call `showsTotalDue` makes on the sale side.
    const noKhata = buildPurchaseReceipt({
      invoiceNo: 'P', total: 1000, paid: 0, due: 1000, totalDue: 1000, shopName: 'হ',
    });
    expect(noKhata).not.toContain('মোট বাকি');

    const withKhata = buildPurchaseReceipt({
      invoiceNo: 'P', total: 1000, paid: 0, due: 1000, totalDue: 181350, shopName: 'হ',
    });
    expect(withKhata).toContain('মোট বাকি ৳181350');
  });

  it('says when old debt was cleared at the same counter', () => {
    // Without the line the vendor sees পূর্বের বাকি and মোট বাকি and cannot
    // work out why they do not differ by this bill alone.
    const body = buildPurchaseReceipt({
      invoiceNo: 'P', total: 9000, paid: 9000, due: 0,
      dueSettled: 50000, totalDue: 130350, shopName: 'হ',
    });
    expect(body).toContain('পুরোনো বাকি জমা ৳50000');
  });

  it('signs off with the shop, once', () => {
    const body = buildPurchaseReceipt({ invoiceNo: 'P', total: 1, paid: 1, due: 0, shopName: 'হিসাব' });
    expect(body.match(/হিসাব/g)).toHaveLength(1);
    expect(body.endsWith('- হিসাব')).toBe(true);
  });
});

describe('a custom template', () => {
  it('is used when it renders cleanly', () => {
    const out = buildPurchaseSms({
      template: '{shop_name}\nক্রয় {invoice_no}\nমোট বাকি ৳{total_due}',
      invoiceNo: 'PUR-3', total: 100, paid: 0, due: 100, totalDue: 5000, shopName: 'হিসাব',
    });
    // Grouped, because a CUSTOM template renders money through
    // `formatTemplateMoney` while the built-in body uses the terser
    // `formatSmsAmount`. The two differ deliberately: a hand-written body is
    // the shop's own wording and reads better with separators; the built-in is
    // priced to the character.
    expect(out).toBe('হিসাব\nক্রয় PUR-3\nমোট বাকি ৳5,000');
  });

  it('is DISCARDED when it leaves a typo behind', () => {
    // A supplier receiving `৳{previus_due}` is the shop looking broken to its
    // own vendor, at its own expense. The built-in body goes instead.
    const out = buildPurchaseSms({
      template: 'বাকি ৳{previus_due}',
      invoiceNo: 'PUR-4', total: 100, paid: 100, due: 0, shopName: 'হিসাব',
    });
    expect(out).toContain('চালান PUR-4');
    expect(out).not.toContain('{');
  });

  it('drops a line whose every money token is zero', () => {
    const out = buildPurchaseSms({
      template: 'ক্রয় {invoice_no}\nপূর্বের বাকি ৳{previous_due}\nমোট ৳{total}',
      invoiceNo: 'PUR-5', total: 700, paid: 700, due: 0, previousDue: 0, shopName: 'হ',
    });
    expect(out).not.toContain('পূর্বের বাকি');
    expect(out).toContain('মোট ৳700');
  });
});

/* ── B. THE TOKEN SETS STAY APART ─────────────────────────────────────────── */

describe('a template cannot name a party its document does not have', () => {
  it('refuses {supplier_name} on a SALE template', () => {
    // The whole guard. Without it a customer gets a receipt addressed to
    // "সরবরাহকারী", and the shop pays for the privilege.
    const res = validateInvoiceTemplate('{supplier_name} ভাই, ৳{total}', {
      kinds: INVOICE_TOKEN_KINDS,
    });
    expect(res.valid).toBe(false);
    expect(res.unknownTokens).toContain('{supplier_name}');
  });

  it('refuses {customer_name} on a PURCHASE template', () => {
    const res = validateInvoiceTemplate('{customer_name} ভাই, ৳{total}', {
      kinds: PURCHASE_TOKEN_KINDS,
      samples: PURCHASE_SMS_SAMPLES,
    });
    expect(res.valid).toBe(false);
    expect(res.unknownTokens).toContain('{customer_name}');
  });

  it('accepts the supplier tokens on a purchase template', () => {
    const res = validateInvoiceTemplate('{supplier_name}\nবিল {supplier_invoice_no}\n৳{total_due}', {
      kinds: PURCHASE_TOKEN_KINDS,
      samples: PURCHASE_SMS_SAMPLES,
    });
    expect(res.valid).toBe(true);
  });

  it('prices against the LARGEST sample', () => {
    // A template validated on small numbers starts failing the day the shop's
    // biggest delivery arrives, which is the worst possible moment to find out.
    const [worst] = PURCHASE_SMS_SAMPLES;
    expect(worst.facts.totalDue).toBeGreaterThan(100000);
  });
});

/* ── C. PARITY ────────────────────────────────────────────────────────────── */

describe('the client mirror says the same thing', () => {
  const mirror = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'hisaab-frontend', 'lib', 'sms', 'templates.js'),
    'utf8'
  );

  it('carries the same built-in labels, in the same order', () => {
    // The dashboard shows the shopkeeper "this is what your supplier will
    // receive" BEFORE anything is sent, and that promise is only as good as the
    // two files agreeing. A drifted preview is a wrong answer delivered
    // confidently, billed per segment.
    for (const label of ['চালান ', 'মোট', 'পরিশোধ', 'পুরোনো বাকি জমা', 'বাকি', 'মোট বাকি']) {
      expect(mirror).toContain(label);
    }
    const block = mirror.slice(mirror.indexOf('export function buildPurchaseReceipt'));
    expect(block.indexOf("money('পরিশোধ'")).toBeLessThan(block.indexOf("money('পুরোনো বাকি জমা'"));
    expect(block.indexOf("money('পুরোনো বাকি জমা'")).toBeLessThan(block.indexOf("money('বাকি'"));
  });

  it('carries the same token set', () => {
    for (const { token } of PURCHASE_SMS_TOKENS) {
      expect(mirror).toContain(`'${token}'`);
    }
  });

  it('applies the same fallback rule', () => {
    // A template with a leftover token is discarded on BOTH sides, or the
    // preview shows a clean body and the vendor gets a broken one.
    const block = mirror.slice(mirror.indexOf('export function buildPurchaseSms'));
    expect(block).toContain('tokenPattern().test(rendered)');
    expect(block).toContain('buildPurchaseReceipt({');
  });
});

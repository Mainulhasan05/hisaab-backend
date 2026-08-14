/**
 * Bulk campaign plumbing, pinned.
 *
 * Two things decide what a bulk send costs and who it reaches, and neither is
 * visible once a campaign is running: which recipients survive the cleaning
 * pass, and what each of their messages renders to. Both are cheap to get
 * subtly wrong and expensive to discover afterwards — the shop has already
 * paid, and the customers have already read whatever went out.
 *
 * The personalisation rules here are mirrored in
 * `hisaab-frontend/lib/sms/personalize.js`, which is what draws the composer's
 * preview. A failure in that block means the preview and the send have drifted,
 * and the dashboard is showing a message nobody will receive.
 */

const {
  normalizeRecipients,
  chunk,
  SKIP_REASONS,
} = require('../utils/smsRecipients.util');
const {
  isPersonalized,
  personalizeMessage,
} = require('../utils/smsPersonalize.util');

describe('normalizeRecipients', () => {
  it('formats every surviving number to the gateway format', () => {
    const { valid } = normalizeRecipients([
      { phone: '01712345678', customerName: 'Rahim' },
      { phone: '+8801812345678', customerName: 'Karim' },
    ]);

    expect(valid.map((r) => r.phone)).toEqual(['8801712345678', '8801812345678']);
  });

  it('drops customers with no phone at all', () => {
    // Walk-in customers are routinely saved with a name and nothing else.
    const { valid, skipped } = normalizeRecipients([
      { phone: '01712345678', customerName: 'Rahim' },
      { phone: '', customerName: 'Walk-in' },
      { phone: null, customerName: 'Cash sale' },
    ]);

    expect(valid).toHaveLength(1);
    expect(skipped.map((s) => s.reason)).toEqual([
      SKIP_REASONS.MISSING,
      SKIP_REASONS.MISSING,
    ]);
  });

  it('drops numbers that are not Bangladeshi mobiles', () => {
    const { valid, skipped } = normalizeRecipients([
      { phone: '01712345678' },
      { phone: '028912345' }, // landline
      { phone: '12345' },
    ]);

    expect(valid).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.reason === SKIP_REASONS.INVALID)).toBe(true);
  });

  it('collapses the same phone written two ways into one send', () => {
    // The book holds one household under two entries. Texting them twice costs
    // two segments and reads as spam.
    const { valid, skipped } = normalizeRecipients([
      { phone: '01712345678', customerName: 'Rahim Mia' },
      { phone: '8801712345678', customerName: 'Rahim' },
      { phone: '+8801712345678', customerName: 'R. Mia' },
    ]);

    expect(valid).toHaveLength(1);
    // The first spelling wins, so the log names the customer the shopkeeper saw.
    expect(valid[0].customerName).toBe('Rahim Mia');
    expect(skipped.every((s) => s.reason === SKIP_REASONS.DUPLICATE)).toBe(true);
  });

  it('drops personalised recipients with no body of their own', () => {
    const { valid, skipped } = normalizeRecipients(
      [
        { phone: '01712345678', message: 'Dear Rahim' },
        { phone: '01812345678', message: '   ' },
      ],
      { requireMessage: true }
    );

    expect(valid).toHaveLength(1);
    expect(skipped[0].reason).toBe(SKIP_REASONS.EMPTY_MESSAGE);
  });

  it('keeps an empty per-recipient body when the campaign is not personalised', () => {
    const { valid } = normalizeRecipients([{ phone: '01712345678' }]);
    expect(valid).toHaveLength(1);
  });
});

describe('chunk', () => {
  it('splits into full batches plus a remainder', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = chunk(items, 100);

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(items);
  });

  it('returns nothing for an empty list rather than one empty batch', () => {
    // An empty batch would be a gateway call with no recipients — billed as a
    // failure and refunded, for nothing.
    expect(chunk([], 100)).toEqual([]);
  });

  it('never produces a zero-size batch, however it is called', () => {
    expect(chunk([1, 2, 3], 0).map((b) => b.length)).toEqual([1, 1, 1]);
  });
});

describe('isPersonalized', () => {
  it('is true for a body that varies per recipient', () => {
    expect(isPersonalized('Dear {customer_name}, your due is Tk{due_amount}')).toBe(true);
  });

  it('is FALSE for a body whose only token is the shop name', () => {
    // This is the whole point of the distinction: {shop_name} resolves the same
    // for everyone, so the send stays a single cheap bulk call instead of
    // becoming N individually-addressed ones.
    expect(isPersonalized('Eid offer 20% off - {shop_name}')).toBe(false);
  });

  it('is false for plain text', () => {
    expect(isPersonalized('Shop closed on Friday')).toBe(false);
  });
});

describe('personalizeMessage', () => {
  it('fills the customer name and due', () => {
    expect(
      personalizeMessage('Dear {customer_name}, your due is Tk{due_amount}', {
        name: 'Rahim Mia',
        due: 1500,
      })
    ).toBe('Dear Rahim Mia, your due is Tk1500');
  });

  it('falls back to "Customer" rather than leaving a hole', () => {
    expect(personalizeMessage('Dear {customer_name}', {})).toBe('Dear Customer');
  });

  it('reads totalDue when due is absent', () => {
    // resolveAudience returns `due`; a raw customer document carries `totalDue`.
    expect(personalizeMessage('Tk{due_amount}', { totalDue: 250 })).toBe('Tk250');
  });

  it('treats a zero due as zero, not as missing', () => {
    expect(personalizeMessage('Tk{due_amount}', { due: 0 })).toBe('Tk0');
  });

  it('resolves the payment-receipt tokens to the outstanding due', () => {
    // A campaign is attached to no payment, so this is the only figure it knows.
    expect(personalizeMessage('{amount}/{remaining_due}', { due: 300 })).toBe('300/300');
  });

  it('renders sale tokens honestly rather than flatteringly', () => {
    // The same values go into the preview, so the shopkeeper meets the
    // awkwardness before four hundred customers do.
    expect(personalizeMessage('Inv:{invoice_no} Total:{total} Paid:{paid}', {})).toBe(
      'Inv:N/A Total:0 Paid:0'
    );
  });

  it('fills the shop name, falling back to the product name', () => {
    expect(personalizeMessage('- {shop_name}', {}, 'Rahim Store')).toBe('- Rahim Store');
    expect(personalizeMessage('- {shop_name}', {}, '')).toBe('- Hisaab');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(personalizeMessage('{customer_name} {customer_name}', { name: 'Rahim' })).toBe(
      'Rahim Rahim'
    );
  });
});

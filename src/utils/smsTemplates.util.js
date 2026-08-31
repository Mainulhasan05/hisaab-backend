/**
 * SMS message bodies — the single source of truth for every message this app
 * sends on a shop's behalf.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIRRORED ON THE CLIENT. KEEP THEM IDENTICAL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `hisaab-frontend/lib/sms/templates.js` is a character-for-character copy of
 * the builders below, and the dashboard shows its output to the shopkeeper as
 * "this is what your customer will receive" before anything is sent.
 *
 * That promise is only as good as the two files agreeing. A preview that drifts
 * from what actually goes out is worse than no preview at all — it is a wrong
 * answer delivered confidently, and the shopkeeper is paying per segment for
 * the difference. So: any edit here is an edit there, in the same commit.
 * `src/tests/smsTemplates.test.js` pins the exact strings on this side.
 *
 * The duplication is deliberate and follows the precedent already set by
 * `smsCounter.util.js` / `lib/utils/smsCounter.js`. The alternative — asking the
 * server what it would send — costs a round trip in the POS hot path and is
 * simply unavailable when the till is offline, which is exactly when a sale is
 * being parked for later sync and the cashier still needs to know what the
 * customer will get.
 *
 * ENCODING. A single Bangla character flips a message to UCS-2 and cuts the
 * per-segment budget from 160 characters to 70 (67 in a multipart). The
 * non-receipt bodies below stay inside GSM-7 for that reason, and the shop name
 * is the one part we cannot control; see `gsmSafeShopName`.
 *
 * The sale receipt does not, and deliberately: it is read by the CUSTOMER, not
 * by the shop, and half the shops on the platform have a Bangla name that put
 * the message in UCS-2 regardless — so for them the English labels bought
 * nothing and cost a line of information. It is bounded at two segments for
 * every realistic set of figures, and `settings.smsSettings.language` returns a
 * shop to the one-segment English body.
 */

/**
 * Money, as it appears in a message.
 *
 * Whole taka print bare (`1500`, not `1500.00`) because trailing zeros cost two
 * characters each in a 160-character budget and read as noise to a shopkeeper.
 * Paisa survive when they exist.
 *
 * A non-numeric string passes through untouched, which is what lets the SMS
 * page's template picker run `{due_amount}` through these same builders instead
 * of keeping a second, drift-prone copy of every message. Without the escape
 * hatch `Number('{due_amount}') || 0` renders the placeholder as `0` and the
 * shopkeeper is offered a template that reads "Your due: Tk0".
 */
const formatSmsAmount = (amount) => {
  if (typeof amount === 'string' && amount.trim() !== '' && Number.isNaN(Number(amount))) {
    return amount;
  }
  const value = Number(amount) || 0;
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
};

/**
 * The shop's sign-off. Falls back to the product name for shops that somehow
 * have none, so a message never ends on a dangling dash.
 */
const gsmSafeShopName = (shopName) => {
  if (!shopName) {
    return 'Hisaab';
  }
  return shopName;
};

/**
 * The two receipt vocabularies.
 *
 * `bn` is the default and the one a Bangladeshi customer actually reads. It is
 * not free for every shop: a receipt is UCS-2 the moment ANY Bangla character
 * is in it, which cuts the segment budget from 160 to 70 (67 in a multipart).
 * For the shops whose NAME is already Bangla — half the platform — the message
 * was UCS-2 regardless and Bangla labels cost nothing. For a shop named in
 * ASCII, `bn` is the difference between one segment and two, which is why
 * `settings.smsSettings.language` exists and why `en` is kept complete rather
 * than deleted.
 *
 * `৳` rather than `Tk` in the Bangla set: one character instead of two, in a
 * 67-character budget, four times per message.
 */
const RECEIPT_TEXT = {
  bn: {
    sep: ' ',
    currency: '৳',
    invoice: 'চালান',
    // `বিল`, not `মোট` — `মোট বাকি` two lines down is the customer's whole
    // balance, and a receipt that opens `মোট ৳890` and closes `মোট বাকি ৳2990`
    // invites reading the second as a restatement of the first. It is also the
    // word the till puts on the same figure.
    total: 'বিল',
    paid: 'জমা',
    due: 'বাকি',
    oldDuePaid: 'আগের বাকি জমা',
    // The deposit the shop is HOLDING. Not a debt and not a payment — the one
    // line that stops a customer believing their surplus was pocketed.
    advance: 'অগ্রিম জমা',
    totalDue: 'মোট বাকি',
    thanks: 'ধন্যবাদ',
  },
  en: {
    sep: ':',
    currency: 'Tk',
    invoice: 'Inv',
    total: 'Total',
    paid: 'Paid',
    due: 'Due',
    oldDuePaid: 'Old due paid',
    advance: 'Advance held',
    totalDue: 'Total due',
    thanks: 'Thanks for visiting',
  },
};

/**
 * Should the customer's whole outstanding balance be printed?
 *
 * Only when it says something the `due` line does not. A customer with no খাতা
 * has `totalDue === due` and a second identical figure would read as a second
 * debt; spending ~18 UCS-2 characters to confuse them is the worst of both.
 *
 * `null` — the default — means the caller did not compute it. That is a real
 * case (the re-send on the sale detail page had no balance in hand until this
 * change), and it must print nothing rather than print `৳0` and tell a customer
 * owing ৳2,990 that they are clear.
 *
 * A non-numeric string is a `{total_due}` placeholder from the SMS page's
 * template picker and always prints, so the picker shows the whole shape of the
 * message.
 */
const showsTotalDue = (totalDue, due) => {
  if (totalDue === null || totalDue === undefined || totalDue === '') return false;
  if (typeof totalDue === 'string' && Number.isNaN(Number(totalDue))) return true;
  return (Number(totalDue) || 0) > (Number(due) || 0);
};

/**
 * Sale receipt — sent on sale creation, either by the shop's auto-send setting
 * or because the cashier ticked the SMS box at the till.
 *
 * The shop name signs off at the bottom only. It used to head the message as
 * well, so every receipt named the shop twice — wasted characters in a message
 * that is billed by segment.
 *
 * ── Which lines appear, and why ────────────────────────────────────────────
 *
 * Every line below the total is conditional, because a receipt is billed by the
 * character and a line that says nothing still costs one. `জমা ৳0` on a pure
 * credit sale and `বাকি ৳0` on a cash sale are both noise the customer has to
 * read past, and on a UCS-2 message either can be the line that buys a third
 * segment.
 *
 * The three balance lines are the substance:
 *
 *   `বাকি`            — what THIS invoice left unpaid.
 *   `আগের বাকি জমা`   — a খাতা cleared out of surplus tendered at the till.
 *   `সর্বমোট বাকি`    — what the customer still owes the shop, all invoices.
 *
 * The last one is why this function changed. It was printed only on a settling
 * sale, so the ordinary case — a customer with a ৳2,600 খাতা buying ৳890 on
 * ৳500 down — got a receipt reading `Due:Tk390` and nothing else. That figure
 * is true about the invoice and wildly false about what they owe, and it is the
 * only number they were given. The till has always shown all three (আগের বাকি /
 * এই বিলের বাকি / মোট বাকি); the SMS now says what the screen says.
 */
const buildSaleReceipt = ({
  invoiceNo,
  total,
  paid,
  due,
  dueSettled = 0,
  advanceHeld = 0,
  totalDue = null,
  shopName,
  language = 'bn',
}) => {
  const t = RECEIPT_TEXT[language] || RECEIPT_TEXT.bn;
  const money = (label, amount) => `${label}${t.sep}${t.currency}${formatSmsAmount(amount)}`;

  const settled = Number(dueSettled) || 0;
  const lines = [`${t.invoice}${t.sep}${invoiceNo}`, money(t.total, total)];

  if (formatSmsAmount(paid) !== '0') lines.push(money(t.paid, paid));
  if (formatSmsAmount(due) !== '0') lines.push(money(t.due, due));
  if (settled > 0) lines.push(money(t.oldDuePaid, settled));
  /**
   * অগ্রিম জমা — money of theirs the shop is keeping.
   *
   * THE customer-trust line. A customer who hands over ৳1,000 on a ৳300 bill
   * and does not take ৳700 back needs to see that the shop recorded it; without
   * this the receipt says `বিল ৳300` and nothing else, and the only reasonable
   * conclusion is that the surplus was pocketed. Worth its characters even on a
   * UCS-2 body.
   */
  const held = Number(advanceHeld) || 0;
  if (held > 0) lines.push(money(t.advance, held));
  if (showsTotalDue(totalDue, due)) lines.push(money(t.totalDue, totalDue));

  lines.push(t.thanks, `- ${gsmSafeShopName(shopName)}`);
  return lines.join('\n');
};

/**
 * Payment receipt — sent when a due is collected, either against a specific
 * invoice or against the customer's running balance.
 *
 * `remainingDue` is the balance AFTER this payment lands. Previewing it before
 * the collection is recorded therefore means subtracting the amount yourself;
 * the client mirror does exactly that.
 *
 * ── The balance line is conditional, for two different reasons ───────────────
 *
 * **Cleared (`0`) prints its own sentence.** `Current due: Tk0` is the line a
 * customer reads three times to be sure of, and it is the single most valuable
 * thing this message can carry — that the খাতা is closed. Saying so in words
 * costs two characters over the digits and removes the doubt.
 *
 * **Unknown (`null`) prints nothing at all.** Not every caller has the balance
 * in hand — `recordPayment` settles one named invoice, and what the customer
 * owes the shop overall is a different question it never asked. `Tk0` there
 * would tell a customer owing ৳2,990 that they are clear, which is the same
 * failure `showsTotalDue` exists to prevent on the sale receipt. Saying nothing
 * is recoverable; a confident wrong zero is not.
 *
 * ── Why the রসিদ নং is NOT in here ──────────────────────────────────────────
 *
 * It is on the printed slip, and it was in this message for about an hour.
 * The reason it came back out is the promise the mirror exists to keep: the
 * shopkeeper is shown this exact body BEFORE the collection is written, and the
 * receipt number is derived from the payment's `_id`, which does not exist
 * until it is. There is no honest way to preview it — a placeholder would put a
 * number on the screen that never reaches the customer's phone, and omitting it
 * from the preview alone would under-count the segments the shop is billed for.
 *
 * It also costs ~26 characters, which on a UCS-2 body is most of a third
 * segment. The number belongs on paper, where it is free and where a customer
 * looking for it will actually look.
 */
const buildPaymentReceipt = ({ customerName, amount, remainingDue, shopName }) => {
  const lines = [`${customerName},`, `Tk${formatSmsAmount(amount)} payment received.`];

  if (remainingDue !== null && remainingDue !== undefined && remainingDue !== '') {
    // A non-numeric string is a `{remaining_due}` token from the template
    // picker, which must always render so the picker shows the whole shape of
    // the message rather than a version of it with the balance line missing.
    const numeric = Number(remainingDue);
    const isToken = typeof remainingDue === 'string' && Number.isNaN(numeric);
    lines.push(
      isToken || numeric > 0
        ? `Current due: Tk${formatSmsAmount(remainingDue)}`
        : 'No due remaining.'
    );
  }

  lines.push(`Thank you - ${gsmSafeShopName(shopName)}`);
  return lines.join('\n');
};

/**
 * Due reminder — sent from the SMS page to customers carrying a balance.
 */
const buildDueReminder = ({ customerName, due, shopName }) =>
  `Dear ${customerName},\nYour due: Tk${formatSmsAmount(due)}\nPlease pay as soon as possible.\nThank you - ${gsmSafeShopName(shopName)}`;

/**
 * Registration / login OTP. Not shop-branded and not billed to a shop's quota,
 * so it takes no shop name.
 */
const buildOtp = (otp) => `Your Hisaab OTP: ${otp}\nValid for 5 minutes`;

/**
 * Password-reset code. Same platform-account, unbranded, unbilled category as
 * `buildOtp` — and, like it, NOT mirrored in `lib/sms/templates.js`. The mirror
 * exists so the dashboard can show a shopkeeper what their CUSTOMER will
 * receive; nobody previews this one, so a second copy would be drift with no
 * reader.
 *
 * Deliberately worded differently from `buildOtp`. Both codes arrive on the
 * same number from the same sender, and a message that does not say what it
 * authorises trains people to type any six digits they are asked for — which is
 * exactly the behaviour a reset-code phishing call relies on. "Do not share"
 * costs 14 characters and the whole body still fits one GSM-7 segment.
 */
const buildPasswordResetOtp = (otp) =>
  `Hisaab password reset code: ${otp}\nValid for 5 minutes. Do not share this code.`;

/* ────────────────────────────────────────────────────────────────────────────
 * The shop's sign-off
 *
 * Every message this app sends on a shop's behalf ends with the shop's name.
 * Not as a nicety — an SMS arrives from a numeric short code with no sender
 * name a customer recognises, so a message that does not say who it is from
 * reads as spam and gets ignored, or worse, answered by a call to the wrong
 * number.
 *
 * The builders above bake it into their bodies. Free-text campaigns written on
 * the SMS page do not, so `appendShopSignature` puts it there. It is applied on
 * the SERVER, immediately before the segment count and the gateway call, which
 * makes it the one thing a caller cannot forget or strip: the dashboard, the
 * API and any future automation all pass through the same door.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `- Shop Name`, the exact tail every message ends on. */
const buildShopSignature = (shopName) => `- ${gsmSafeShopName(shopName)}`;

/**
 * Does this message already sign off with the shop's name?
 *
 * Checked on the tail rather than anywhere in the body, because a due reminder
 * that happens to MENTION the shop mid-sentence still needs the sign-off, while
 * one built by `buildDueReminder` — which already ends in `- Shop Name` — must
 * not get a second one. Case-insensitive and dash-optional so a shopkeeper who
 * typed the sign-off by hand isn't charged for a duplicate.
 */
const hasShopSignature = (message, shopName) => {
  const name = gsmSafeShopName(shopName).trim().toLowerCase();
  if (!name) return false;
  const tail = String(message || '').trimEnd().toLowerCase();
  return tail.endsWith(name);
};

/**
 * Append the shop's sign-off unless it is already there.
 *
 * Idempotent by design: running it twice on the same message changes nothing,
 * which matters because the campaign engine appends before counting segments
 * and the preview appends before rendering, and both may run over a template
 * that already carries the sign-off.
 */
const appendShopSignature = (message, shopName) => {
  const body = String(message || '').replace(/\s+$/, '');
  const signature = buildShopSignature(shopName);

  if (!body) return signature;
  if (hasShopSignature(body, shopName)) return body;

  return `${body}\n${signature}`;
};

/* ────────────────────────────────────────────────────────────────────────────
 * The shop's OWN invoice receipt
 *
 * Everything above this line is one body for the whole platform. This section
 * is the escape hatch: a shop that wants its receipt worded its own way gets a
 * template string on `settings.smsSettings.invoiceTemplate`, set by an operator
 * from the admin panel, and every sale receipt for that shop is rendered from
 * it instead of from `buildSaleReceipt`.
 *
 * WHY IT IS NOT FREE TEXT ALL THE WAY DOWN. A receipt is billed by the segment
 * and sent hundreds of times a day without anyone reading it again, so the two
 * ways a custom body can go wrong are both expensive and both silent:
 *
 *   1. A typo'd token. `{previus_due}` is not substituted, so a real customer
 *      is texted a literal brace and the shop pays for the characters. Hence
 *      `validateInvoiceTemplate`, which refuses an unknown token at SAVE time,
 *      and the leftover-token guard in `buildInvoiceSms`, which falls back to
 *      the built-in body rather than send braces if one ever gets through.
 *
 *   2. Length. The built-in Bangla receipt is bounded at two segments. A body
 *      written by hand in Bangla — UCS-2, 67 characters a segment in a
 *      multipart — reaches four without feeling long. That is double the bill
 *      on every sale the shop makes, forever, and nobody would notice until the
 *      quota ran out. Hence the segment ceiling, checked against a deliberately
 *      LARGE sample rather than against the template's own length.
 *
 * The template is admin-only on purpose. `PATCH /api/auth/shop/settings` works
 * off an allowlist that has never included `smsSettings`, so the shopkeeper
 * cannot reach this field; they ask, an operator sets it. That is the right
 * split while the cost of a bad template lands on the shop's quota and the
 * blast radius is every receipt they send.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Bengali digits, indexed by the value they stand for. */
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

/**
 * Digits, in the shop's numeral system.
 *
 * A shop that asked for its receipt in Bangla generally means the numbers too —
 * `৳১,৮০,৩৫০`, not `৳1,80,350`. It costs nothing: the body is already UCS-2 the
 * moment any Bangla character is in it, and a Bengali digit is one UCS-2
 * character exactly like an ASCII one.
 *
 * `en` is the default so that a shop with no custom template renders
 * byte-for-byte what it rendered before this existed.
 */
const toLocalDigits = (text, numerals = 'en') => {
  if (numerals !== 'bn') return String(text ?? '');
  return String(text ?? '').replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
};

/**
 * Money, as a custom template prints it.
 *
 * Grouped — `9,000`, not `9000` — which is the one place this deliberately
 * differs from `formatSmsAmount`. The platform body drops the separators
 * because two characters times four figures is real money in a 67-character
 * budget it is trying to keep to one segment. A custom template has already
 * given up on that budget by existing; what it needs instead is for a lakh to
 * be readable at a glance, and `১,৮০,৩৫০` is read correctly by a shopkeeper
 * where `১৮০৩৫০` has to be counted.
 *
 * Lakh grouping (`en-IN`), not thousands — `1,80,350`, which is how the figure
 * is written on every paper খাতা in the country.
 *
 * No `৳`. The symbol belongs to the template, next to the label the shop chose,
 * so a shop can write `মোট: ৳{total}` or `Total {total} tk` without this
 * function having an opinion.
 */
const formatTemplateMoney = (amount, numerals = 'en') => {
  const value = Number(amount) || 0;
  const grouped = Number.isInteger(value)
    ? value.toLocaleString('en-IN')
    : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return toLocalDigits(grouped, numerals);
};

/**
 * The invoice's date, `17/8/2026`.
 *
 * Asia/Dhaka, always — the server runs in UTC and a sale rung up at 9pm Dhaka
 * would otherwise be dated the day before on the customer's phone, which is the
 * one thing on a receipt they can check against the slip in their hand.
 *
 * Unpadded (`8`, not `08`) because that is how the date is written by hand here,
 * and it saves two characters on a body that is paying for them.
 *
 * Note on WHICH date: this is the sale's `createdAt`, and on a backdated sale
 * `createdAt` IS the backdated day — the platform stores the business date
 * there rather than carrying a second field (see saleDate.util.js). So a
 * receipt for a sale entered today against last Tuesday reads last Tuesday,
 * which is what both sides of the counter mean by "তারিখ".
 */
const formatTemplateDate = (date, numerals = 'en') => {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(d);

  const pick = (type) => parts.find((p) => p.type === type)?.value || '';
  const strip = (n) => String(Number(n));

  return toLocalDigits(`${strip(pick('day'))}/${strip(pick('month'))}/${pick('year')}`, numerals);
};

/**
 * Every token a custom invoice template may use.
 *
 * Exported so the admin editor builds its insert buttons from THIS list rather
 * than a hand-copied one. A button offering a token the renderer does not know
 * is how `{previus_due}` reaches a customer's phone.
 *
 * `kind` drives two behaviours:
 *   `money` — grouped and localised by `formatTemplateMoney`, and eligible for
 *             the empty-line rule below.
 *   `plain` — digits localised, nothing else. An invoice number is not grouped
 *             (`১৬২৮৫`, never `১৬,২৮৫`) and a year is not either.
 *   `text`  — passed through as-is.
 */
const INVOICE_SMS_TOKENS = [
  { token: '{shop_name}', kind: 'text', labelBn: 'দোকানের নাম' },
  { token: '{customer_name}', kind: 'text', labelBn: 'কাস্টমারের নাম' },
  { token: '{invoice_no}', kind: 'plain', labelBn: 'ইনভয়েস নম্বর' },
  { token: '{date}', kind: 'plain', labelBn: 'তারিখ' },
  { token: '{total}', kind: 'money', labelBn: 'মোট ক্রয়' },
  { token: '{paid}', kind: 'money', labelBn: 'জমা' },
  { token: '{due}', kind: 'money', labelBn: 'এই বিলের বাকি' },
  { token: '{previous_due}', kind: 'money', labelBn: 'পূর্বের বাকি' },
  { token: '{due_settled}', kind: 'money', labelBn: 'পুরোনো বাকি পরিশোধ' },
  { token: '{total_due}', kind: 'money', labelBn: 'সর্বমোট বাকি' },
];

/**
 * The same machinery, pointed at a SUPPLIER.
 *
 * The money tokens deliberately keep the same names — `{total}`, `{paid}`,
 * `{due}`, `{previous_due}`, `{due_settled}`, `{total_due}` mean the same thing
 * on a challan as on an invoice, and giving them second names would mean a
 * second empty-line rule and a second typo net to keep in step. Only the party
 * and the vendor's own bill number differ.
 *
 * The two sets stay SEPARATE rather than merging, because a token that is valid
 * on the wrong document is a template that renders "সরবরাহকারী" on a customer's
 * receipt. `validateInvoiceTemplate` is what catches that, by not recognising
 * it — so which set it is handed is a correctness decision, not a detail.
 */
const PURCHASE_SMS_TOKENS = [
  { token: '{shop_name}', kind: 'text', labelBn: 'দোকানের নাম' },
  { token: '{supplier_name}', kind: 'text', labelBn: 'সরবরাহকারীর নাম' },
  { token: '{invoice_no}', kind: 'plain', labelBn: 'আমাদের চালান নম্বর' },
  { token: '{supplier_invoice_no}', kind: 'plain', labelBn: 'তাদের বিল নম্বর' },
  { token: '{date}', kind: 'plain', labelBn: 'তারিখ' },
  { token: '{total}', kind: 'money', labelBn: 'মোট ক্রয়' },
  { token: '{paid}', kind: 'money', labelBn: 'পরিশোধ' },
  { token: '{due}', kind: 'money', labelBn: 'এই চালানে বাকি' },
  { token: '{previous_due}', kind: 'money', labelBn: 'পূর্বের বাকি' },
  { token: '{due_settled}', kind: 'money', labelBn: 'পুরোনো বাকি পরিশোধ' },
  { token: '{total_due}', kind: 'money', labelBn: 'মোট বাকি' },
];

const kindsOf = (tokens) => tokens.reduce((map, t) => {
  map[t.token] = t.kind;
  return map;
}, {});

const INVOICE_TOKEN_KINDS = kindsOf(INVOICE_SMS_TOKENS);
const PURCHASE_TOKEN_KINDS = kindsOf(PURCHASE_SMS_TOKENS);

/**
 * Anything shaped like a token, known or not — the typo detector's net.
 *
 * Built fresh on every use rather than kept as a module constant. A `g` regex
 * carries `lastIndex` between calls, and a shared one silently starts the next
 * shop's template from the middle of the previous one.
 */
const tokenPattern = () => /\{[a-zA-Z0-9_]+\}/g;

/**
 * The upper bound on a custom receipt, in segments.
 *
 * Four, against the built-in body's two. Not a technical limit — the gateway
 * will happily send ten — but a ceiling on how much a single admin edit can
 * multiply a shop's ongoing SMS bill. A shop that genuinely needs more is a
 * conversation, not a text box.
 */
const MAX_INVOICE_TEMPLATE_SEGMENTS = 4;

/** How long a template may be before it is certainly too expensive to send. */
const MAX_INVOICE_TEMPLATE_LENGTH = 480;

/**
 * The figures a template is previewed and priced against.
 *
 * Three scenarios rather than one, because the empty-line rule below means a
 * template renders DIFFERENTLY for different customers, and an operator who
 * only ever sees the খাতা case will not notice that their walk-in receipt has
 * lost three of its five lines.
 *
 * `khata` is also what the segment ceiling is checked against, and its figures
 * are deliberately large: six-digit balances and a long Bangla name. Validating
 * against small numbers would pass a template that starts failing the day the
 * shop's biggest customer buys something.
 */
const INVOICE_SMS_SAMPLES = [
  {
    id: 'khata',
    labelBn: 'বাকিতে বিক্রি (পুরোনো বাকিসহ)',
    labelEn: 'Credit sale, customer carries a khata',
    facts: {
      customerName: 'মোঃ পারভেজ ইসলাম',
      invoiceNo: '16285',
      date: '2026-08-17T06:00:00.000Z',
      total: 9000,
      paid: 0,
      due: 9000,
      previousDue: 180350,
      dueSettled: 0,
      totalDue: 189350,
    },
  },
  {
    id: 'cash',
    labelBn: 'নগদ বিক্রি (কোনো বাকি নেই)',
    labelEn: 'Cash sale, nothing owed',
    facts: {
      customerName: 'রহিম উদ্দিন',
      invoiceNo: '16286',
      date: '2026-08-17T06:00:00.000Z',
      total: 1250,
      paid: 1250,
      due: 0,
      previousDue: 0,
      dueSettled: 0,
      totalDue: 0,
    },
  },
  {
    id: 'settle',
    labelBn: 'পুরোনো বাকি পরিশোধসহ',
    labelEn: 'Part payment that also clears old due',
    facts: {
      customerName: 'সালমা বেগম',
      invoiceNo: '16287',
      date: '2026-08-17T06:00:00.000Z',
      total: 3400,
      paid: 5000,
      due: 0,
      previousDue: 2600,
      dueSettled: 1600,
      totalDue: 1000,
    },
  },
];

/**
 * Resolve every token to the string it prints, plus the raw number behind it.
 *
 * The raw numbers are kept because the empty-line rule needs to ask "was this
 * zero?" AFTER formatting has turned `0` into `০`.
 */
const resolveInvoiceTokens = (facts = {}, numerals = 'en') => {
  const money = {
    '{total}': Number(facts.total) || 0,
    '{paid}': Number(facts.paid) || 0,
    '{due}': Number(facts.due) || 0,
    '{previous_due}': Number(facts.previousDue) || 0,
    '{due_settled}': Number(facts.dueSettled) || 0,
    '{total_due}': Number(facts.totalDue) || 0,
  };

  const rendered = {
    '{shop_name}': gsmSafeShopName(facts.shopName),
    '{customer_name}': String(facts.customerName || 'কাস্টমার'),
    // Resolved for both documents, and harmless on the wrong one: which tokens
    // a template may USE is decided by the `kinds` set handed to
    // `validateInvoiceTemplate`, so a sale template naming `{supplier_name}` is
    // refused before it can ever be saved.
    '{supplier_name}': String(facts.supplierName || 'সরবরাহকারী'),
    '{invoice_no}': toLocalDigits(facts.invoiceNo ?? '', numerals),
    '{supplier_invoice_no}': toLocalDigits(facts.supplierInvoiceNo ?? '', numerals),
    '{date}': formatTemplateDate(facts.date, numerals),
  };

  for (const [token, value] of Object.entries(money)) {
    rendered[token] = formatTemplateMoney(value, numerals);
  }

  return { rendered, money };
};

/**
 * Render a custom template against one sale's figures.
 *
 * ── The empty-line rule ────────────────────────────────────────────────────
 *
 * A line whose every money token resolved to zero is DROPPED.
 *
 * This is the same judgement `buildSaleReceipt` makes with its `if` statements,
 * moved somewhere a shopkeeper's free text can reach. Without it, the template
 * in the original request texts a walk-in who paid cash:
 *
 *     *পূর্বের বাকি: ৳০
 *     *সর্বমোট বাকি : ৳০
 *
 * — two lines that are true, useless, and on a UCS-2 body can be the pair that
 * buys a third segment. Worse than the cost, a customer who owes nothing is
 * handed a receipt whose largest visual element is the word বাকি.
 *
 * ALL the money tokens on the line must be zero, not any: `জমা ৳{paid} · বাকি
 * ৳{due}` keeps its line as long as one of the two has a figure in it. Lines
 * with no money token at all — the greeting, the name, the thank-you — are
 * never dropped, because nothing about them is conditional.
 *
 * The consequence worth stating: a genuinely free sale (`{total}` = 0) loses
 * its total line. That is the correct trade for a rule this simple, and the
 * admin preview shows the cash scenario precisely so the shape is visible
 * before it is saved.
 */
const renderInvoiceTemplate = (template, facts = {}, numerals = 'en', kinds = INVOICE_TOKEN_KINDS) => {
  const { rendered, money } = resolveInvoiceTokens(facts, numerals);

  const lines = String(template || '')
    .split('\n')
    .filter((line) => {
      const used = line.match(tokenPattern()) || [];
      const moneyTokens = used.filter((t) => kinds[t] === 'money');
      if (moneyTokens.length === 0) return true;
      return !moneyTokens.every((t) => money[t] === 0);
    })
    .map((line) => line.replace(tokenPattern(), (t) => (t in rendered ? rendered[t] : t)));

  return lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Is this template safe to save?
 *
 * Runs at the admin panel's save, so the operator finds out here rather than
 * the shop finding out in next month's quota. Returns rather than throws, so
 * the caller decides what an invalid template means — a 400 in the service, a
 * red hint under the textarea on the client.
 *
 * An EMPTY template is valid and means "use the platform body". That is the
 * off switch, and it has to be reachable by clearing the box.
 *
 * `countSegments` is injected rather than imported because this file is
 * mirrored to the client, where the segment counter is a different module
 * (`lib/utils/smsCounter.js`) reached by a different name. Passing it in keeps
 * the two copies character-identical.
 */
const validateInvoiceTemplate = (template, options = {}) => {
  const {
    shopName = 'Hisaab',
    numerals = 'en',
    maxSegments = MAX_INVOICE_TEMPLATE_SEGMENTS,
    countSegments = null,
    /**
     * Which document this template is for.
     *
     * The gate that keeps the two sets apart: a sale template naming
     * `{supplier_name}` is an unknown token here and is refused, so a customer
     * can never be texted the word সরবরাহকারী.
     */
    kinds = INVOICE_TOKEN_KINDS,
    samples = INVOICE_SMS_SAMPLES,
  } = options;

  const body = String(template ?? '').trim();
  if (!body) {
    return { valid: true, empty: true, unknownTokens: [], segments: 0 };
  }

  if (body.length > MAX_INVOICE_TEMPLATE_LENGTH) {
    return {
      valid: false,
      empty: false,
      unknownTokens: [],
      segments: 0,
      reason: `Template is ${body.length} characters; the limit is ${MAX_INVOICE_TEMPLATE_LENGTH}`,
      reasonBn: `টেমপ্লেটটি ${body.length} অক্ষরের, সর্বোচ্চ ${MAX_INVOICE_TEMPLATE_LENGTH} অক্ষর দেওয়া যাবে`,
    };
  }

  const unknownTokens = [
    ...new Set((body.match(tokenPattern()) || []).filter((t) => !(t in kinds))),
  ];
  if (unknownTokens.length) {
    return {
      valid: false,
      empty: false,
      unknownTokens,
      segments: 0,
      reason: `Unknown placeholder(s): ${unknownTokens.join(', ')}`,
      reasonBn: `এই প্লেসহোল্ডারগুলো চেনা যায়নি: ${unknownTokens.join(', ')}`,
    };
  }

  // Priced against the LARGEST sample, with the sign-off the server will append
  // on the way out — the message that actually goes, not the draft.
  if (typeof countSegments === 'function') {
    const worst = samples[0];
    const preview = appendShopSignature(
      renderInvoiceTemplate(body, { ...worst.facts, shopName }, numerals, kinds),
      shopName
    );
    const segments = countSegments(preview);
    if (segments > maxSegments) {
      return {
        valid: false,
        empty: false,
        unknownTokens: [],
        segments,
        reason: `Template renders to ${segments} SMS segments; the limit is ${maxSegments}`,
        reasonBn: `টেমপ্লেটটি ${segments}টি এসএমএস সেগমেন্ট নিচ্ছে, সর্বোচ্চ ${maxSegments}টি অনুমোদিত`,
      };
    }
    return { valid: true, empty: false, unknownTokens: [], segments };
  }

  return { valid: true, empty: false, unknownTokens: [], segments: 0 };
};

/**
 * The sale receipt this shop sends — its own template if it has one, the
 * platform body if it does not.
 *
 * The single door every sale receipt goes through, so a shop's wording cannot
 * apply on the automatic send and not on the re-send, or vice versa.
 *
 * ── The fallback is not decoration ─────────────────────────────────────────
 *
 * `validateInvoiceTemplate` runs at save time, but a stored template outlives
 * the validation that let it in: a token could be renamed here in a later
 * change and every shop using it would start texting literal braces. So the
 * rendered body is checked for leftover tokens and the platform receipt is used
 * instead if any survive. A customer getting the standard receipt is a cosmetic
 * regression; a customer getting `৳{previus_due}` is the shop looking broken to
 * its own customers, at its own expense.
 *
 * An empty render — a template that was nothing but zero-valued money lines —
 * falls back for the same reason.
 */
/**
 * The samples a PURCHASE template is previewed and priced against.
 *
 * Largest first, because that is the one the segment ceiling is checked
 * against — a template validated on small numbers starts failing the day the
 * shop's biggest delivery arrives.
 */
const PURCHASE_SMS_SAMPLES = [
  {
    id: 'khata',
    labelBn: 'বাকিতে কেনা (পুরোনো বাকিসহ)',
    labelEn: 'Credit purchase, shop carries a khata',
    facts: {
      supplierName: 'মেসার্স রহমান ট্রেডার্স',
      invoiceNo: 'PUR2026080014',
      supplierInvoiceNo: 'RT-9912',
      date: '2026-08-17T06:00:00.000Z',
      total: 223550,
      paid: 10000,
      due: 213550,
      previousDue: 180350,
      dueSettled: 0,
      totalDue: 393900,
    },
  },
  {
    id: 'settled',
    labelBn: 'কেনার সাথে পুরোনো বাকি পরিশোধ',
    labelEn: 'Old dues cleared at the same counter',
    facts: {
      supplierName: 'করিম ভাই',
      invoiceNo: 'PUR2026080015',
      supplierInvoiceNo: '',
      date: '2026-08-17T06:00:00.000Z',
      total: 9000,
      paid: 9000,
      due: 0,
      previousDue: 180350,
      dueSettled: 50000,
      totalDue: 130350,
    },
  },
  {
    id: 'cash',
    labelBn: 'নগদে কেনা, কোনো বাকি নেই',
    labelEn: 'Cash purchase, nothing outstanding',
    facts: {
      supplierName: 'করিম ভাই',
      invoiceNo: 'PUR2026080016',
      supplierInvoiceNo: '',
      date: '2026-08-17T06:00:00.000Z',
      total: 2440,
      paid: 2440,
      due: 0,
      previousDue: 0,
      dueSettled: 0,
      totalDue: 0,
    },
  },
];

/**
 * The built-in চালান confirmation, sent to a SUPPLIER.
 *
 * ── Manual only, and that is a cost decision ─────────────────────────────
 *
 * There is no `autoSendOnPurchase`. A shop texting every vendor on every
 * delivery is a bill it did not ask for, and unlike a customer the supplier
 * already has the paper — they wrote it. This exists for the case that
 * actually matters: confirming what the shop believes it now owes, so a
 * disagreement surfaces this week rather than at month end.
 *
 * ── The lines, and why each is conditional ───────────────────────────────
 *
 * Billed by the segment, so a line that says nothing still costs money. The
 * two that carry the substance:
 *
 *   `বাকি`      — what THIS challan left unpaid.
 *   `মোট বাকি`  — what the shop owes the vendor across everything.
 *
 * The second only prints when it differs from the first, for the same reason
 * `showsTotalDue` exists on the sale receipt: a vendor with no খাতা would
 * otherwise read the same figure twice and take it as two debts.
 */
const buildPurchaseReceipt = ({
  invoiceNo,
  supplierInvoiceNo = '',
  total,
  paid,
  due,
  dueSettled = 0,
  totalDue = null,
  shopName,
}) => {
  const money = (label, amount) => `${label} ৳${formatSmsAmount(amount)}`;
  const settled = Number(dueSettled) || 0;

  // Their bill number when we have it, ours otherwise. The vendor can look up
  // theirs; ours means nothing to them.
  const ref = String(supplierInvoiceNo || '').trim() || invoiceNo;
  const lines = [`চালান ${ref}`, money('মোট', total)];

  if (formatSmsAmount(paid) !== '0') lines.push(money('পরিশোধ', paid));
  if (settled > 0) lines.push(money('পুরোনো বাকি জমা', settled));
  if (formatSmsAmount(due) !== '0') lines.push(money('বাকি', due));
  if (showsTotalDue(totalDue, due)) lines.push(money('মোট বাকি', totalDue));

  lines.push(`- ${gsmSafeShopName(shopName)}`);
  return lines.join('\n');
};

/**
 * A purchase confirmation, custom template if the shop has one.
 *
 * Mirrors `buildInvoiceSms` exactly, including the fallback: a template that
 * leaves an unrecognised token behind is DISCARDED in favour of the built-in
 * body, because a supplier receiving `৳{previus_due}` is the shop looking
 * broken to its own vendor, at its own expense.
 */
const buildPurchaseSms = ({
  template = '',
  numerals = 'en',
  invoiceNo,
  supplierInvoiceNo = '',
  date = null,
  supplierName = '',
  total,
  paid,
  due,
  previousDue = 0,
  dueSettled = 0,
  totalDue = null,
  shopName,
}) => {
  const body = String(template ?? '').trim();

  if (body) {
    const rendered = renderInvoiceTemplate(
      body,
      {
        invoiceNo,
        supplierInvoiceNo,
        date,
        supplierName,
        total,
        paid,
        due,
        previousDue,
        dueSettled,
        totalDue,
        shopName,
      },
      numerals,
      PURCHASE_TOKEN_KINDS
    );

    if (rendered && !tokenPattern().test(rendered)) {
      return rendered;
    }
  }

  return buildPurchaseReceipt({
    invoiceNo, supplierInvoiceNo, total, paid, due, dueSettled, totalDue, shopName,
  });
};

const buildInvoiceSms = ({
  template = '',
  numerals = 'en',
  invoiceNo,
  date = null,
  customerName = '',
  total,
  paid,
  due,
  previousDue = 0,
  dueSettled = 0,
  totalDue = null,
  shopName,
  language = 'bn',
}) => {
  const body = String(template ?? '').trim();

  if (body) {
    const rendered = renderInvoiceTemplate(
      body,
      {
        invoiceNo,
        date,
        customerName,
        total,
        paid,
        due,
        previousDue,
        dueSettled,
        totalDue,
        shopName,
      },
      numerals
    );

    if (rendered && !tokenPattern().test(rendered)) {
      return rendered;
    }
  }

  return buildSaleReceipt({
    invoiceNo,
    total,
    paid,
    due,
    dueSettled,
    totalDue,
    shopName,
    language,
  });
};

module.exports = {
  formatSmsAmount,
  gsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
  buildPasswordResetOtp,
  buildShopSignature,
  hasShopSignature,
  appendShopSignature,
  // Per-shop invoice templates. See the section header above.
  INVOICE_SMS_TOKENS,
  INVOICE_SMS_SAMPLES,
  // The supplier side of the same machinery. Kept as a SEPARATE token set so a
  // template cannot name a party the document does not have.
  PURCHASE_SMS_TOKENS,
  PURCHASE_SMS_SAMPLES,
  PURCHASE_TOKEN_KINDS,
  INVOICE_TOKEN_KINDS,
  buildPurchaseReceipt,
  buildPurchaseSms,
  MAX_INVOICE_TEMPLATE_SEGMENTS,
  MAX_INVOICE_TEMPLATE_LENGTH,
  toLocalDigits,
  formatTemplateMoney,
  formatTemplateDate,
  renderInvoiceTemplate,
  validateInvoiceTemplate,
  buildInvoiceSms,
};

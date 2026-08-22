/**
 * The landing page checkout — free delivery, coupons, advance payment.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────
 *
 * One rule, stated four ways: the customer pays what the page said, and the
 * page said what the CONFIG says. Every figure on a landing order is derived
 * server-side (I-13), and each feature added here is another chance for a
 * number the browser sent to creep into that derivation.
 *
 * No database. `LandingPage` documents are constructed in memory with
 * `new LandingPage(...)`, which gives real methods and real defaults without a
 * connection — the same approach the rest of this suite takes. Anything that
 * writes (coupon redemption) is asserted through a stubbed `updateOne`.
 */

const LandingPage = require('../models/LandingPage.model');
const landingOrderService = require('../services/landingOrder.service');

/** A page with two offers and the default two zones, ready to be overridden. */
function makePage(overrides = {}) {
  return new LandingPage({
    shop: '000000000000000000000001',
    title: 'আম ২০২৬',
    slug: 'aam-2026',
    offers: [
      { key: '3kg', label: '৩ কেজি', price: 1200, isActive: true, sortOrder: 1 },
      { key: '5kg', label: '৫ কেজি', price: 1800, isActive: true, sortOrder: 2 },
    ],
    ...overrides,
  });
}

describe('free delivery thresholds', () => {
  test('a subtotal below the threshold pays the charge', () => {
    const page = makePage({
      delivery: { zones: [{ key: 'dhaka', name: 'ঢাকা', charge: 60, freeAbove: 2000 }] },
    });

    const quote = landingOrderService.quote(page, { offer: '3kg', zone: 'dhaka' });
    expect(quote.subtotal).toBe(1200);
    expect(quote.deliveryCharge).toBe(60);
    expect(quote.total).toBe(1260);
    expect(quote.freeByThreshold).toBe(false);
  });

  test('reaching the threshold exactly makes delivery free', () => {
    // The boundary is inclusive, and it has to be: a page advertising "২০০০
    // টাকার উপরে ফ্রি" that charges on a ৳2000 order is a complaint.
    const page = makePage({
      offers: [{ key: 'x', label: 'x', price: 2000, isActive: true }],
      delivery: { zones: [{ key: 'dhaka', name: 'ঢাকা', charge: 60, freeAbove: 2000 }] },
    });

    const quote = landingOrderService.quote(page, { offer: 'x', zone: 'dhaka' });
    expect(quote.deliveryCharge).toBe(0);
    expect(quote.freeByThreshold).toBe(true);
    expect(quote.total).toBe(2000);
  });

  test('the threshold is per zone, not per page', () => {
    // The whole reason `freeAbove` sits on the zone: free inside Dhaka while
    // the outside-Dhaka courier still charges is the ordinary offer here.
    const page = makePage({
      delivery: {
        zones: [
          { key: 'in', name: 'ঢাকার ভিতরে', charge: 60, freeAbove: 1000 },
          { key: 'out', name: 'ঢাকার বাইরে', charge: 120, freeAbove: 0 },
        ],
      },
    });

    expect(landingOrderService.quote(page, { offer: '3kg', zone: 'in' }).deliveryCharge).toBe(0);
    expect(landingOrderService.quote(page, { offer: '3kg', zone: 'out' }).deliveryCharge).toBe(120);
  });

  test('a zone that is simply free is not reported as free BY THRESHOLD', () => {
    // Two different facts, and the order records which one applied. A month
    // later "why did this ship free" has a right answer.
    const page = makePage({
      delivery: { zones: [{ key: 'pickup', name: 'দোকান থেকে', charge: 0, freeAbove: 0 }] },
    });

    const quote = landingOrderService.quote(page, { offer: '3kg', zone: 'pickup' });
    expect(quote.deliveryCharge).toBe(0);
    expect(quote.freeByThreshold).toBe(false);
  });

  test('REGRESSION: an unknown zone key is refused, not silently charged the first zone', () => {
    // The original code fell back to `zones[0]`. A customer on a cached page
    // picked "outside Dhaka", was charged the Dhaka rate, and the order looked
    // perfectly ordinary in the worklist — the shop ate ৳120 a parcel and had
    // nothing to notice.
    const page = makePage({
      delivery: {
        zones: [
          { key: 'in', name: 'ঢাকার ভিতরে', charge: 60 },
          { key: 'out', name: 'ঢাকার বাইরে', charge: 120 },
        ],
      },
    });

    expect(() => landingOrderService.quote(page, { offer: '3kg', zone: 'outside-dhaka' }))
      .toThrow(/Unknown delivery zone/);
  });

  test('an ABSENT zone still falls back to the first — the form may have no picker', () => {
    const page = makePage({
      delivery: { zones: [{ key: 'all', name: 'সারাদেশ', charge: 80 }] },
    });

    expect(landingOrderService.quote(page, { offer: '3kg' }).deliveryCharge).toBe(80);
  });
});

describe('coupons', () => {
  const withCoupon = (coupon, zone = { key: 'z', name: 'z', charge: 100 }) => makePage({
    delivery: { zones: [zone] },
    coupons: [coupon],
  });

  test('a flat code comes off the goods, not off the delivery', () => {
    const page = withCoupon({ code: 'EID200', type: 'flat', value: 200, isActive: true });

    const quote = landingOrderService.quote(page, { offer: '3kg', coupon: 'EID200' });
    expect(quote.discount).toBe(200);
    expect(quote.deliveryCharge).toBe(100);
    expect(quote.total).toBe(1200 - 200 + 100);
  });

  test('a percent code is rounded and capped by maxDiscount', () => {
    const page = withCoupon({
      code: 'TEN', type: 'percent', value: 10, maxDiscount: 100, isActive: true,
    });

    // 10% of 1200 is 120, capped at 100.
    expect(landingOrderService.quote(page, { offer: '3kg', coupon: 'TEN' }).discount).toBe(100);
  });

  test('an uncapped percent code applies in full', () => {
    const page = withCoupon({ code: 'TEN', type: 'percent', value: 10, isActive: true });
    expect(landingOrderService.quote(page, { offer: '3kg', coupon: 'TEN' }).discount).toBe(120);
  });

  test('the code is matched case- and whitespace-insensitively', () => {
    // It is read off an advertisement and retyped on a phone keyboard.
    const page = withCoupon({ code: 'EID200', type: 'flat', value: 200, isActive: true });
    expect(landingOrderService.quote(page, { offer: '3kg', coupon: '  eid200 ' }).discount).toBe(200);
  });

  test('a discount can never exceed the goods, let alone reach the delivery charge', () => {
    // A ৳5000 code on a ৳1200 order must not turn into a ৳3800 payout, and must
    // not pay the courier either.
    const page = withCoupon({ code: 'HUGE', type: 'flat', value: 5000, isActive: true });

    const quote = landingOrderService.quote(page, { offer: '3kg', coupon: 'HUGE' });
    expect(quote.discount).toBe(1200);
    expect(quote.total).toBe(100);
  });

  test('minSubtotal is enforced and is the one refusal worth explaining', () => {
    const page = withCoupon({
      code: 'BIG', type: 'flat', value: 300, minSubtotal: 2000, isActive: true,
    });

    // On the quote path a bad code prices the order WITHOUT it and says why,
    // because a customer mid-typing has a bad code for a few hundred ms.
    const quote = landingOrderService.quote(page, { offer: '3kg', coupon: 'BIG' });
    expect(quote.discount).toBe(0);
    expect(quote.couponError).toMatch(/২০০০/);
    expect(quote.total).toBe(1300);
  });

  test('an inactive or exhausted code is indistinguishable from an unknown one', () => {
    // Telling a stranger "that code is used up" tells them the code is real,
    // which is the only thing worth learning from this endpoint.
    const inactive = withCoupon({ code: 'OFF', type: 'flat', value: 100, isActive: false });
    const used = withCoupon({
      code: 'OFF', type: 'flat', value: 100, isActive: true, usageLimit: 5, usedCount: 5,
    });

    for (const page of [inactive, used]) {
      const quote = landingOrderService.quote(page, { offer: '3kg', coupon: 'OFF' });
      expect(quote.discount).toBe(0);
      expect(quote.couponError).toBe('কুপন কোডটি সঠিক নয়');
    }
  });

  test('the threshold is measured AFTER the coupon', () => {
    // Stated so it cannot drift: a ৳1000 threshold that a ৳200 coupon can be
    // stacked under would ship ৳800 of goods free against a page that promised
    // otherwise.
    const page = makePage({
      delivery: { zones: [{ key: 'z', name: 'z', charge: 60, freeAbove: 1200 }] },
      coupons: [{ code: 'CUT', type: 'flat', value: 200, isActive: true }],
    });

    // Without the coupon: 1200 >= 1200, free.
    expect(landingOrderService.quote(page, { offer: '3kg' }).deliveryCharge).toBe(0);
    // With it: 1000 < 1200, charged.
    expect(landingOrderService.quote(page, { offer: '3kg', coupon: 'CUT' }).deliveryCharge).toBe(60);
  });

  test('redemption is a GUARDED atomic update, not a read-then-write', () => {
    // Two customers submitting the last redemption in the same millisecond both
    // pass `findCoupon`. The `$lt` predicate in the filter is what makes only
    // one of them win, so its presence is the test.
    const page = withCoupon({
      code: 'LAST', type: 'flat', value: 100, isActive: true, usageLimit: 100, usedCount: 40,
    });

    const spy = jest.spyOn(LandingPage, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

    return landingOrderService._reserveCoupon(page, { code: 'LAST', amount: 100 }).then(() => {
      const [filter, update] = spy.mock.calls[0];
      expect(filter['coupons.code']).toBe('LAST');
      expect(filter['coupons.usedCount']).toEqual({ $lt: 100 });
      expect(update).toEqual({ $inc: { 'coupons.$.usedCount': 1 } });
      spy.mockRestore();
    });
  });

  test('losing that race refuses the order rather than discounting past the limit', async () => {
    const page = withCoupon({
      code: 'LAST', type: 'flat', value: 100, isActive: true, usageLimit: 100, usedCount: 99,
    });

    const spy = jest.spyOn(LandingPage, 'updateOne').mockResolvedValue({ modifiedCount: 0 });

    await expect(landingOrderService._reserveCoupon(page, { code: 'LAST', amount: 100 }))
      .rejects.toThrow(/exhausted/);

    spy.mockRestore();
  });

  test('an UNLIMITED code still counts redemptions but has no ceiling to race', async () => {
    const page = withCoupon({ code: 'FREE', type: 'flat', value: 50, isActive: true });

    const spy = jest.spyOn(LandingPage, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    await landingOrderService._reserveCoupon(page, { code: 'FREE', amount: 50 });

    expect(spy.mock.calls[0][0]['coupons.usedCount']).toBeUndefined();
    spy.mockRestore();
  });
});

describe('advance payment', () => {
  const advancePage = (payment, zone = { key: 'z', name: 'z', charge: 120 }) => makePage({
    delivery: { zones: [zone] },
    payment,
  });

  test('a page that says nothing is cash on delivery', () => {
    const page = makePage();
    expect(page.paymentMethods()).toEqual(['cod']);
    expect(landingOrderService._resolvePayment(page, {}, 120).method).toBe('cod');
  });

  test('"delivery" mode asks for exactly this order delivery charge', () => {
    const page = advancePage({ methods: ['advance'], advanceMode: 'delivery' });

    const resolved = landingOrderService._resolvePayment(page, { trxId: 'BKX12' }, 120);
    expect(resolved.method).toBe('advance');
    expect(resolved.advance.amount).toBe(120);
    expect(resolved.advance.verified).toBe(false);
  });

  test('"fixed" mode ignores the delivery charge', () => {
    const page = advancePage({ methods: ['advance'], advanceMode: 'fixed', advanceAmount: 200 });
    expect(landingOrderService._resolvePayment(page, { trxId: 'X' }, 120).advance.amount).toBe(200);
  });

  test('an advance of zero settles back to COD instead of demanding a TrxID for ৳0', () => {
    // The free-delivery case. Asking for a transaction id for nothing would
    // lose the order over a form field.
    const page = advancePage(
      { methods: ['advance'], advanceMode: 'delivery' },
      { key: 'z', name: 'z', charge: 60, freeAbove: 1000 }
    );

    const resolved = landingOrderService._resolvePayment(page, {}, 0);
    expect(resolved.method).toBe('cod');
    expect(resolved.advance).toBeUndefined();
  });

  test('choosing advance without a TrxID is refused', () => {
    const page = advancePage({ methods: ['cod', 'advance'], advanceMode: 'delivery' });

    expect(() => landingOrderService._resolvePayment(page, { paymentMethod: 'advance' }, 120))
      .toThrow(/transaction id/i);
  });

  test('a method the page does not offer falls back to what it does', () => {
    // Not an error: the request is nonsense, and the page has exactly one
    // honest answer to give.
    const page = makePage();
    expect(landingOrderService._resolvePayment(page, { paymentMethod: 'advance' }, 120).method)
      .toBe('cod');
  });

  test('the TrxID is stored verbatim and never parsed', () => {
    // Deliberately unvalidated. A human compares it against the shop own
    // statement, and a format rule would only teach a prankster what to type.
    const page = advancePage({ methods: ['advance'] });
    const resolved = landingOrderService._resolvePayment(
      page,
      { trxId: '  9F2K-XY7  ', senderNumber: '01712345678' },
      120
    );

    expect(resolved.advance.trxId).toBe('9F2K-XY7');
    expect(resolved.advance.senderNumber).toBe('01712345678');
  });

  test('the quote reports what the courier will collect', () => {
    const page = advancePage({ methods: ['advance'], advanceMode: 'delivery' });

    const quote = landingOrderService.quote(page, { offer: '3kg', zone: 'z' });
    expect(quote.total).toBe(1320);
    expect(quote.advanceAmount).toBe(120);
    expect(quote.codAmount).toBe(1200);
  });
});

describe('quantities on a multi-select form', () => {
  test('REGRESSION: a parallel quantity array is honoured position by position', () => {
    // The original code hardcoded 1 for every ticked offer. A customer who
    // ticked two packs and typed "3" against one was sold one of each, and
    // found out at the door.
    const page = makePage({ delivery: { zones: [{ key: 'z', name: 'z', charge: 0 }] } });

    const quote = landingOrderService.quote(page, {
      offer: ['3kg', '5kg'],
      quantity: [3, 1],
    });

    expect(quote.subtotal).toBe(1200 * 3 + 1800);
  });

  test('a SCALAR quantity beside an array is not spread across the rows', () => {
    // Ambiguous input: "3" next to two ticked boxes could mean three of each or
    // three in total. It means one each, and nothing is guessed.
    const page = makePage({ delivery: { zones: [{ key: 'z', name: 'z', charge: 0 }] } });

    const quote = landingOrderService.quote(page, { offer: ['3kg', '5kg'], quantity: 3 });
    expect(quote.subtotal).toBe(1200 + 1800);
  });

  test('the items[] shape still carries its own quantities', () => {
    const page = makePage({ delivery: { zones: [{ key: 'z', name: 'z', charge: 0 }] } });

    const quote = landingOrderService.quote(page, {
      items: [{ offer: '3kg', quantity: 2 }, { offer: '5kg', quantity: 1 }],
    });

    expect(quote.subtotal).toBe(1200 * 2 + 1800);
  });
});

describe('the publish gate knows about the new configuration', () => {
  const { parseContract, validateContract } = require('../utils/landingContract.util');

  const FORM = `
    <form data-hisaab="order-form">
      <input name="customerName"><input name="phone"><textarea name="address"></textarea>
      <input type="radio" name="offer" value="3kg">
      <button data-hisaab="submit">অর্ডার</button>
    </form>`;

  const issuesFor = (html, page) => validateContract(parseContract(html), page);
  const codes = (issues) => issues.map((i) => i.code);

  test('advance payment without a trxId field blocks publication', () => {
    const page = makePage({ payment: { methods: ['advance'] } });
    const found = issuesFor(FORM, page);

    expect(codes(found)).toContain('ADVANCE_NO_TRXID');
    expect(found.find((i) => i.code === 'ADVANCE_NO_TRXID').severity).toBe('error');
  });

  test('two payment methods without a picker blocks publication', () => {
    const page = makePage({ payment: { methods: ['cod', 'advance'] } });
    expect(codes(issuesFor(`${FORM}<input name="trxId">`, page))).toContain('NO_PAYMENT_INPUT');
  });

  test('fixed-mode advance with a zero amount blocks publication', () => {
    const page = makePage({
      payment: { methods: ['advance'], advanceMode: 'fixed', advanceAmount: 0 },
    });
    expect(codes(issuesFor(`${FORM}<input name="trxId">`, page))).toContain('ADVANCE_NO_AMOUNT');
  });

  test('a plain COD page is nagged about none of it', () => {
    const page = makePage();
    const found = codes(issuesFor(FORM, page));

    expect(found).not.toContain('ADVANCE_NO_TRXID');
    expect(found).not.toContain('NO_PAYMENT_INPUT');
    expect(found).not.toContain('NO_COUPON_INPUT');
  });

  test('configured coupons with no coupon box warn but do not block', () => {
    const page = makePage({ coupons: [{ code: 'EID', type: 'flat', value: 100, isActive: true }] });
    const found = issuesFor(FORM, page);

    const issue = found.find((i) => i.code === 'NO_COUPON_INPUT');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('warn');
  });
});

describe('place() — the whole chain on one order', () => {
  const LandingOrder = require('../models/LandingOrder.model');
  const LandingOrderCounter = require('../models/LandingOrderCounter.model');

  /** A page that exercises every feature at once. */
  const fullPage = () => makePage({
    status: 'live',
    expiresAt: new Date(Date.now() + 86400000),
    orderPrefix: 'AAM',
    delivery: { zones: [{ key: 'out', name: 'ঢাকার বাইরে', charge: 120, freeAbove: 3000 }] },
    payment: { methods: ['cod', 'advance'], advanceMode: 'delivery' },
    coupons: [{ code: 'EID200', type: 'flat', value: 200, isActive: true }],
  });

  const BODY = {
    customerName: 'রহিম উদ্দিন',
    phone: '01712345678',
    address: 'বাসা ১২, ধানমন্ডি, ঢাকা',
  };

  let created;

  beforeEach(() => {
    created = null;
    jest.spyOn(LandingOrderCounter, 'nextSeq').mockResolvedValue(7);
    jest.spyOn(LandingPage, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(LandingOrder, 'create').mockImplementation(async (doc) => {
      created = doc;
      return { ...doc, _id: 'order1' };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('the four steps compose: goods → coupon → delivery → advance', async () => {
    await landingOrderService.place(fullPage(), {
      ...BODY, offer: '5kg', quantity: 2, zone: 'out', coupon: 'EID200',
      paymentMethod: 'advance', trxId: '9F2KXY7',
    });

    // 1800 × 2 = 3600 goods, −200 coupon = 3400, which is over the ৳3000
    // threshold, so delivery is free and the advance (delivery mode) is nothing
    // — the order settles back to COD without asking for the TrxID it was given.
    expect(created.subtotal).toBe(3600);
    expect(created.discount.amount).toBe(200);
    expect(created.deliveryCharge).toBe(0);
    expect(created.delivery.freeByThreshold).toBe(true);
    expect(created.total).toBe(3400);
    expect(created.paymentMethod).toBe('cod');
    expect(created.codAmount).toBe(3400);
  });

  test('below the threshold the advance is charged and codAmount is the remainder', async () => {
    await landingOrderService.place(fullPage(), {
      ...BODY, offer: '3kg', zone: 'out',
      paymentMethod: 'advance', trxId: '9F2KXY7', senderNumber: '01912345678',
    });

    // 1200 goods, no coupon, 1200 < 3000 so delivery is ৳120 and that is what
    // the advance asks for.
    expect(created.total).toBe(1320);
    expect(created.paymentMethod).toBe('advance');
    expect(created.advance.amount).toBe(120);
    expect(created.advance.trxId).toBe('9F2KXY7');
    expect(created.advance.verified).toBe(false);
    // The one number that goes on the packing slip.
    expect(created.codAmount).toBe(1200);
  });

  test('codAmount equals the total on a plain COD order', async () => {
    await landingOrderService.place(fullPage(), { ...BODY, offer: '3kg', zone: 'out' });

    expect(created.paymentMethod).toBe('cod');
    expect(created.codAmount).toBe(created.total);
  });

  test('the order number takes the page prefix and the shop sequence', async () => {
    await landingOrderService.place(fullPage(), { ...BODY, offer: '3kg', zone: 'out' });
    expect(created.orderNo).toBe('AAM-0007');
  });

  test('a coupon is redeemed exactly once, and before the order is written', async () => {
    await landingOrderService.place(fullPage(), {
      ...BODY, offer: '3kg', zone: 'out', coupon: 'EID200',
    });

    expect(LandingPage.updateOne).toHaveBeenCalledTimes(1);
    // Ordering matters: the guarded increment is the only thing enforcing
    // `usageLimit`, so it must not run after the order exists.
    const reserveOrder = LandingPage.updateOne.mock.invocationCallOrder[0];
    const createOrder = LandingOrder.create.mock.invocationCallOrder[0];
    expect(reserveOrder).toBeLessThan(createOrder);
  });

  test('a redemption is handed back when the order fails to write', async () => {
    LandingOrder.create.mockRejectedValue(new Error('mongo down'));

    await expect(landingOrderService.place(fullPage(), {
      ...BODY, offer: '3kg', zone: 'out', coupon: 'EID200',
    })).rejects.toThrow('mongo down');

    // Two calls: the reserve, then the release. A leaked reservation only ever
    // makes a code run out early; never letting it overrun is the invariant.
    expect(LandingPage.updateOne).toHaveBeenCalledTimes(2);
    expect(LandingPage.updateOne.mock.calls[1][1]).toEqual({
      $inc: { 'coupons.$.usedCount': -1 },
    });
  });

  test('nothing is written for an order that fails validation', async () => {
    await expect(landingOrderService.place(fullPage(), { ...BODY, phone: '123' }))
      .rejects.toThrow(/phone/i);

    expect(LandingOrder.create).not.toHaveBeenCalled();
    expect(LandingPage.updateOne).not.toHaveBeenCalled();
  });

  test('an expired page refuses with 410, not 404', async () => {
    // The advertisement may still be running, and "gone" is the honest answer.
    const closed = fullPage();
    closed.expiresAt = new Date(Date.now() - 86400000);

    await expect(landingOrderService.place(closed, { ...BODY, offer: '3kg' }))
      .rejects.toMatchObject({ statusCode: 410, code: 'PAGE_CLOSED' });
  });

  test('the customer snapshot is normalised, and it is a snapshot', async () => {
    await landingOrderService.place(fullPage(), {
      ...BODY, phone: '+8801712345678', offer: '3kg', zone: 'out',
    });

    // Normalised so the duplicate check and the customers view group one person
    // together however they typed their number.
    expect(created.customer.phone).toBe('01712345678');
    expect(created.customer.name).toBe('রহিম উদ্দিন');
    // No Customer reference anywhere on the document (I-17).
    expect(created.customer._id).toBeUndefined();
    expect(created.items[0].label).toBe('৩ কেজি');
  });
});

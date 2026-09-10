/**
 * Self-serve checkout — the rules that decide whether a shop gets what it paid
 * for, and whether anyone else can get it for free.
 *
 * The load-bearing one, from which the rest follow:
 *
 *   **NOTHING A BROWSER SENDS CAN MOVE MONEY.**
 *
 * PayStation has no signed IPN. The `callback_url` it redirects to is
 * unauthenticated and forgeable by anyone who learns it, so the only thing that
 * may mark an order paid is a server-to-server `transaction-status` reply. The
 * first block below is that rule, asserted directly: a return handler firing
 * against a gateway that says `processing` must fulfil nothing, no matter what
 * the request carried.
 *
 * The pricing block exists for a subtler reason. A shop that negotiated a lower
 * monthly rate must not end up quoted MORE than list for a year — which is what
 * the obvious `months × negotiatedMonthly` formula does, because it silently
 * discards the ladder's volume discount.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const PlatformOrder = require('../models/PlatformOrder.model');
const { PLATFORM_ORDER_STATUS } = require('../models/PlatformOrder.model');
const PlatformPayment = require('../models/PlatformPayment.model');
const Shop = require('../models/Shop.model');
const SMSQuota = require('../models/SMSQuota.model');
const billingService = require('../services/billing.service');
const smsService = require('../services/sms.service');
const paystation = require('../services/payment/paystation.adapter');
const { TRX_STATUS } = paystation;

const checkoutService = require('../services/platformCheckout.service');

/** A Shop stand-in with just the surface checkout touches. */
function fakeShop(overrides = {}) {
  return {
    _id: 'shop1',
    name: 'হিসাব টেস্ট',
    phone: '01726315133',
    isActive: true,
    subscription: { plan: 'paid', status: 'active', expiresAt: new Date('2099-01-01'), graceDays: 0 },
    billing: { monthlyPrice: 800, smsUnitPrice: 0.4, currency: 'BDT' },
    access: { blockedAt: null },
    ...overrides,
  };
}

const SETTINGS = {
  defaultMonthlyPrice: 800,
  defaultSmsUnitPrice: 0.4,
  minSmsPurchaseAmount: 100,
  maxSelfServeAmount: 50000,
  billingProvider: 'paystation',
  subscriptionPackages: [
    { months: 1, price: 800, label: '১ মাস' },
    { months: 6, price: 4000, label: '৬ মাস' },
    { months: 12, price: 8000, label: '১ বছর' },
  ],
};

let adapterStub;
let createdOrders;

beforeEach(() => {
  createdOrders = [];
  process.env.API_PUBLIC_URL = 'https://api.example.com';

  jest.spyOn(billingService, 'getSettings').mockResolvedValue(SETTINGS);

  adapterStub = {
    env: 'sandbox',
    isConfigured: jest.fn(() => true),
    initiatePayment: jest.fn(async ({ invoiceNumber }) => ({
      paymentUrl: `https://sandbox.paystation.com.bd/checkout/${invoiceNumber}`,
      invoiceNumber,
      raw: { status_code: '200' },
    })),
    getTransactionStatus: jest.fn(),
    getProviderInfo: () => ({ name: 'paystation', configured: true }),
  };
  jest.spyOn(paystation, 'getAdapter').mockReturnValue(adapterStub);

  jest.spyOn(PlatformOrder, 'create').mockImplementation(async (doc) => {
    const order = {
      ...doc,
      _id: `order${createdOrders.length + 1}`,
      save: jest.fn().mockResolvedValue(undefined),
    };
    createdOrders.push(order);
    return order;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.API_PUBLIC_URL;
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TRUST RULE
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('a callback alone can never grant anything', () => {
  function paidOrder(overrides = {}) {
    return {
      _id: 'order1',
      shop: 'shop1',
      kind: 'subscription',
      months: 1,
      amount: 800,
      invoiceNumber: 'HSBTEST1',
      status: PLATFORM_ORDER_STATUS.INITIATED,
      gateway: {},
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  test('the gateway saying "processing" fulfils nothing, whatever the caller sent', async () => {
    const order = paidOrder();
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);
    adapterStub.getTransactionStatus.mockResolvedValue({
      found: true,
      status: TRX_STATUS.PROCESSING,
      // Note the amounts: the gateway reports the FULL amount on an unpaid
      // transaction. Anything keying off these grants a free subscription.
      paidAmount: 800,
      requestedAmount: 800,
      trxId: null,
      raw: {},
    });
    const applySpy = jest.spyOn(billingService, 'applySubscriptionPayment');

    const result = await checkoutService.verifyOrder('order1', { reason: 'return' });

    expect(result.pending).toBe(true);
    expect(result.fulfilled).toBeFalsy();
    expect(order.status).toBe(PLATFORM_ORDER_STATUS.INITIATED);
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('a gateway that cannot be reached never marks an order paid', async () => {
    const order = paidOrder();
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);
    jest.spyOn(PlatformOrder, 'updateOne').mockResolvedValue({});
    adapterStub.getTransactionStatus.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await checkoutService.verifyOrder('order1', { reason: 'return' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lookup_failed');
    expect(order.status).toBe(PLATFORM_ORDER_STATUS.INITIATED);
  });

  test('a failed transaction is recorded as failed, not retried into success', async () => {
    const order = paidOrder();
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);
    adapterStub.getTransactionStatus.mockResolvedValue({
      found: true, status: TRX_STATUS.FAILED, paidAmount: 800, trxId: null, raw: {},
    });

    const result = await checkoutService.verifyOrder('order1');

    expect(result.failed).toBe(true);
    expect(order.status).toBe(PLATFORM_ORDER_STATUS.FAILED);
  });

  test('a refunded transaction is never fulfilled', async () => {
    const order = paidOrder();
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);
    adapterStub.getTransactionStatus.mockResolvedValue({
      found: true, status: TRX_STATUS.REFUND, paidAmount: 800, trxId: 'T1', raw: {},
    });

    await checkoutService.verifyOrder('order1');

    expect(order.status).toBe(PLATFORM_ORDER_STATUS.FAILED);
  });

  test('a SHORT payment is quarantined, never fulfilled', async () => {
    const order = paidOrder();
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);
    adapterStub.getTransactionStatus.mockResolvedValue({
      found: true, status: TRX_STATUS.SUCCESS, paidAmount: 100, requestedAmount: 800,
      trxId: 'T1', raw: {},
    });
    const applySpy = jest.spyOn(billingService, 'applySubscriptionPayment');

    const result = await checkoutService.verifyOrder('order1');

    expect(result.underpaid).toBe(true);
    expect(order.status).toBe(PLATFORM_ORDER_STATUS.UNDERPAID);
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('an already-fulfilled order is not re-checked against the gateway', async () => {
    const order = paidOrder({ status: PLATFORM_ORDER_STATUS.FULFILLED });
    jest.spyOn(PlatformOrder, 'findById').mockResolvedValue(order);

    const result = await checkoutService.verifyOrder('order1');

    expect(result.alreadyFulfilled).toBe(true);
    expect(adapterStub.getTransactionStatus).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FULFILMENT IS IDEMPOTENT
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('fulfilment', () => {
  const claimable = () => ({
    _id: 'order1', shop: 'shop1', kind: 'subscription', months: 6, amount: 4000,
    invoiceNumber: 'HSBTEST1', status: PLATFORM_ORDER_STATUS.PAID,
    gateway: { trxId: 'CG20D8AYB4' }, paidAt: new Date(),
    save: jest.fn().mockResolvedValue(undefined),
  });

  test('the loser of the claim race does nothing at all', async () => {
    // The customer's browser and the reconciliation sweep routinely arrive at
    // the same order together. `findOneAndUpdate` returning null IS the loss.
    jest.spyOn(PlatformOrder, 'findOneAndUpdate').mockResolvedValue(null);
    const applySpy = jest.spyOn(billingService, 'applySubscriptionPayment');

    const result = await checkoutService.fulfilOrder(claimable());

    expect(result).toBeNull();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('the winner extends the subscription and stamps the gateway paymentId', async () => {
    const claimed = claimable();
    jest.spyOn(PlatformOrder, 'findOneAndUpdate').mockResolvedValue(claimed);
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());
    jest.spyOn(PlatformPayment, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ _id: 'pay1' }) }),
    });
    const applySpy = jest.spyOn(billingService, 'applySubscriptionPayment')
      .mockResolvedValue({});

    const result = await checkoutService.fulfilOrder(claimable());

    expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop1',
      mode: 'months',
      value: 6,
      amount: 4000,
      source: 'gateway',
      // The paymentId is what the partial-unique index on PlatformPayment keys
      // on — the second, independent layer of idempotency underneath the claim.
      gateway: expect.objectContaining({ provider: 'paystation', paymentId: 'CG20D8AYB4' }),
    }));
    expect(result.status).toBe(PLATFORM_ORDER_STATUS.FULFILLED);
  });

  test('an order that is not paid is never fulfilled', async () => {
    const applySpy = jest.spyOn(billingService, 'applySubscriptionPayment');
    for (const status of ['initiated', 'failed', 'underpaid', 'abandoned']) {
      expect(await checkoutService.fulfilOrder({ ...claimable(), status })).toBeNull();
    }
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('a fulfilment that throws leaves the order PAID and the claim held', async () => {
    // Deliberate: releasing the claim would let the sweep retry a deterministic
    // failure every five minutes forever. It sits at `paid` with a reason, which
    // is what the admin orders screen exists to surface.
    const claimed = claimable();
    jest.spyOn(PlatformOrder, 'findOneAndUpdate').mockResolvedValue(claimed);
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());
    jest.spyOn(billingService, 'applySubscriptionPayment')
      .mockRejectedValue(new Error('mongo went away'));

    const result = await checkoutService.fulfilOrder(claimable());

    expect(result).toBeNull();
    expect(claimed.status).toBe(PLATFORM_ORDER_STATUS.PAID);
    expect(claimed.failureReason).toMatch(/fulfilment failed/i);
  });

  test('an SMS order buys credits, not months', async () => {
    const smsOrder = {
      ...claimable(), kind: 'sms', months: undefined,
      smsQuantity: 250, smsUnitPrice: 0.4, amount: 100,
    };
    jest.spyOn(PlatformOrder, 'findOneAndUpdate').mockResolvedValue(smsOrder);
    jest.spyOn(Shop, 'findById').mockResolvedValue(fakeShop());
    jest.spyOn(PlatformPayment, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    const smsSpy = jest.spyOn(billingService, 'recordSmsPurchase').mockResolvedValue({});
    const subSpy = jest.spyOn(billingService, 'applySubscriptionPayment');

    await checkoutService.fulfilOrder({ ...smsOrder, status: PLATFORM_ORDER_STATUS.PAID });

    expect(subSpy).not.toHaveBeenCalled();
    expect(smsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system' }),
      expect.objectContaining({ quantity: 250, amount: 100, source: 'gateway' })
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PRICING — derived here, never accepted
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SWEEP MUST NEVER WRITE OFF MONEY IT HAS BEEN TOLD ABOUT
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('reconcile never abandons an order the gateway has named', () => {
  /**
   * `gateway.trxId` only ever comes from PayStation, and PayStation only issues
   * one once an instrument actually ran. So an order still `initiated` WITH a
   * trx id is not an abandoned checkout, it is unrecognised money — and once it
   * is marked `abandoned` nothing ever looks at it again.
   *
   * This is the containment for the class of bug behind the incident: a gateway
   * word we do not know keeps an order at `initiated`, and 24 hours later the
   * sweep writes ৳800 off as "Never completed".
   */
  function sweepEnv() {
    jest.spyOn(billingService, 'getSettings').mockResolvedValue(SETTINGS);
    jest.spyOn(PlatformOrder, 'find').mockImplementation((query) => {
      const chain = { sort: () => chain, limit: async () => [] };
      // The stranded-paid pass and the in-window pass return nothing here; only
      // the aged-with-trxId pass is under test.
      if (query.status === PLATFORM_ORDER_STATUS.INITIATED && query['gateway.trxId']) {
        chain.limit = async () => [{
          _id: 'order9', invoiceNumber: 'HSBLIVE1', gateway: { trxId: 'DIA0CQQFQU' },
        }];
      }
      return chain;
    });
  }

  test('the abandon query excludes anything carrying a trx id', async () => {
    sweepEnv();
    jest.spyOn(checkoutService, 'verifyOrder').mockResolvedValue({ ok: true, pending: true });
    const updateMany = jest.spyOn(PlatformOrder, 'updateMany').mockResolvedValue({ modifiedCount: 0 });

    await checkoutService.reconcile();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ 'gateway.trxId': { $in: [null, ''] } }),
      expect.anything()
    );
  });

  test('an aged order with a trx id is re-checked instead of written off', async () => {
    sweepEnv();
    const verify = jest.spyOn(checkoutService, 'verifyOrder')
      .mockResolvedValue({ ok: true, fulfilled: true });
    jest.spyOn(PlatformOrder, 'updateMany').mockResolvedValue({ modifiedCount: 0 });

    const summary = await checkoutService.reconcile();

    expect(verify).toHaveBeenCalledWith('order9', { reason: 'sweep' });
    expect(summary.fulfilled).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION SMS
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('payment confirmation SMS', () => {
  function shopQuery(shop) {
    jest.spyOn(Shop, 'findById').mockReturnValue({
      select: () => ({ lean: async () => shop }),
    });
  }

  const paidOrder = (overrides = {}) => ({
    _id: 'order1', shop: 'shop1', kind: 'subscription', months: 1, amount: 800,
    gateway: { trxId: 'DIA0CQQFQU', payerMobile: '01791284331' },
    ...overrides,
  });

  test('goes to the number the money actually came from', async () => {
    // Not the shop's registered phone: a manager who renews on the owner's
    // behalf is the one whose wallet was debited, and is who "the payment
    // maker" means.
    shopQuery({
      _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133',
      subscription: { expiresAt: new Date('2026-10-10T17:59:59.000Z') },
    });
    const send = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });

    await checkoutService.sendPaymentConfirmationSms(paidOrder());

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ phone: '01791284331' }));
  });

  test('falls back to the shop when the gateway reports no payer number', async () => {
    // Card payments carry no `payer_mobile_no` at all.
    shopQuery({
      _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133',
      billing: { billingContact: { phone: '01712345678' } },
      subscription: { expiresAt: new Date('2026-10-10T17:59:59.000Z') },
    });
    const send = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });

    await checkoutService.sendPaymentConfirmationSms(
      paidOrder({ gateway: { trxId: 'CARD1', payerMobile: null } })
    );

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ phone: '01712345678' }));
  });

  test('the subscription message carries the amount, the new expiry and the trx id', async () => {
    shopQuery({
      _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133',
      subscription: { expiresAt: new Date('2026-10-10T17:59:59.000Z') },
    });
    const send = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });

    await checkoutService.sendPaymentConfirmationSms(paidOrder());

    const { message } = send.mock.calls[0][0];
    expect(message).toContain('৳৮০০');
    // Bangladesh date, from an expiry stored as the last instant of a BD day.
    // Read with the server's local calendar this reads a different day either
    // side of UTC, which is a shopkeeper told the wrong date their access ends.
    expect(message).toContain('১০ অক্টোবর ২০২৬');
    expect(message).toContain('DIA0CQQFQU');
  });

  test('an SMS top-up is told how many messages it bought, not an expiry', async () => {
    shopQuery({ _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133' });
    const send = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });

    await checkoutService.sendPaymentConfirmationSms(
      paidOrder({ kind: 'sms', amount: 500, smsQuantity: 1250, months: undefined })
    );

    const { message } = send.mock.calls[0][0];
    expect(message).toContain('১২৫০');
    expect(message).toContain('এসএমএস');
    expect(message).not.toContain('মেয়াদ');
  });

  test('is a PLATFORM send — it never spends the quota it just sold', async () => {
    // Routing this through `sendSingle` would make a shop pay, out of the
    // credits it just bought, for the receipt saying the credits arrived.
    shopQuery({ _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133' });
    const system = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });
    const shopSend = jest.spyOn(smsService, 'sendSingle').mockResolvedValue({});

    await checkoutService.sendPaymentConfirmationSms(paidOrder());

    expect(system).toHaveBeenCalled();
    expect(shopSend).not.toHaveBeenCalled();
  });

  test('an SMS gateway failure never becomes a payment failure', async () => {
    // The money is banked and the shop is extended before this runs. A throw
    // escaping here would strand a fulfilled order.
    shopQuery({ _id: 'shop1', name: 'হিসাব টেস্ট', phone: '01726315133' });
    jest.spyOn(smsService, 'sendSystemSingle').mockRejectedValue(new Error('gateway down'));

    await expect(checkoutService.sendPaymentConfirmationSms(paidOrder())).resolves.toBeNull();
  });

  test('an unusable phone number is skipped rather than sent to', async () => {
    shopQuery({ _id: 'shop1', name: 'হিসাব টেস্ট', phone: 'n/a' });
    const send = jest.spyOn(smsService, 'sendSystemSingle').mockResolvedValue({ success: true });

    await checkoutService.sendPaymentConfirmationSms(
      paidOrder({ gateway: { trxId: 'X', payerMobile: '' } })
    );

    expect(send).not.toHaveBeenCalled();
  });
});

describe('quote', () => {
  test('a list-price shop is quoted the ladder exactly', async () => {
    const { packages } = await checkoutService.quote(fakeShop());
    expect(packages.map((p) => [p.months, p.price])).toEqual([[1, 800], [6, 4000], [12, 8000]]);
  });

  test('a NEGOTIATED shop keeps both its bargain and the volume discount', async () => {
    const shop = fakeShop({ billing: { monthlyPrice: 700, smsUnitPrice: 0.4 } });
    const { packages, isNegotiated } = await checkoutService.quote(shop);

    expect(isNegotiated).toBe(true);
    // 700, and 4000/4800 and 8000/9600 of (months × 700) — i.e. the ladder's own
    // discount factor applied to this shop's rate.
    expect(packages.map((p) => [p.months, p.price])).toEqual([[1, 700], [6, 3500], [12, 7000]]);
  });

  test('a negotiated shop is never quoted MORE than list for a longer package', async () => {
    // The bug the discount-factor arithmetic exists to prevent: `months ×
    // negotiatedMonthly` would quote this shop ৳8,400 for a year against a
    // ৳8,000 list price — punished for having bargained.
    const shop = fakeShop({ billing: { monthlyPrice: 700, smsUnitPrice: 0.4 } });
    const { packages } = await checkoutService.quote(shop);
    const year = packages.find((p) => p.months === 12);

    expect(year.price).toBeLessThan(8000);
    expect(year.price).toBeLessThan(12 * 700);
  });

  test('SMS quotes the flat rate with its ৳100 minimum', async () => {
    const { sms } = await checkoutService.quote(fakeShop());
    expect(sms.unitPrice).toBe(0.4);
    expect(sms.minAmount).toBe(100);
    expect(sms.minQuantity).toBe(250); // ৳100 = 250টি, the headline number
  });

  test('a negotiated SMS rate buys more for the same money', async () => {
    const shop = fakeShop({ billing: { monthlyPrice: 800, smsUnitPrice: 0.25 } });
    const { sms } = await checkoutService.quote(shop);
    expect(sms.unitPrice).toBe(0.25);
    expect(sms.minQuantity).toBe(400);
  });
});

describe('createSubscriptionOrder', () => {
  test('refuses a month count that is not a configured package', async () => {
    // The package list is the set of legal answers. An arbitrary number must be
    // refused, not honoured at a computed rate.
    await expect(
      checkoutService.createSubscriptionOrder({ shop: fakeShop(), months: 7 })
    ).rejects.toThrow(/no subscription package/i);
    expect(adapterStub.initiatePayment).not.toHaveBeenCalled();
  });

  test('the amount comes from the ladder, never from the caller', async () => {
    await checkoutService.createSubscriptionOrder({
      shop: fakeShop(), months: 12,
      // Even if a caller smuggled these through, nothing reads them.
      amount: 1, price: 1,
    });
    expect(createdOrders[0].amount).toBe(8000);
    expect(adapterStub.initiatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 8000 })
    );
  });

  test('a BLOCKED shop cannot pay us', async () => {
    // Not because the money is unwelcome — because a block is a considered
    // decision with a reason attached, and no payment should silently undo one.
    const blocked = fakeShop({ access: { blockedAt: new Date(), blockReason: 'abuse' } });
    await expect(
      checkoutService.createSubscriptionOrder({ shop: blocked, months: 1 })
    ).rejects.toThrow(/suspended/i);
  });

  test('an EXPIRED shop CAN pay us — that is the whole point', async () => {
    const expired = fakeShop({
      subscription: { plan: 'paid', status: 'expired', expiresAt: new Date('2020-01-01'), graceDays: 0 },
    });
    const result = await checkoutService.createSubscriptionOrder({ shop: expired, months: 1 });
    expect(result.paymentUrl).toContain('checkout');
  });

  test('checkout is refused while the provider is switched off', async () => {
    billingService.getSettings.mockResolvedValue({ ...SETTINGS, billingProvider: 'none' });
    await expect(
      checkoutService.createSubscriptionOrder({ shop: fakeShop(), months: 1 })
    ).rejects.toThrow(/not available/i);
  });

  test('checkout is refused when the provider is on but has no credentials', async () => {
    // Looks armed on the settings screen, 502s on the first real customer.
    adapterStub.isConfigured.mockReturnValue(false);
    await expect(
      checkoutService.createSubscriptionOrder({ shop: fakeShop(), months: 1 })
    ).rejects.toThrow(/not available/i);
  });

  test('a failed initiation leaves a FAILED order behind, not nothing', async () => {
    adapterStub.initiatePayment.mockRejectedValue(new Error('gateway down'));
    await expect(
      checkoutService.createSubscriptionOrder({ shop: fakeShop(), months: 1 })
    ).rejects.toThrow(/could not start/i);

    // The record is the only evidence a shop tried to pay and could not, which
    // is the first thing to look for when an owner phones to say it did not work.
    expect(createdOrders[0].status).toBe(PLATFORM_ORDER_STATUS.FAILED);
    expect(createdOrders[0].failureReason).toMatch(/gateway down/);
  });
});

describe('createSmsOrder', () => {
  test('derives the quantity from the amount — a caller cannot name it', async () => {
    await checkoutService.createSmsOrder({ shop: fakeShop(), amount: 500, quantity: 99999 });
    expect(createdOrders[0].smsQuantity).toBe(1250);
    expect(createdOrders[0].amount).toBe(500);
  });

  test('enforces the ৳100 minimum', async () => {
    await expect(
      checkoutService.createSmsOrder({ shop: fakeShop(), amount: 80 })
    ).rejects.toThrow(/minimum/i);
  });

  test('enforces the typo ceiling', async () => {
    await expect(
      checkoutService.createSmsOrder({ shop: fakeShop(), amount: 500000 })
    ).rejects.toThrow(/maximum/i);
  });

  test('floors rather than rounds — never hand out an unpaid message', async () => {
    await checkoutService.createSmsOrder({ shop: fakeShop(), amount: 199 });
    expect(createdOrders[0].smsQuantity).toBe(497); // 199 / 0.4 = 497.5
  });

  test('rejects a non-numeric amount', async () => {
    await expect(
      checkoutService.createSmsOrder({ shop: fakeShop(), amount: 'lots' })
    ).rejects.toThrow(/not valid/i);
  });
});

describe('invoice numbers', () => {
  test('are unique across a large batch', async () => {
    // The unique index is the real guarantee; this is about not hitting it. A
    // collision would surface as a gateway 1008 in front of a paying customer.
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(checkoutService.mintInvoiceNumber());
    expect(seen.size).toBe(5000);
  });

  test('are alphanumeric and short enough for the gateway', async () => {
    const invoice = checkoutService.mintInvoiceNumber();
    expect(invoice).toMatch(/^HSB[0-9A-Z]+$/);
    expect(invoice.length).toBeLessThanOrEqual(32);
  });
});

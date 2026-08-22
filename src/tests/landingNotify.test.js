/**
 * Landing page notifications — the invariant is that they never fail an order.
 *
 * A Telegram outage, an unlinked shop and an exhausted SMS balance are all
 * ordinary events. None of them is a reason to reject an order that is already
 * written, or to leave a customer staring at a spinner while a third party
 * times out. So every path here swallows its own errors, and these tests are
 * what stop someone "improving" that by letting one through.
 */

jest.mock('../services/telegram.service', () => ({ safeSend: jest.fn() }), { virtual: false });
jest.mock('../models/TelegramLink.model', () => ({ find: jest.fn() }), { virtual: false });
jest.mock('../services/sms.service', () => ({ sendSingle: jest.fn() }), { virtual: false });

const telegramService = require('../services/telegram.service');
const TelegramLink = require('../models/TelegramLink.model');
const smsService = require('../services/sms.service');
const landingNotify = require('../services/landingNotify.service');

const linksResolving = (rows) => ({ lean: () => Promise.resolve(rows) });

const ORDER = {
  shop: 'shop1',
  orderNo: 'AAM-0007',
  customer: { name: 'রহিম', phone: '01712345678', address: 'ধানমন্ডি, ঢাকা' },
  items: [{ label: '৫ কেজি', quantity: 2 }],
  total: 3600,
  codAmount: 3600,
  paymentMethod: 'cod',
};

beforeEach(() => {
  jest.clearAllMocks();
  TelegramLink.find.mockReturnValue(linksResolving([{ telegramChatId: '1', user: 'u1' }]));
  telegramService.safeSend.mockResolvedValue(true);
});

describe('orderPlaced', () => {
  test('sends to every linked chat', async () => {
    TelegramLink.find.mockReturnValue(linksResolving([
      { telegramChatId: '1', user: 'u1' },
      { telegramChatId: '2', user: 'u2' },
    ]));

    await landingNotify.orderPlaced({ title: 'আম ২০২৬', notifications: {} }, ORDER);
    expect(telegramService.safeSend).toHaveBeenCalledTimes(2);
  });

  test('the message names the campaign, not just the order number', async () => {
    // A shop running আম, লিচু and মধু at once gets three streams of these, and
    // the order prefix alone is a code they have to remember.
    await landingNotify.orderPlaced({ title: 'আম ২০২৬', notifications: {} }, ORDER);

    const [, text] = telegramService.safeSend.mock.calls[0];
    expect(text).toContain('আম ২০২৬');
    expect(text).toContain('AAM-0007');
    expect(text).toContain('01712345678');
  });

  test('an advance payment is called out with its TrxID and what is left to collect', async () => {
    // The one thing on the notification a human must act on before packing.
    await landingNotify.orderPlaced({ title: 'x', notifications: {} }, {
      ...ORDER,
      paymentMethod: 'advance',
      advance: { amount: 120, trxId: '9F2KXY7' },
      codAmount: 3480,
    });

    const [, text] = telegramService.safeSend.mock.calls[0];
    expect(text).toContain('9F2KXY7');
    expect(text).toContain('3480');
  });

  test('a page with telegram switched off sends nothing', async () => {
    await landingNotify.orderPlaced({ notifications: { telegram: false } }, ORDER);
    expect(telegramService.safeSend).not.toHaveBeenCalled();
  });

  test('a shop with no linked chat is not an error', async () => {
    TelegramLink.find.mockReturnValue(linksResolving([]));
    await expect(landingNotify.orderPlaced({ notifications: {} }, ORDER)).resolves.toBeUndefined();
  });

  test('a Telegram outage never reaches the caller', async () => {
    // The order is already written. Throwing here would turn a successful
    // purchase into an error screen on traffic the shop paid for.
    telegramService.safeSend.mockRejectedValue(new Error('bot api down'));
    await expect(landingNotify.orderPlaced({ notifications: {} }, ORDER)).resolves.toBeUndefined();
  });

  test('a database failure looking up the links does not either', async () => {
    TelegramLink.find.mockImplementation(() => { throw new Error('mongo down'); });
    await expect(landingNotify.orderPlaced({ notifications: {} }, ORDER)).resolves.toBeUndefined();
  });
});

describe('orderConfirmed', () => {
  test('is OFF unless the page opted in — it spends the shop money', async () => {
    await landingNotify.orderConfirmed({ notifications: {} }, ORDER);
    expect(smsService.sendSingle).not.toHaveBeenCalled();
  });

  test('texts the customer when the page opted in', async () => {
    await landingNotify.orderConfirmed({ notifications: { smsOnConfirm: true } }, ORDER);

    const [shopId, , phone, message] = smsService.sendSingle.mock.calls[0];
    expect(shopId).toBe('shop1');
    expect(phone).toBe('01712345678');
    expect(message).toContain('AAM-0007');
  });

  test('passes a null customer id — there is no Customer record and there must not be (I-17)', async () => {
    await landingNotify.orderConfirmed({ notifications: { smsOnConfirm: true } }, ORDER);
    expect(smsService.sendSingle.mock.calls[0][4]).toBeNull();
  });

  test('mentions the amount due at the door only when it differs from the total', async () => {
    await landingNotify.orderConfirmed({ notifications: { smsOnConfirm: true } }, {
      ...ORDER, total: 3600, codAmount: 3480,
    });
    expect(smsService.sendSingle.mock.calls[0][3]).toContain('3480');

    jest.clearAllMocks();
    await landingNotify.orderConfirmed({ notifications: { smsOnConfirm: true } }, ORDER);
    expect(smsService.sendSingle.mock.calls[0][3]).not.toContain('ডেলিভারিতে');
  });

  test('an exhausted SMS balance does not undo a confirmation the shop already made', async () => {
    smsService.sendSingle.mockRejectedValue(new Error('quota exceeded'));
    await expect(
      landingNotify.orderConfirmed({ notifications: { smsOnConfirm: true } }, ORDER)
    ).resolves.toBeUndefined();
  });
});

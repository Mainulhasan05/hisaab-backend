/**
 * The subscription price ladder, on the way in.
 *
 * Two failure modes are pinned here, and both are silent:
 *
 *   1. A FIELD MISSING FROM THE ALLOWLIST IS DROPPED WITHOUT A WORD. The admin
 *      form PATCHes, gets a 200 and a success toast, and nothing changed. This
 *      is not hypothetical — `subscriptionPackages`, `minSmsPurchaseAmount` and
 *      `maxSelfServeAmount` were each written into the model and the form before
 *      being added to that list, and every save appeared to work.
 *   2. A BLANK PRICE CASTS TO 0 IN MONGOOSE, which turns a package into a free
 *      year rather than a validation error.
 *
 * What is deliberately NOT rejected: a flat or inverted ladder. That is a
 * pricing judgement, and refusing the save would throw away the rest of an
 * operator's edits mid-way through a re-pricing. The form flags it on the row.
 */

jest.mock('../utils/logger.util', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const PlatformSetting = require('../models/PlatformSetting.model');
const billingController = require('../controllers/billing.controller');

function reqRes(body) {
  const req = { body, admin: { _id: 'admin1' } };
  const res = {
    statusCode: null, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.payload = p; return this; },
  };
  return { req, res };
}

/** Run the handler and surface what reached the database. */
async function patchSettings(body) {
  let captured = null;
  jest.spyOn(PlatformSetting, 'findOneAndUpdate').mockImplementation(async (filter, patch) => {
    captured = patch;
    return { ...patch, key: 'platform' };
  });

  const { req, res } = reqRes(body);
  let thrown = null;
  // asyncHandler swallows the throw into next(), so catch it there.
  await new Promise((resolve) => {
    billingController.updatePlatformSettings(req, res, (err) => { thrown = err; resolve(); });
    setImmediate(resolve);
  });
  return { captured, thrown, res };
}

afterEach(() => jest.restoreAllMocks());

describe('the settings allowlist', () => {
  test('carries subscriptionPackages through to the database', async () => {
    const { captured } = await patchSettings({
      subscriptionPackages: [
        { months: 12, price: 8000, label: '১ বছর', badge: 'সেরা মূল্য' },
        { months: 1, price: 800, label: '১ মাস' },
      ],
    });

    expect(captured.subscriptionPackages).toBeDefined();
    // Sorted ascending on the way in, so neither panel has to sort a list that
    // is supposed to already be a ladder.
    expect(captured.subscriptionPackages.map((p) => p.months)).toEqual([1, 12]);
    expect(captured.subscriptionPackages[1]).toMatchObject({ price: 8000, badge: 'সেরা মূল্য' });
  });

  test('carries the self-serve limits through', async () => {
    const { captured } = await patchSettings({
      minSmsPurchaseAmount: 100,
      maxSelfServeAmount: 50000,
    });
    expect(captured.minSmsPurchaseAmount).toBe(100);
    expect(captured.maxSelfServeAmount).toBe(50000);
  });

  test('accepts paystation as a billing provider', async () => {
    const { captured } = await patchSettings({ billingProvider: 'paystation' });
    expect(captured.billingProvider).toBe('paystation');
  });

  test('still ignores a key nobody allowed', async () => {
    const { captured } = await patchSettings({ defaultTrialDays: 30, somethingElse: 'x' });
    expect(captured.defaultTrialDays).toBe(30);
    expect(captured.somethingElse).toBeUndefined();
  });
});

describe('package validation', () => {
  test('a blank price is refused, not stored as a free year', async () => {
    const { thrown } = await patchSettings({
      subscriptionPackages: [{ months: 12, price: '' }],
    });
    expect(thrown).toBeTruthy();
    expect(thrown.message).toMatch(/price must be zero or more/i);
  });

  test('a fractional or out-of-range month count is refused', async () => {
    for (const months of [0, 1.5, 121, 'twelve']) {
      const { thrown } = await patchSettings({
        subscriptionPackages: [{ months, price: 800 }],
      });
      expect(thrown).toBeTruthy();
      expect(thrown.message).toMatch(/months must be a whole number/i);
    }
  });

  test('two packages at the same length are refused', async () => {
    const { thrown } = await patchSettings({
      subscriptionPackages: [
        { months: 6, price: 4000 },
        { months: 6, price: 4200 },
      ],
    });
    expect(thrown).toBeTruthy();
    expect(thrown.message).toMatch(/both offer 6/i);
  });

  test('a flat ladder is ALLOWED — that is a pricing call, not a data error', async () => {
    // Refusing it would throw away the rest of an operator's edits half way
    // through a re-pricing. The admin form flags the row instead.
    const { thrown, captured } = await patchSettings({
      subscriptionPackages: [
        { months: 1, price: 800 },
        { months: 12, price: 9600 },
      ],
    });
    expect(thrown).toBeNull();
    expect(captured.subscriptionPackages).toHaveLength(2);
  });

  test('a non-list is refused rather than silently coerced', async () => {
    const { thrown } = await patchSettings({ subscriptionPackages: { months: 1, price: 800 } });
    expect(thrown).toBeTruthy();
    expect(thrown.message).toMatch(/must be a list/i);
  });
});

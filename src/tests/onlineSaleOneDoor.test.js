/**
 * ONE DOOR INTO ONLINE SALES (I-24).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The till has carried an "অনলাইন অর্ডার" toggle since before `Order` existed —
 * it was the only way to record a Facebook sale. Once a shop has the order
 * worklist, that toggle becomes a SECOND door into the same business, and the
 * two doors cannot see each other:
 *
 *   · the same parcel can be confirmed from the worklist AND rung up at the
 *     counter. Stock comes off twice, the customer is billed twice on their
 *     খাতা, and nothing anywhere detects it;
 *   · a till-typed online sale has no `Order`, so no fulfilment lifecycle, no
 *     delivery address, no courier, no `Sale.order` — yet it reads
 *     `isOnline: true` and lands in the middle of every online figure;
 *   · the till offered `channel: 'website'`, a claim only the storefront can
 *     truthfully make.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MUST STAY TRUE FOR SHOPS WITHOUT THE WORKLIST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Most shops do not have `onlineOrders`, and for them the toggle is still the
 * only way to say a sale was not a walk-in. I-1 says a flag being off must
 * leave behaviour byte-identical to before the capability existed, so the
 * guard must be completely inert for them. That half is tested here too, and
 * it is the half a careless tightening would break.
 *
 * The guard runs BEFORE the transaction opens, so none of this needs a
 * database — which is also why it is cheap to assert that it does not reach one.
 */
const mongoose = require('mongoose');
const saleService = require('../services/sale.service');
const { runInTransaction } = require('../utils/transaction.util');

jest.mock('../utils/transaction.util', () => ({
  runInTransaction: jest.fn(),
  // `sale.service` pulls other helpers from this module at import time; they
  // are never reached because every test here either throws before the
  // transaction or asserts only that the transaction was entered.
  isInTransaction: jest.fn(() => false),
}));

const SHOP = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const ORDER = new mongoose.Types.ObjectId();

/** A request for a shop with or without the worklist capability. */
function reqFor({ onlineOrders }) {
  return { shop: { _id: SHOP, features: { onlineOrders } } };
}

const basket = (extra = {}) => ({
  items: [{ productId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
  customerName: 'Walk-in',
  ...extra,
});

beforeEach(() => {
  runInTransaction.mockReset();
  // If a call gets past the guard it lands here; returning a sentinel lets a
  // test assert "this was allowed through" without a database.
  runInTransaction.mockResolvedValue({ allowedThrough: true });
});

describe('a shop WITH the order worklist', () => {
  const req = reqFor({ onlineOrders: true });

  it('refuses an online sale typed at the till', async () => {
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: true, channel: 'facebook' }), req)
    ).rejects.toMatchObject({ statusCode: 400 });
    // And it never opened a transaction — the refusal is free.
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('points the cashier at the worklist rather than just saying no', async () => {
    // A refusal a shopkeeper cannot act on is a bug report in three days.
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: true }), req)
    ).rejects.toMatchObject({
      messageBn: expect.stringContaining('অর্ডার'),
    });
  });

  it('catches a channel set without isOnline', async () => {
    // The two fields disagree on real payloads: an older client posts a channel
    // and never sets the boolean. A guard reading only `isOnline` would let the
    // exact sale it exists to stop straight through.
    await expect(
      saleService.createSale(SHOP, USER, basket({ channel: 'whatsapp' }), req)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('treats the string "true" as online', async () => {
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: 'true' }), req)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('ALLOWS an ordinary counter sale', async () => {
    // The guard must not touch the path 99% of this shop's sales take.
    await expect(
      saleService.createSale(SHOP, USER, basket(), req)
    ).resolves.toEqual({ allowedThrough: true });
    expect(runInTransaction).toHaveBeenCalled();
  });

  it('ALLOWS the confirm path, which is the sanctioned door', async () => {
    /**
     * `confirmOrder` passes `order` from inside its own atomic claim, and that
     * is what distinguishes it from a client. Were this to fail, every online
     * order in the system would become unconfirmable — so it is the single most
     * important assertion in this file.
     */
    await expect(
      saleService.createSale(
        SHOP, USER,
        basket({ isOnline: true, channel: 'website' }),
        req,
        { order: ORDER }
      )
    ).resolves.toEqual({ allowedThrough: true });
    expect(runInTransaction).toHaveBeenCalled();
  });

  it('treats "false" and "" as not-online rather than as truthy strings', async () => {
    // `Boolean('false')` is true. A shop posting the string from a query-ish
    // client must not have every sale turned online — and then refused.
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: 'false', channel: '' }), req)
    ).resolves.toEqual({ allowedThrough: true });
  });
});

describe('a shop WITHOUT the order worklist — I-1, nothing changes', () => {
  const req = reqFor({ onlineOrders: false });

  it('still allows an online sale typed at the till', async () => {
    // For these shops the toggle is the ONLY way to record a Facebook sale.
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: true, channel: 'facebook' }), req)
    ).resolves.toEqual({ allowedThrough: true });
  });

  it('allows every channel the till offers', async () => {
    for (const channel of ['facebook', 'whatsapp', 'instagram', 'website', 'other']) {
      runInTransaction.mockClear();
      await expect(
        saleService.createSale(SHOP, USER, basket({ isOnline: true, channel }), req)
      ).resolves.toEqual({ allowedThrough: true });
    }
  });
});

describe('a shop whose features object is missing entirely', () => {
  it('fails OPEN for the sale, because hasFeature fails closed for the flag', async () => {
    /**
     * `req.shop` is rehydrated from Redis and a shop cached before a field
     * existed has `features === undefined`. `hasFeature` answers false there by
     * design, so the guard does not fire — which is the right direction: a
     * stale cache entry must not start refusing a shop's sales.
     */
    const req = { shop: { _id: SHOP } };
    await expect(
      saleService.createSale(SHOP, USER, basket({ isOnline: true }), req)
    ).resolves.toEqual({ allowedThrough: true });
  });
});

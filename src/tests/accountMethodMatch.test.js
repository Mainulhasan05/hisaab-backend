/**
 * An account must answer to the method the money was taken by.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * `assertUsableAccount` checked that a named account belonged to the shop, was
 * active, and was reachable from the caller's branch. It never checked that the
 * account matched the METHOD on the payment. So a payload saying
 * `method: 'bkash'` while naming the id of the ক্যাশ বাক্স was accepted and
 * booked exactly as sent: the bKash balance did not move, the cash box gained
 * money nobody had put in it, and the shop's cash count came up over at closing
 * with no row anywhere to explain the difference.
 *
 * The cash register is the sharpest case. Every one of its queries selects on
 * `method: 'cash'`, so a bKash payment that lands in a cash account is counted
 * as notes in the drawer. The shopkeeper counts the drawer, finds it short by
 * that amount, and has nothing to reconcile against.
 *
 * The picker now narrows its list to the chosen method, which stops the mistake
 * being MADE in the current UI. It does not stop it ARRIVING: a tab left open
 * before the change, a retried request, a direct API call and any older client
 * all post pairings the UI can no longer produce. That is why the rule lives on
 * the server, and why this suite asserts on the server.
 *
 * Two callers legitimately pass no method and must keep working: transfers,
 * where the two ends differ by definition, and the COD courier account, whose
 * method is `courier` and is never a tender.
 */
const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount.model');
const paymentAccountService = require('../services/paymentAccount.service');

const SHOP = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();

const reqFor = () => ({
  shop: { _id: SHOP, multiBranchEnabled: false, features: { fundAccounts: true } },
  branchId: null,
  user: { isOwner: true },
});

/** The stored account this lookup will find. */
function stubAccount(method, extra = {}) {
  return jest.spyOn(PaymentAccount, 'findOne').mockReturnValue({
    lean: () => Promise.resolve({
      _id: ACCOUNT,
      shop: SHOP,
      branch: null,
      name: 'ক্যাশ বাক্স',
      method,
      isActive: true,
      ...extra,
    }),
  });
}

afterEach(() => jest.restoreAllMocks());

describe('assertUsableAccount rejects a method/account mismatch', () => {
  it('refuses a bkash payment named against a cash account', async () => {
    stubAccount('cash');
    await expect(
      paymentAccountService.assertUsableAccount(SHOP, ACCOUNT, reqFor(), 'bkash')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers in Bengali, because a shopkeeper reads this one', async () => {
    stubAccount('cash');
    await expect(
      paymentAccountService.assertUsableAccount(SHOP, ACCOUNT, reqFor(), 'nagad')
    ).rejects.toMatchObject({ messageBn: 'পেমেন্ট মাধ্যম আর অ্যাকাউন্টটি মিলছে না' });
  });

  it('refuses the reverse too — cash named against a bkash account', async () => {
    // Not symmetric by accident: `cash` is the default method on every form, so
    // this is the direction a stale tab reaches most easily.
    stubAccount('bkash');
    await expect(
      paymentAccountService.assertUsableAccount(SHOP, ACCOUNT, reqFor(), 'cash')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts the matching pair', async () => {
    stubAccount('bkash');
    const account = await paymentAccountService.assertUsableAccount(
      SHOP, ACCOUNT, reqFor(), 'bkash'
    );
    expect(String(account._id)).toBe(String(ACCOUNT));
  });

  it('checks the method only when one is given', async () => {
    // Transfers and the COD courier account pass none. Omitting the argument
    // must behave exactly as it did before the check existed, or every transfer
    // in the app starts failing.
    stubAccount('courier');
    const account = await paymentAccountService.assertUsableAccount(SHOP, ACCOUNT, reqFor());
    expect(String(account._id)).toBe(String(ACCOUNT));
  });

  it('still refuses an inactive account before it looks at the method', async () => {
    // Ordering matters: an inactive account is 404 "not found", not 400
    // "mismatch". A mismatch message would tell the caller the account exists.
    stubAccount('bkash', { isActive: false });
    await expect(
      paymentAccountService.assertUsableAccount(SHOP, ACCOUNT, reqFor(), 'bkash')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns null for no account at all, unchanged', async () => {
    // Every caller relies on this: a shop without fund accounts sends nothing
    // and must not be handed an error for it.
    await expect(
      paymentAccountService.assertUsableAccount(SHOP, null, reqFor(), 'cash')
    ).resolves.toBeNull();
  });
});

describe('the money paths pass their method through', () => {
  // A source-level assertion rather than a behavioural one, for the same reason
  // `fundAccountWiring.test.js` makes: the failure being guarded against is a
  // future call site that forgets the argument, and no amount of exercising the
  // current ones would catch that.
  const fs = require('fs');
  const path = require('path');

  const CALLERS = [
    ['dueSettlement.service.js', 'rawAccount, req, method'],
    ['expense.service.js', "expenseData.account, req, paymentMethod || 'cash'"],
    ['purchase.service.js', 'leg.account, req, leg.method'],
    ['sale.service.js', 'leg.account, req, leg.method'],
    ['salesReturn.service.js', "returnData.account, req, 'cash'"],
    ['purchaseReturn.service.js', "returnData.account, req, 'cash'"],
  ];

  it.each(CALLERS)('%s names the method it is booking against', (file, fragment) => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    expect(body).toContain(fragment);
  });
});

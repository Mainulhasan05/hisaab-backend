/**
 * COD — the money that is with someone else.
 *
 * ── The bug these close ─────────────────────────────────────────────────────
 *
 * `order.service.confirmOrder` calls `createSale` with `paid: 0`, and
 * `sale.service` auto-creates a customer from the phone number. So a ৳2,400 COD
 * parcel was booked as ৳2,400 of CUSTOMER debt — and the customer owes nothing
 * until the parcel reaches them. The money genuinely owed to the shop is owed
 * by the COURIER, who is holding it.
 *
 * The বাকি list, `Customer.totalDue`, due-aging and the due-reminder SMS all
 * inherited it, so a shopkeeper chasing "customers who owe" was phoning people
 * whose parcel had not arrived.
 *
 * ── What these pin ──────────────────────────────────────────────────────────
 *
 *   · a courier is a `PaymentAccount`, and the branch rule needed no exception;
 *   · the handover never reaches the cash drawer;
 *   · dispatch and un-dispatch are expressed in row types the balance checker
 *     already understood, so `recalc-account-balances.js` needed no change;
 *   · a parcel a courier still holds cannot be voided behind their back;
 *   · a shop without fund accounts is untouched (I-1).
 *
 * See COD_PLAN.md.
 */
const mongoose = require('mongoose');
const fs = require('fs');
const PaymentAccount = require('../models/PaymentAccount.model');
const Sale = require('../models/Sale.model');
const Payment = require('../models/Payment.model');
const { PAYMENT_METHODS } = require('../config/constants');
const saleValidation = require('../validations/sale.validation');

const SHOP = new mongoose.Types.ObjectId();
const BRANCH = new mongoose.Types.ObjectId();
const COURIER = new mongoose.Types.ObjectId();

describe('a courier is a place the shop money sits', () => {
  it('is an accepted account type', () => {
    const account = new PaymentAccount({
      shop: SHOP, name: 'স্টেডফাস্ট', type: 'courier',
      method: PAYMENT_METHODS.COURIER, createdBy: SHOP,
    });

    expect(account.validateSync()).toBeUndefined();
  });

  it('is shop-wide, never bound to a branch', () => {
    // A courier serves the business, not a counter — a parcel dispatched from
    // Dhaka may be settled against the same account as one from Chittagong.
    // `branchFor` needed no courier case: only `cash` is branch-bound, and
    // everything else already fell through to null.
    expect(PaymentAccount.branchFor('courier', BRANCH)).toBeNull();
    expect(PaymentAccount.branchFor('cash', BRANCH)).toBe(BRANCH);
  });

  it('reads as shared, like a bank account', () => {
    const account = new PaymentAccount({
      shop: SHOP, name: 'পাঠাও', type: 'courier',
      method: PAYMENT_METHODS.COURIER, createdBy: SHOP,
    });

    expect(account.isShared).toBe(true);
  });

  it('rejects a type nobody defined', () => {
    const account = new PaymentAccount({
      shop: SHOP, name: 'x', type: 'van', method: 'cash', createdBy: SHOP,
    });

    expect(account.validateSync()?.errors?.type).toBeDefined();
  });
});

describe('the handover never reaches the drawer', () => {
  it('has a method of its own', () => {
    // Reusing 'cash' would report the till over by the day's dispatches: the
    // money is not in the box, it is in a van.
    expect(PAYMENT_METHODS.COURIER).toBe('courier');
  });

  it('is not the method any cash-register query matches', () => {
    // Every drawer aggregation filters `method: 'cash'`. This asserts the
    // property rather than trusting it: a courier leg reaching the till would
    // be invisible until someone counted the box.
    const source = fs.readFileSync(
      require.resolve('../services/cashRegister.service.js'), 'utf8'
    );

    expect(source).not.toContain("method: 'courier'");
    expect(source).toContain("method: 'cash'");
  });

  it('is a valid Payment method', () => {
    const payment = new Payment({
      shop: SHOP, amount: 2400, method: PAYMENT_METHODS.COURIER,
      type: 'sale_payment', receivedBy: SHOP,
    });

    expect(payment.validateSync()?.errors?.method).toBeUndefined();
  });
});

describe('the reversal reuses row types the checker already knew', () => {
  it('counts a dispatch as money IN against the account', () => {
    // `recalc-account-balances.js` sums `sale_payment` with an account as IN,
    // and `refund` with an account as OUT. Expressing dispatch and un-dispatch
    // in those two types is why that script needed no change — and a checker
    // that does not know about a write path is a checker that reports every
    // courier account as drifted.
    const source = fs.readFileSync(
      require.resolve('../../scripts/recalc-account-balances.js'), 'utf8'
    );

    // Matched loosely on the members rather than the exact array literal: the
    // set legitimately grows (customer advances added 'advance'), and a test
    // that fails on an ADDITION is testing the punctuation, not the rule. What
    // must hold is that the money-IN types are all still counted.
    const moneyIn = source.match(/type: \{ \$in: \[([^\]]+)\] \}/);
    expect(moneyIn).not.toBeNull();
    expect(moneyIn[1]).toContain("'sale_payment'");
    expect(moneyIn[1]).toContain("'due_collection'");
    expect(source).toContain("type: 'refund'");
  });

  it('reverses with a counter-row, never an edit', () => {
    // `Payment` carries `immutableGuard`. A reversal that edited or deleted the
    // original would be refused, and rightly — the handover happened.
    const source = fs.readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );
    const undispatch = source.slice(source.indexOf('async undispatchFromCourier'));
    const body = undispatch.slice(0, undispatch.indexOf('  // Cancel sale'));

    expect(body).toContain("type: 'refund'");
    expect(body).not.toContain('deleteOne');
    expect(body).not.toContain('findOneAndUpdate');
  });

  it('nets the legs rather than trusting sale.paid', () => {
    // A part-prepaid COD parcel has checkout money in `sale.paid` too.
    // Releasing `sale.paid` would claw back the customer's own advance.
    const source = fs.readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );

    expect(source).toContain("leg.type === 'refund' ? -(leg.amount || 0) : (leg.amount || 0)");
  });
});

describe('a parcel with a courier cannot be voided behind their back', () => {
  it('cancelSale refuses while a courier holds it', () => {
    // `cancelSale` reverses `sale.payments[]` — the CHECKOUT legs — and
    // deliberately leaves post-checkout rows alone. Cancelling a dispatched
    // parcel would leave the courier balance holding money for an invoice that
    // no longer exists, and the balance checker would report drift with no
    // write path to blame.
    const source = fs.readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );
    const cancel = source.slice(source.indexOf('  // Cancel sale'));

    expect(cancel).toContain('if (sale.courier) {');
    expect(cancel).toContain('পার্সেলটি এখনো কুরিয়ারের কাছে আছে');
  });

  it('says which step is missing, in Bengali', () => {
    // "Cannot cancel" with no reason is how a shopkeeper learns to distrust
    // the screen. The message names the action that unblocks it.
    const source = fs.readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );

    expect(source).toContain('আগে ফেরত এসেছে বলে রেকর্ড করুন');
  });
});

describe('the invoice carries which courier holds it', () => {
  it('stores a ref, not the free-text name', () => {
    // Shops type "Steadfast", "steadfast" and "স্টেডফাস্ট" for one courier.
    // Matching money on that string would split one courier into three
    // balances — the same argument `PaymentAccount.accountNumber` makes about
    // never being a key.
    expect(Sale.schema.path('courier')).toBeDefined();
    expect(Sale.schema.path('courier').options.ref).toBe('PaymentAccount');
    expect(Sale.schema.path('courier').defaultValue).toBeNull();
  });

  it('keeps courierName as the print snapshot', () => {
    expect(Sale.schema.path('courierName')).toBeDefined();
  });
});

describe('the dispatch route validates its input', () => {
  it('requires a courier account', () => {
    // A dispatch with no courier would move a balance nobody is answerable
    // for.
    const { error } = saleValidation.dispatchToCourier.validate({});

    expect(error).toBeDefined();
    expect(error.details[0].message).toContain('কুরিয়ার');
  });

  it('refuses an id that is not one', () => {
    const { error } = saleValidation.dispatchToCourier.validate({ account: 'steadfast' });

    expect(error).toBeDefined();
  });

  it('accepts a real account id', () => {
    const { error } = saleValidation.dispatchToCourier.validate({
      account: String(COURIER),
    });

    expect(error).toBeUndefined();
  });

  it('leaves the return reason optional', () => {
    // A parcel coming back is usually just "customer refused". A required box
    // here is a box to dismiss.
    expect(saleValidation.undispatchFromCourier.validate({}).error).toBeUndefined();
    expect(
      saleValidation.undispatchFromCourier.validate({ reason: 'গ্রাহক নেননি' }).error
    ).toBeUndefined();
  });
});

describe('invariant guards', () => {
  it('a sale with no courier is unchanged (I-1)', () => {
    // Every POS sale, every own-rider delivery, and every shop without
    // `features.fundAccounts`.
    const sale = new Sale({
      shop: SHOP, invoiceNo: 'INV-1',
      items: [{ product: new mongoose.Types.ObjectId(), productName: 'x', quantity: 1, unitPrice: 10, total: 10 }],
      subtotal: 10, total: 10, createdBy: SHOP,
    });

    expect(sale.courier).toBeNull();
  });

  it('the receipt SMS is suppressed on a handover', () => {
    // "আপনি ৳২,৪০০ পরিশোধ করেছেন" to a customer whose parcel has only just
    // left the shop is both untrue and alarming.
    const source = fs.readFileSync(
      require.resolve('../services/sale.service.js'), 'utf8'
    );

    expect(source).toContain('if (claimed.customer && !skipReceiptSms) {');
    expect(source).toContain('skipReceiptSms: true');
  });

  it('both routes are idempotent', () => {
    // A double-tapped "কুরিয়ারে দিলাম" on a slow connection would otherwise
    // write two legs and double the courier balance.
    const source = fs.readFileSync(
      require.resolve('../routes/sale.routes.js'), 'utf8'
    );

    expect(source).toContain("router.post('/:id/dispatch', idempotency()");
    expect(source).toContain("router.post('/:id/undispatch', idempotency()");
  });
});

/**
 * The screens that call the API.
 *
 * A backend that nobody presses is the state COD sat in for a day: routes live,
 * accounts creatable, and every parcel still landing on the customer's খাতা
 * because no button existed. `BACKLOG.md` Part 0 catalogues five features that
 * shipped in exactly that shape, so the wiring is pinned rather than assumed.
 *
 * Source scans, not renders — this is the backend suite and has no DOM. They
 * skip cleanly in a backend-only checkout.
 */
describe('the UI actually calls it', () => {
  const fs = require('fs');
  const path = require('path');
  const FRONTEND = path.resolve(__dirname, '../../../hisaab-frontend');
  const read = (rel) => {
    const full = path.join(FRONTEND, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  };

  it('the sale detail offers the handover and its reversal', () => {
    const src = read('app/(app)/dashboard/sales/[id]/page.js');
    if (src === null) return;

    expect(src).toContain('কুরিয়ারে দিন');
    expect(src).toContain('পার্সেল ফেরত এসেছে');
    expect(src).toContain('dispatchToCourier');
    expect(src).toContain('undispatchFromCourier');
  });

  it('hides the handover from shops that cannot use it', () => {
    // A courier IS a PaymentAccount, so without `fundAccounts` there is nothing
    // to pick. A button opening an empty list is worse than no button. And a
    // POS sale was handed over the counter — there is nothing to dispatch.
    const src = read('app/(app)/dashboard/sales/[id]/page.js');
    if (src === null) return;

    expect(src).toContain("sale.isOnline && !sale.courier");
    expect(src).toContain("hasFeature('fundAccounts')");
  });

  it('asks who took the parcel at the shipped step', () => {
    // The moment custody of the money transfers, which is why the courier is
    // named here rather than at confirm.
    const src = read('app/(app)/online/orders/[id]/page.js');
    if (src === null) return;

    expect(src).toContain('openShipDialog');
    expect(src).toContain('কে নিয়ে গেল?');
    // An own-rider delivery still ships, with the money left on the খাতা.
    expect(src).toContain('নিজেরাই পৌঁছে দিচ্ছি');
  });

  it('ships BEFORE handing the money over', () => {
    // If the dispatch fails the parcel is still shipped, which is true — it
    // physically left. The reverse ordering would move money for a parcel that
    // never went out.
    const src = read('app/(app)/online/orders/[id]/page.js');
    if (src === null) return;

    const ship = src.slice(src.indexOf('const runShip'));
    const body = ship.slice(0, ship.indexOf('const runStatus'));
    expect(body.indexOf("updateStatus(id, 'shipped')"))
      .toBeLessThan(body.indexOf('/dispatch'));
  });

  it('lets a courier account be created and seen', () => {
    // Both account screens keep their own TYPES map. The position screen was
    // missed first time round and rendered a courier as 'অন্যান্য'.
    for (const rel of [
      'app/(app)/dashboard/accounts/page.js',
      'app/(app)/dashboard/accounts/position/page.js',
    ]) {
      const src = read(rel);
      if (src === null) continue;
      expect([rel, src.includes('courier:')]).toEqual([rel, true]);
      expect([rel, src.includes('কুরিয়ার')]).toEqual([rel, true]);
    }
  });
});

/**
 * Every money path names an account, and every reversal gives it back.
 *
 * ── What these are for ──────────────────────────────────────────────────────
 *
 * `PaymentAccount.balance` is a stored rollup, and a stored rollup is only as
 * good as its least careful write path. `variants[].stock` had eight paths that
 * moved it and one that forgot, and the result was a stock figure that had been
 * quietly wrong for months on live data.
 *
 * So these do not test arithmetic — the arithmetic is a single `$inc`. They
 * test COVERAGE: that each place money moves calls `applyAccountDelta`, with the
 * right sign, and that each reversal calls it with the opposite one. A missing
 * call is the failure mode, and a missing call is invisible at runtime.
 *
 * Asserted against the SOURCE rather than by running the services, because
 * these paths open transactions, touch a dozen collections and are not
 * reachable without a database. That is the same reason `cashDrawerNoDoubleCount`
 * reads `sale.service.js` off disk to count its checkout flag.
 *
 * INVARIANT GUARDS, all of them: they fail when a future change drops a call,
 * not because anything is broken today.
 */
const fs = require('fs');

const read = (mod) => fs.readFileSync(require.resolve(`../services/${mod}`), 'utf8');

/** The body of the named async method, up to the next method at the same depth. */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async )?[a-zA-Z_][\w]*\s*\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('every money path resolves an account', () => {
  it.each([
    ['sale.service.js', 'createSale — the checkout legs'],
    ['purchase.service.js', 'createPurchase and recordPayment'],
    ['expense.service.js', 'createExpense'],
    ['dueSettlement.service.js', 'settleCustomerDue — every due collection'],
    ['salesReturn.service.js', 'createReturn and settleRefund'],
  ])('%s calls the account service (%s)', (mod) => {
    const source = read(mod);
    expect(source).toContain("require('./paymentAccount.service')");
    expect(source).toContain('applyAccountDelta');
  });
});

/**
 * A due collection now has TWO entry points — বাকি আদায় on the customer page
 * and surplus settled at the till — and exactly one implementation underneath.
 *
 * That is the whole point of the extraction, so these guard the delegation
 * rather than the arithmetic. Coverage moved: `customer.service.js` no longer
 * names `applyAccountDelta` itself, and a future change that quietly re-inlines
 * either path would pass every other test in this file while reintroducing the
 * drift the shared module exists to prevent.
 */
describe('both due-collection paths go through the one ledger write', () => {
  it('collectDuePayment delegates instead of writing the ledger itself', () => {
    const source = read('customer.service.js');
    expect(source).toContain("require('./dueSettlement.service')");
    expect(source).toContain('settleCustomerDue');
    // The tell-tale of a re-inlined copy: this method has no business creating
    // a payment row or touching an account balance of its own any more.
    const body = methodBody(source, 'async collectDuePayment(');
    expect(body).not.toContain('applyAccountDelta');
    expect(body).not.toContain('Payment.create');
  });

  it('createSale settles a khata through the same module', () => {
    const source = read('sale.service.js');
    expect(source).toContain("require('./dueSettlement.service')");
    const body = methodBody(source, 'async createSale(');
    expect(body).toContain('settleCustomerDue');
    // Tagged as the visit it rode in on, never as the invoice it settles. A
    // `sale` ref here would make every settling invoice unrevisable — see the
    // note on `Payment.viaSale`.
    expect(body).toContain('viaSale: sale._id');
  });

  it('the settlement is a due_collection, not a larger sale payment', () => {
    // Merging it into `sale.paid` overstates the day's revenue and breaks
    // `Customer.deriveDue`; the type is what keeps the two events apart in
    // every report and in the cash register.
    const source = read('dueSettlement.service.js');
    expect(source).toContain("type: 'due_collection'");
    // `atCheckout` must stay false even at checkout: this money is NOT inside
    // `Sale.payments[]`, so the register has to count it here or the drawer
    // reads short by every khata settled at the till.
    expect(source).not.toContain('atCheckout: true');
  });
});

describe('createSale moves money leg by leg, not by the dominant method', () => {
  const source = read('sale.service.js');

  it('applies a delta per payment leg', () => {
    // A ৳400 cash + ৳600 bKash invoice must credit two accounts. The `Payment`
    // row carries only the LARGEST method for the whole `paid`, so driving
    // balances off it would put ৳1000 into bKash and ৳0 into the drawer — the
    // same defect `report.service` had for the method breakdown.
    const body = methodBody(source, 'async createSale(');
    expect(body).toMatch(/for \(const leg of payments\)[\s\S]*?applyAccountDelta/);
  });

  it('resolves each leg before writing, so a bare method still books somewhere', () => {
    const body = methodBody(source, 'async createSale(');
    expect(body).toContain('resolveAccountForMethod');
    // Visibility is not authority — a named account is checked against the
    // caller's branch so an owner in All-Branches cannot ring a sale into
    // another branch's drawer.
    expect(body).toContain('assertUsableAccount');
  });

  it('passes the session, so a rolled-back sale rolls back its balances', () => {
    const body = methodBody(source, 'async createSale(');
    const deltaCall = body.slice(body.indexOf('for (const leg of payments)'));
    expect(deltaCall).toContain('session');
  });
});

describe('reversals give the money back', () => {
  it('cancelSale debits every leg it credited', () => {
    const body = methodBody(read('sale.service.js'), 'async cancelSale(');
    expect(body).toMatch(/sale\.payments \|\| \[\][\s\S]*?applyAccountDelta/);
    // Negative — the money leaves the account it went into.
    expect(body).toMatch(/amount: -\(Number\(leg\.amount\)/);
  });

  it('cancelPurchase credits back every leg it debited', () => {
    const body = methodBody(read('purchase.service.js'), 'async cancelPurchase(');
    expect(body).toMatch(/purchase\.payments \|\| \[\][\s\S]*?applyAccountDelta/);
    // Positive — a purchase took money out, so cancelling puts it back.
    expect(body).toMatch(/amount: Number\(leg\.amount\)/);
  });

  it('cancelSale reads the STORED account, never re-resolves the default', () => {
    // A shop can change which account is the default between the sale and its
    // cancellation. Re-resolving would debit today's default for money that
    // went into yesterday's, and both balances would then be wrong.
    const body = methodBody(read('sale.service.js'), 'async cancelSale(');
    expect(body).not.toContain('resolveAccountForMethod');
  });

  it('voidExpense returns the money to the account', () => {
    // A void is the ONLY way an expense can be undone — the row is immutable
    // and `deleteExpense` was removed. Without this the balance stays
    // permanently short by every retracted expense.
    const body = methodBody(read('expense.service.js'), 'async voidExpense(');
    expect(body).toContain('applyAccountDelta');
    expect(body).toMatch(/amount: Number\(expense\.amount\)/);
  });
});

describe('supplier payments finally carry a reference', () => {
  const body = methodBody(read('purchase.service.js'), 'async recordPayment(');

  it('accepts reference and transactionId from the caller', () => {
    // Both fields have existed on the `Payment` model all along; this method
    // simply never read them, so a ৳2,00,000 bank transfer was recorded as the
    // word `bank` with nothing to match against the statement.
    expect(body).toMatch(/const \{[^}]*reference[^}]*\}\s*=\s*paymentData/);
    expect(body).toMatch(/const \{[^}]*transactionId[^}]*\}\s*=\s*paymentData/);
  });

  it('writes them onto the Payment row', () => {
    const create = body.slice(body.indexOf('Payment.create'));
    expect(create).toContain('reference');
    expect(create).toContain('transactionId');
    expect(create).toContain('account');
  });

  it('takes the money out of the account', () => {
    expect(body).toMatch(/applyAccountDelta[\s\S]*?amount: -amount/);
  });
});

describe('purchases support split payment', () => {
  const body = methodBody(read('purchase.service.js'), 'async createPurchase(');

  it('derives paid and the primary method from the legs, like createSale', () => {
    // `paymentMethod` stays the largest leg so every existing reader — the list
    // filter, the cash register's cash query, the reports — keeps working.
    expect(body).toContain('payments.reduce');
    expect(body).toMatch(/primaryMethod|paymentMethod/);
  });

  it('never makes a leg out of `credit`', () => {
    // `credit` on a purchase means "not paid yet". It is the absence of a
    // payment, not a place money sits, so it must never become an account leg
    // or debit anything.
    expect(body).toContain("primaryMethod !== 'credit'");
  });
});

describe('the store-credit return debits only when it actually pays', () => {
  const source = read('salesReturn.service.js');

  it('leaves the account null for adjustment and store_credit', () => {
    // `adjustment` writes down the customer's due; an unsettled `store_credit`
    // moves nothing at all until someone pays it. Debiting at creation time
    // would take money out of the drawer that is still in it.
    const body = methodBody(source, 'async createReturn(');
    expect(body).toMatch(/refundMethod === 'cash'\s*\n?\s*\?/);
  });

  it('debits at settlement, which is when the money is handed over', () => {
    const body = methodBody(source, 'async settleRefund(');
    expect(body).toContain('applyAccountDelta');
    expect(body).toMatch(/amount: -amount/);
  });
});

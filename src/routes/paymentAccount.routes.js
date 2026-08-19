const express = require('express');
const router = express.Router();
const paymentAccountController = require('../controllers/paymentAccount.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireFeature } = require('../utils/features.util');
const paymentAccountValidation = require('../validations/paymentAccount.validation');

router.use(protect);

/**
 * The whole resource sits behind the capability, so a shop without
 * `fundAccounts` gets a 404 on every verb and the API cannot serve a feature
 * the shop has not been given even if a client asks for it directly. Same shape
 * as `brand.routes`.
 */
router.use(requireFeature('fundAccounts'));

/**
 * Names only, no balances — what a payment picker needs, and the reason it is
 * NOT behind `accounts.view`.
 *
 * A cashier ringing up a sale has to say which account took the money. Reading
 * what is IN the shop's bank account is a different question, and this codebase
 * already separates those two elsewhere — `products.view` shows the product,
 * `products.view_cost` shows what it cost. Gating the picker on `accounts.view`
 * would mean granting every cashier the balances to let them take a payment.
 *
 * Declared before `/:id` or Express would read 'options' as an account id.
 */
router.get('/options', paymentAccountController.getAccountOptions);

/**
 * Transfers. Declared before `/:id` so 'transfers' is not read as an account id.
 *
 * `transfer` and not `create`: creating an account is bookkeeping, moving
 * ৳60,000 out of the drawer is spending authority over the shop's money. No
 * role preset carries it — it stays with the owner until they hand it over.
 * Reading the history rides on `view`, which is the balances permission, because
 * a transfer list IS a statement of what the shop's money did.
 */
router.get('/transfers', rbac('accounts', 'view'), paymentAccountController.getTransfers);
router.post(
  '/transfers',
  rbac('accounts', 'transfer'),
  validate(paymentAccountValidation.createTransfer),
  paymentAccountController.createTransfer
);

/**
 * Money that is not trade — owner deposits and withdrawals, loans, corrections.
 *
 * On `accounts.update` rather than `transfer`: recording that the owner took
 * ৳30,000 out is bookkeeping about something that already happened, not the
 * authority to move the shop's money between its own accounts. `adjustment` is
 * the one type that IS dangerous, and it is gated owner-only inside the service
 * with a required reason — the same field-level shape as `openingBalance`.
 */
router.get('/entries', rbac('accounts', 'view'), paymentAccountController.getEntries);
router.post(
  '/entries',
  rbac('accounts', 'update'),
  validate(paymentAccountValidation.createEntry),
  paymentAccountController.createEntry
);

/**
 * Reconciliation — "the statement says X, the app says Y".
 *
 * Recording one moves no money, so it needs no spending authority; it is the
 * same act as counting the till, which rides on `cash_register.update`.
 */
router.get('/reconciliations', rbac('accounts', 'view'), paymentAccountController.getReconciliations);
router.post(
  '/reconciliations',
  rbac('accounts', 'update'),
  validate(paymentAccountValidation.reconcileAccount),
  paymentAccountController.reconcileAccount
);

/**
 * "আমার টাকা কোথায়" — every account, its balance, and what moved through it.
 *
 * The screen this whole feature exists for. Behind `view` because it IS the
 * balances.
 */
router.get('/position', rbac('accounts', 'view'), paymentAccountController.getMoneyPosition);

router.get('/', rbac('accounts', 'view'), paymentAccountController.getAccounts);
router.post(
  '/',
  rbac('accounts', 'create'),
  validate(paymentAccountValidation.createAccount),
  paymentAccountController.createAccount
);
router.get('/:id', rbac('accounts', 'view'), paymentAccountController.getAccount);
router.put(
  '/:id',
  rbac('accounts', 'update'),
  validate(paymentAccountValidation.updateAccount),
  paymentAccountController.updateAccount
);

/**
 * There is no DELETE. An account is soft-closed via `isActive: false` on the
 * PUT above: sales, purchases, expenses and payments point at it, and a
 * dangling reference turns settled history unreadable.
 */

module.exports = router;

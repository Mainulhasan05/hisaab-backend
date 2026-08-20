const express = require('express');
const router = express.Router();
const saleController = require('../controllers/sale.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');
const { validate } = require('../middleware/validate.middleware');
const saleValidation = require('../validations/sale.validation');

router.use(protect);

router.get('/', rbac('sales', 'view'), saleController.getSales);
// `validate` runs AFTER `idempotency` and `rbac` deliberately: a replayed
// request must return the first response without being re-validated, and an
// unauthorised caller must not be able to probe the schema.
router.post('/', idempotency(), rbac('sales', 'create'), validate(saleValidation.createSale), saleController.createSale);
router.get('/summary', rbac('sales', 'view'), saleController.getSalesSummary);
router.get('/today-summary', rbac('sales', 'view'), saleController.getTodaySummary);
router.get('/recent', rbac('sales', 'view'), saleController.getRecentSales);
router.get('/:id/payments', rbac('sales', 'view'), saleController.getSalePayments);
router.get('/:id', rbac('sales', 'view'), saleController.getSale);
router.patch('/:id/payment', idempotency(), rbac('sales', 'update'), saleController.recordPayment);

/**
 * COD handover and its reversal.
 *
 * Both ride on `sales.update` rather than a new action. Dispatching creates and
 * destroys no money — it records which of the shop's own accounts is holding it
 * — and it is done by whoever packs the parcel, who already records payments
 * against an invoice.
 *
 * `idempotency()` on both: a double-tapped "কুরিয়ারে দিলাম" on a slow
 * connection would otherwise write two legs and double the courier's balance.
 */
router.post('/:id/dispatch', idempotency(), rbac('sales', 'update'), validate(saleValidation.dispatchToCourier), saleController.dispatchToCourier);
router.post('/:id/undispatch', idempotency(), rbac('sales', 'update'), validate(saleValidation.undispatchFromCourier), saleController.undispatchFromCourier);
// Revising takes a full cart, so it is validated by the SAME schema as
// `POST /sales` — the payload is a basket, not a patch (SALE_REVISION_PLAN §3.3).
// Reusing the schema is what stops the two from drifting: a field added to the
// POS reaches both endpoints or neither.
//
// `idempotency()` matters more here than on a plain sale: a double-tapped
// সংশোধন would otherwise cancel the replacement invoice and write a third.
// `sales.revise`, not `update` — see the note on the action in config/permissions.js.
router.post('/:id/revise', idempotency(), rbac('sales', 'revise'), validate(saleValidation.createSale), saleController.reviseSale);
router.post('/:id/cancel', rbac('sales', 'delete'), saleController.cancelSale);

module.exports = router;

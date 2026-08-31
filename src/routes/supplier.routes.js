const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');
const { validate } = require('../middleware/validate.middleware');
const supplierValidation = require('../validations/supplier.validation');

router.use(protect);

router.get('/', rbac('suppliers', 'view'), supplierController.getSuppliers);
// Declared before `/:id` — an Express route defined after a matching param
// route never runs, and `opening-due` would otherwise be read as an id.
router.get('/:id/opening-due', rbac('suppliers', 'view'), supplierController.getOpeningDueHistory);
// Owner-only, and not merely `suppliers.update`: this writes a payable that no
// purchase backs, which no counter-transaction can undo. A cashier who could
// reach it could manufacture or erase what the shop owes.
router.post('/:id/opening-due', idempotency(), ownerOnly, supplierController.setOpeningDue);

/**
 * পরিশোধ — money going OUT to a vendor.
 *
 * `purchases.update` rather than a suppliers permission: this is the same
 * authority as recording a payment against a bill, which is what it does when
 * there are bills to settle. Idempotent, because a double-tapped পরিশোধ on a
 * slow connection must not pay a vendor twice.
 */
router.post(
  '/:id/payment',
  idempotency(),
  rbac('purchases', 'update'),
  validate(supplierValidation.paySupplier),
  supplierController.paySupplier
);
router.get('/:id/payments', rbac('purchases', 'view'), supplierController.getSupplierPayments);

/**
 * অগ্রিম — money handed over BEFORE the goods.
 *
 * Owner-only, and deliberately a higher bar than পরিশোধ above. Settling a bill
 * discharges an obligation the shop already had; paying ahead creates a CLAIM
 * on a vendor and parts with cash for nothing yet received. That is a decision
 * about the shop's money rather than a record of one already made.
 */
router.post(
  '/:id/advance',
  idempotency(),
  ownerOnly,
  validate(supplierValidation.paySupplier),
  supplierController.paySupplierAdvance
);

/**
 * Voiding one is owner-only, and deliberately a different bar from making one.
 *
 * Recording a payment states what happened at the counter; reversing one
 * un-states it, moves cash back into an account and raises a payable that was
 * closed. That is a correction to the books rather than an entry in them.
 */
router.post(
  '/payments/:paymentId/void',
  idempotency(),
  ownerOnly,
  validate(supplierValidation.voidPayment),
  supplierController.voidSupplierPayment
);
router.get('/:id', rbac('suppliers', 'view'), supplierController.getSupplier);
router.post('/', idempotency(), rbac('suppliers', 'create'), supplierController.createSupplier);
router.put('/:id', rbac('suppliers', 'update'), supplierController.updateSupplier);
router.delete('/:id', rbac('suppliers', 'delete'), supplierController.deleteSupplier);

module.exports = router;

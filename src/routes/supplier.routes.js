const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');

router.use(protect);

router.get('/', rbac('suppliers', 'view'), supplierController.getSuppliers);
// Declared before `/:id` — an Express route defined after a matching param
// route never runs, and `opening-due` would otherwise be read as an id.
router.get('/:id/opening-due', rbac('suppliers', 'view'), supplierController.getOpeningDueHistory);
// Owner-only, and not merely `suppliers.update`: this writes a payable that no
// purchase backs, which no counter-transaction can undo. A cashier who could
// reach it could manufacture or erase what the shop owes.
router.post('/:id/opening-due', idempotency(), ownerOnly, supplierController.setOpeningDue);
router.get('/:id', rbac('suppliers', 'view'), supplierController.getSupplier);
router.post('/', idempotency(), rbac('suppliers', 'create'), supplierController.createSupplier);
router.put('/:id', rbac('suppliers', 'update'), supplierController.updateSupplier);
router.delete('/:id', rbac('suppliers', 'delete'), supplierController.deleteSupplier);

module.exports = router;

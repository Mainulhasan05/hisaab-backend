const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');

router.use(protect);

router.get('/', rbac('suppliers', 'view'), supplierController.getSuppliers);
router.get('/:id', rbac('suppliers', 'view'), supplierController.getSupplier);
router.post('/', idempotency(), rbac('suppliers', 'create'), supplierController.createSupplier);
router.put('/:id', rbac('suppliers', 'update'), supplierController.updateSupplier);
router.delete('/:id', rbac('suppliers', 'delete'), supplierController.deleteSupplier);

module.exports = router;

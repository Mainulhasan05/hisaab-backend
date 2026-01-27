const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewPurchases, canCreatePurchases, canEditPurchases, canDeletePurchases } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Supplier CRUD
router.get('/', canViewPurchases, supplierController.getSuppliers);
router.get('/:id', canViewPurchases, supplierController.getSupplier);
router.post('/', canCreatePurchases, supplierController.createSupplier);
router.put('/:id', canEditPurchases, supplierController.updateSupplier);
router.delete('/:id', canDeletePurchases, supplierController.deleteSupplier);

module.exports = router;

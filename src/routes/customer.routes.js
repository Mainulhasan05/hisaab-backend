const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewCustomers, canCreateCustomers, canEditCustomers, canDeleteCustomers } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Customer routes
router.get('/', canViewCustomers, customerController.getCustomers);
router.post('/', canCreateCustomers, customerController.createCustomer);
router.get('/with-due', canViewCustomers, customerController.getCustomersWithDue);
router.get('/top', canViewCustomers, customerController.getTopCustomers);
router.post('/bulk-import', canCreateCustomers, customerController.bulkImport);
router.get('/phone/:phone', canViewCustomers, customerController.getCustomerByPhone);
router.get('/:id', canViewCustomers, customerController.getCustomer);
router.put('/:id', canEditCustomers, customerController.updateCustomer);
router.delete('/:id', canDeleteCustomers, customerController.deleteCustomer);
router.post('/:id/collect-due', canEditCustomers, customerController.collectDue);
router.get('/:id/history', canViewCustomers, customerController.getCustomerHistory);

module.exports = router;

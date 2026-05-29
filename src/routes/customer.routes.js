const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/', rbac('customers', 'view'), customerController.getCustomers);
router.post('/', rbac('customers', 'create'), customerController.createCustomer);
router.get('/with-due', rbac('customers', 'view'), customerController.getCustomersWithDue);
router.get('/top', rbac('customers', 'view'), customerController.getTopCustomers);
router.get('/leaderboard', rbac('customers', 'view'), customerController.getCustomerLeaderboard);
router.post('/bulk-import', rbac('customers', 'create'), customerController.bulkImport);
router.get('/phone/:phone', rbac('customers', 'view'), customerController.getCustomerByPhone);
router.get('/:id', rbac('customers', 'view'), customerController.getCustomer);
router.put('/:id', rbac('customers', 'update'), customerController.updateCustomer);
router.delete('/:id', rbac('customers', 'delete'), customerController.deleteCustomer);
router.post('/:id/collect-due', rbac('customers', 'update'), customerController.collectDue);
router.get('/:id/history', rbac('customers', 'view'), customerController.getCustomerHistory);

module.exports = router;

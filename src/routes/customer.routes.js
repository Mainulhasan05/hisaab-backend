const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');
const idempotency = require('../middleware/idempotency.middleware');

router.use(protect);

router.get('/', rbac('customers', 'view'), customerController.getCustomers);
router.post('/', rbac('customers', 'create'), customerController.createCustomer);
router.get('/with-due', rbac('customers', 'view'), customerController.getCustomersWithDue);
router.get('/top', rbac('customers', 'view'), customerController.getTopCustomers);
router.get('/leaderboard', rbac('customers', 'view'), customerController.getCustomerLeaderboard);
router.post('/bulk-import/validate', rbac('customers', 'create'), customerController.validateImport);
router.post('/bulk-import', idempotency(), rbac('customers', 'create'), customerController.bulkImport);
router.get('/phone/:phone', rbac('customers', 'view'), customerController.getCustomerByPhone);
router.get('/:id([0-9a-fA-F]{24})', rbac('customers', 'view'), customerController.getCustomer);
router.put('/:id([0-9a-fA-F]{24})', rbac('customers', 'update'), customerController.updateCustomer);
router.delete('/:id([0-9a-fA-F]{24})', rbac('customers', 'delete'), customerController.deleteCustomer);
// Undoing a removal is the same authority as making one, so this rides
// `customers.delete` rather than `update` — a cashier who cannot delete a
// customer has no business resurrecting one. Reusing the existing action also
// keeps every stored role preset valid with nothing to backfill.
router.post('/:id([0-9a-fA-F]{24})/restore', rbac('customers', 'delete'), customerController.restoreCustomer);
router.post('/:id([0-9a-fA-F]{24})/collect-due', idempotency(), rbac('customers', 'update'), customerController.collectDue);
// Owner-only, and not merely `customers.update`: this writes a receivable that
// no invoice backs, which is the one customer-desk action a counter-sale cannot
// undo. A cashier who could reach it could manufacture or erase debt.
router.post('/:id([0-9a-fA-F]{24})/opening-due', idempotency(), ownerOnly, customerController.setOpeningDue);
// Re-printing a বাকি আদায় receipt. `customers.view`, not `update`: handing a
// customer a copy of a receipt they already have is reading, and a staff member
// trusted to see the খতিয়ান is trusted to reprint a line from it.
router.get(
  '/:id([0-9a-fA-F]{24})/receipts/:paymentId([0-9a-fA-F]{24})',
  rbac('customers', 'view'),
  customerController.getPaymentReceipt
);
router.get('/:id([0-9a-fA-F]{24})/ledger', rbac('customers', 'view'), customerController.getCustomerLedger);
router.get('/:id([0-9a-fA-F]{24})/history', rbac('customers', 'view'), customerController.getCustomerHistory);

module.exports = router;

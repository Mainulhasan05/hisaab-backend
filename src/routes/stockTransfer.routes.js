const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const stockTransferController = require('../controllers/stockTransfer.controller');

// All routes require auth
router.use(protect);

router.get('/', rbac('stock_transfers', 'view'), stockTransferController.getTransfers);
router.post('/', rbac('stock_transfers', 'create'), stockTransferController.createTransfer);
router.post('/preview', rbac('stock_transfers', 'create'), stockTransferController.previewTransfer);
// Before '/:id', or Express reads 'report' as a transfer id and 404s it.
router.get('/report', rbac('stock_transfers', 'view'), stockTransferController.getTransferReport);
// Owner-only, enforced in the service (it reads the other branch's stock).
router.get('/suggestions', rbac('stock_transfers', 'create'), stockTransferController.getTransferSuggestions);
router.get('/:id', rbac('stock_transfers', 'view'), stockTransferController.getTransferById);
router.patch('/:id/approve', rbac('stock_transfers', 'update'), stockTransferController.approveTransfer);
router.get('/:id/receive-check', rbac('stock_transfers', 'update'), stockTransferController.getReceiveCheck);
router.patch('/:id/receive', rbac('stock_transfers', 'update'), stockTransferController.receiveTransfer);
router.patch('/:id/reject', rbac('stock_transfers', 'update'), stockTransferController.rejectTransfer);

module.exports = router;

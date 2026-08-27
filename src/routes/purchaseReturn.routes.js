const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const purchaseReturnController = require('../controllers/purchaseReturn.controller');
const idempotency = require('../middleware/idempotency.middleware');

/**
 * `/api/purchase-returns` — কেনা ফেরত (PURCHASE_RETURN_PLAN.md §4).
 *
 * Permissions are the PURCHASE module's, not a module of their own: a return is
 * an amendment to a bill, and anyone trusted to record a delivery and pay for
 * it is trusted to send part of it back. Inventing `purchaseReturns.*` would
 * mean every existing role preset silently losing the capability the day this
 * shipped.
 *
 * ── Why the two writes carry `idempotency()` ────────────────────────────────
 *
 * Both move stock and money, and both are reached from a phone on a patchy
 * connection where a double tap is ordinary. The middleware is a no-op without
 * the client's header, so nothing regresses for a caller that does not send
 * one. Same wiring the sales-return routes carry.
 *
 * ── There is deliberately no cancel route (D-4) ─────────────────────────────
 *
 * A purchase return is a ledger row, not a draft — see the `immutableGuard` on
 * the model. Correcting one means recording the goods coming BACK from the
 * supplier, which is a purchase.
 *
 * `/purchase/:purchaseId` is mounted before `/:id` so a purchase id can never
 * be read as a return id.
 */

router.use(protect);

router.get('/', rbac('purchases', 'view'), purchaseReturnController.getReturns);
router.post('/', idempotency(), rbac('purchases', 'update'), purchaseReturnController.createReturn);
router.get('/summary', rbac('purchases', 'view'), purchaseReturnController.getReturnsSummary);
router.get('/purchase/:purchaseId', rbac('purchases', 'view'), purchaseReturnController.getReturnsByPurchase);
router.get('/purchase/:purchaseId/returnable', rbac('purchases', 'view'), purchaseReturnController.getReturnableItems);
// Receiving the money moves an account balance, so it needs the same permission
// the return itself does — not merely 'view'.
router.patch('/:id/settle', idempotency(), rbac('purchases', 'update'), purchaseReturnController.settleRefund);
router.get('/:id', rbac('purchases', 'view'), purchaseReturnController.getReturn);

module.exports = router;

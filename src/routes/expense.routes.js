const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { requireFeature } = require('../utils/features.util');
const { aiParseLimiter } = require('../middleware/rateLimiter.middleware');

router.use(protect);

// ── AI expense entry ───────────────────────────────────────────────────────
//
// Declared BEFORE `/:id` — Express matches in order, and without this the
// `PUT /:id` route below would take `/ai/parse` as an update to an expense
// whose id is the string "ai". Same ordering hazard the admin media routes
// carry a comment about.
//
// `requireFeature` answers 404, not 403: to a shop without the capability this
// resource does not exist, and a 403 would advertise that it does.
//
// `expenses.create` and not `view`. This drafts a write and spends the branch's
// AI allowance; a view-only cashier must be able to do neither.
router.get(
  '/ai/usage',
  requireFeature('aiExpense'),
  rbac('expenses', 'create'),
  expenseController.getAiUsage
);
router.post(
  '/ai/parse',
  requireFeature('aiExpense'),
  rbac('expenses', 'create'),
  aiParseLimiter,
  expenseController.aiParse
);

// Expense categories
router.get('/categories', rbac('expenses', 'view'), expenseController.getCategories);
router.post('/categories', rbac('expenses', 'create'), expenseController.createCategory);
router.delete('/categories/:id', rbac('expenses', 'delete'), expenseController.deleteCategory);

// Expense summary
router.get('/summary', rbac('expenses', 'view'), expenseController.getSummary);

// Expense CRUD
router.get('/', rbac('expenses', 'view'), expenseController.getExpenses);
router.post('/', rbac('expenses', 'create'), expenseController.createExpense);
// Several at once. NOT gated on `aiExpense` — entering five closing-time
// expenses by hand is an ordinary workflow, and keeping this open is also what
// makes the AI path testable without spending a Gemini call.
router.post('/bulk', rbac('expenses', 'create'), expenseController.createBulk);
router.put('/:id', rbac('expenses', 'update'), expenseController.updateExpense);
// Void, not delete. `immutableGuard` on the Expense model refuses every hard
// delete, so the old `DELETE /:id` route could not succeed for any role — it
// answered 403 to the owner too. Same `expenses.delete` permission: retracting
// an expense is the same authority, only now it is an operation that works.
router.post('/:id/void', rbac('expenses', 'delete'), expenseController.voidExpense);

module.exports = router;

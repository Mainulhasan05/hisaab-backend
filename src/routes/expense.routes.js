const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

// Expense categories
router.get('/categories', rbac('expenses', 'view'), expenseController.getCategories);
router.post('/categories', rbac('expenses', 'create'), expenseController.createCategory);
router.delete('/categories/:id', rbac('expenses', 'delete'), expenseController.deleteCategory);

// Expense summary
router.get('/summary', rbac('expenses', 'view'), expenseController.getSummary);

// Expense CRUD
router.get('/', rbac('expenses', 'view'), expenseController.getExpenses);
router.post('/', rbac('expenses', 'create'), expenseController.createExpense);
router.put('/:id', rbac('expenses', 'update'), expenseController.updateExpense);
// Void, not delete. `immutableGuard` on the Expense model refuses every hard
// delete, so the old `DELETE /:id` route could not succeed for any role — it
// answered 403 to the owner too. Same `expenses.delete` permission: retracting
// an expense is the same authority, only now it is an operation that works.
router.post('/:id/void', rbac('expenses', 'delete'), expenseController.voidExpense);

module.exports = router;

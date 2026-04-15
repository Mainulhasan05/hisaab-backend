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
router.delete('/:id', rbac('expenses', 'delete'), expenseController.deleteExpense);

module.exports = router;

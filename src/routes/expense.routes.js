const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const { protect } = require('../middleware/auth.middleware');
const { canViewExpenses, canCreateExpenses, canEditExpenses, canDeleteExpenses } = require('../middleware/permission.middleware');

// All routes require authentication
router.use(protect);

// Expense categories
router.get('/categories', canViewExpenses, expenseController.getCategories);
router.post('/categories', canCreateExpenses, expenseController.createCategory);
router.delete('/categories/:id', canDeleteExpenses, expenseController.deleteCategory);

// Expense summary
router.get('/summary', canViewExpenses, expenseController.getSummary);

// Expense CRUD
router.get('/', canViewExpenses, expenseController.getExpenses);
router.post('/', canCreateExpenses, expenseController.createExpense);
router.put('/:id', canEditExpenses, expenseController.updateExpense);
router.delete('/:id', canDeleteExpenses, expenseController.deleteExpense);

module.exports = router;

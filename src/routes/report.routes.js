const express = require('express');
const router = express.Router();
const reportController = require('../controllers/report.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');

router.use(protect);

router.get('/dashboard', rbac('reports', 'view'), reportController.getDashboard);
router.get('/sales', rbac('reports', 'view'), reportController.getSalesReport);
router.get('/products', rbac('reports', 'view'), reportController.getProductReport);
router.get('/customers', rbac('reports', 'view'), reportController.getCustomerReport);
router.get('/profit-loss', rbac('reports', 'view_profit'), reportController.getProfitLoss);
// `view_profit`, matching the capability registry on the client. The payload is
// the day's profit picture — net earnings plus the figures it decomposes into —
// so the route is gated on the profit permission rather than plain report
// access. `sanitizeReport` below is still applied: the route decides who may
// ask, the sanitiser decides what comes back.
router.get('/daily-summary', rbac('reports', 'view_profit'), reportController.getDailySummary);
router.get('/staff', rbac('reports', 'view'), reportController.getStaffReport);
router.get('/staff-detailed', rbac('reports', 'view'), reportController.getDetailedStaffReport);
router.get('/date-wise', rbac('reports', 'view'), reportController.getDateWiseSummary);
// The month book — `/date-wise` a zoom level out, and gated exactly like it.
//
// `reports.view` rather than `view_profit`, and the distinction is the same one
// `/daily-summary` resolves the other way: that payload IS a profit picture and
// has nothing left once profit is withheld, while this one keeps বিক্রি, খরচ,
// কেনা, বাকি and নগদ — the "total business amount" half of the question — for a
// reader who may not see margin. `sanitizeReport` in the controller strips the
// profit keys per user, so the route decides who may ask and the sanitiser
// decides what comes back.
//
// Whether the per-BRANCH columns come back is a third question, and the
// controller answers that one from the caller's branch scope.
router.get('/month-wise', rbac('reports', 'view'), reportController.getMonthWiseSummary);
router.get('/date-wise/:date', rbac('reports', 'view'), reportController.getSalesByDate);
router.get('/trending-products', rbac('reports', 'view'), reportController.getTrendingProducts);
router.get('/due-aging', rbac('reports', 'view'), reportController.getDueAging);
// The payables half. `reports.view` like its receivables twin and like every
// other route on this router — reports are their own module in the permission
// matrix, and `suppliers.view` is not additionally required for the same reason
// `customers.view` is not required above.
router.get('/payable-aging', rbac('reports', 'view'), reportController.getPayableAging);

// Printable documents. Registered before the `/:type/export/:format` catch-all
// below — that route is three segments deep so it cannot shadow these, but
// keeping specific paths above a parameterised one is the rule that stops the
// next addition from quietly becoming a report type named "stock".
//
// Gated on `reports.view` and NOT additionally on `customers.view` /
// `suppliers.view` / `products.view`, matching every other route on this
// router: reports are their own module in the permission matrix, and a shop
// that grants report access is granting the reports it contains. The cost and
// profit COLUMNS are a separate question and are answered by `sanitizeReport`
// in the controller, per user, not per route.
router.get('/customer-statement', rbac('reports', 'view'), reportController.getCustomerStatement);
router.get('/supplier-statement', rbac('reports', 'view'), reportController.getSupplierStatement);
router.get('/stock', rbac('reports', 'view'), reportController.getStockReport);
// পণ্যভিত্তিক বিক্রি — one row per sale line: when, who sold it, which invoice,
// which customer, at what price. `reports.view` like the rest of this router;
// it names customers and staff, so it is not opened to `products.view` alone.
router.get('/product-sales', rbac('reports', 'view'), reportController.getProductSales);

router.get('/:type/export/:format', rbac('reports', 'view'), reportController.exportReport);

module.exports = router;

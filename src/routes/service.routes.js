const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/service.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const moduleGuard = require('../middleware/moduleGuard.middleware');
const { validate } = require('../middleware/validate.middleware');
const serviceValidation = require('../validations/service.validation');

// All routes require authentication and the 'services' module to be enabled
router.use(protect);
router.use(moduleGuard('services'));

// Service routes
router.get('/', rbac('services', 'view'), serviceController.getServices);
router.get('/billing', rbac('services', 'view'), serviceController.getServicesForBilling);
router.post('/', rbac('services', 'create'), validate(serviceValidation.createService), serviceController.createService);
router.get('/:id', rbac('services', 'view'), serviceController.getService);
router.put('/:id', rbac('services', 'update'), validate(serviceValidation.updateService), serviceController.updateService);
router.delete('/:id', rbac('services', 'delete'), serviceController.deleteService);
router.patch('/:id/status', rbac('services', 'update'), serviceController.toggleStatus);

module.exports = router;

const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const moduleGuard = require('../middleware/moduleGuard.middleware');
const { validate } = require('../middleware/validate.middleware');
const appointmentValidation = require('../validations/appointment.validation');

// All routes require authentication and the 'appointments' module to be enabled
router.use(protect);
router.use(moduleGuard('appointments'));

// Appointment routes
router.get('/', rbac('appointments', 'view'), appointmentController.getAppointments);
router.get('/today-summary', rbac('appointments', 'view'), appointmentController.getTodaySummary);
router.get('/provider/:providerId/schedule', rbac('appointments', 'view'), appointmentController.getProviderSchedule);
router.post('/', rbac('appointments', 'create'), validate(appointmentValidation.createAppointment), appointmentController.createAppointment);
router.get('/:id', rbac('appointments', 'view'), appointmentController.getAppointment);
router.put('/:id', rbac('appointments', 'update'), validate(appointmentValidation.updateAppointment), appointmentController.updateAppointment);
router.patch('/:id/status', rbac('appointments', 'update'), validate(appointmentValidation.updateStatus), appointmentController.updateStatus);
router.delete('/:id', rbac('appointments', 'delete'), appointmentController.deleteAppointment);
router.patch('/:id/link-sale', rbac('appointments', 'update'), appointmentController.linkSale);
router.get('/dashboard-summary', rbac('appointments', 'view'), appointmentController.getDashboardSummary);

module.exports = router;

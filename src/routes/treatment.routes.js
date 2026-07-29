const express = require('express');
const router = express.Router();
const treatmentController = require('../controllers/treatment.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const moduleGuard = require('../middleware/moduleGuard.middleware');
const { validate } = require('../middleware/validate.middleware');
const treatmentValidation = require('../validations/treatment.validation');

router.use(protect);
router.use(moduleGuard('treatments'));

// Treatment CRUD
router.get('/', rbac('treatments', 'view'), treatmentController.getTreatments);
router.post('/', rbac('treatments', 'create'), validate(treatmentValidation.createTreatment), treatmentController.createTreatment);
router.get('/customer/:customerId', rbac('treatments', 'view'), treatmentController.getCustomerTreatments);
router.get('/:id', rbac('treatments', 'view'), treatmentController.getTreatment);
router.put('/:id', rbac('treatments', 'update'), validate(treatmentValidation.updateTreatment), treatmentController.updateTreatment);
router.delete('/:id', rbac('treatments', 'delete'), treatmentController.deleteTreatment);

// Session management (nested under treatment)
router.post('/:id/sessions', rbac('treatments', 'create'), validate(treatmentValidation.addSession), treatmentController.addSession);
router.put('/:id/sessions/:sessionId', rbac('treatments', 'update'), validate(treatmentValidation.updateSession), treatmentController.updateSession);

module.exports = router;

const express = require('express');
const router = express.Router();
const equipmentController = require('../controllers/equipment.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const moduleGuard = require('../middleware/moduleGuard.middleware');
const { validate } = require('../middleware/validate.middleware');
const equipmentValidation = require('../validations/equipment.validation');

router.use(protect);
router.use(moduleGuard('equipment'));

// Equipment CRUD
router.get('/', rbac('equipment', 'view'), equipmentController.getEquipment);
router.get('/active', rbac('equipment', 'view'), equipmentController.getActiveEquipment);
router.post('/', rbac('equipment', 'create'), validate(equipmentValidation.createEquipment), equipmentController.create);
router.get('/:id', rbac('equipment', 'view'), equipmentController.getOne);
router.put('/:id', rbac('equipment', 'update'), validate(equipmentValidation.updateEquipment), equipmentController.update);
router.delete('/:id', rbac('equipment', 'delete'), equipmentController.remove);

module.exports = router;

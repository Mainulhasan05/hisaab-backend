const express = require('express');
const router = express.Router();
const roleController = require('../controllers/role.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const roleValidation = require('../validations/role.validation');

router.use(protect);

// Read — staff.view permission
router.get('/', rbac('staff', 'view'), roleController.getRoles);
router.get('/presets', rbac('staff', 'view'), roleController.getPresets);
router.get('/matrix', rbac('staff', 'view'), roleController.getMatrix);
router.get('/:id', rbac('staff', 'view'), roleController.getRole);

// Mutations — owner only
router.post('/', ownerOnly, validate(roleValidation.createRole), roleController.createRole);
router.put('/:id', ownerOnly, validate(roleValidation.updateRole), roleController.updateRole);
router.delete('/:id', ownerOnly, roleController.deleteRole);

module.exports = router;

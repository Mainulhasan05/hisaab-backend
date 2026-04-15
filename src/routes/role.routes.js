const express = require('express');
const router = express.Router();
const roleController = require('../controllers/role.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');

router.use(protect);

// Read — staff.view permission
router.get('/', rbac('staff', 'view'), roleController.getRoles);
router.get('/presets', rbac('staff', 'view'), roleController.getPresets);
router.get('/:id', rbac('staff', 'view'), roleController.getRole);

// Mutations — owner only
router.post('/', ownerOnly, roleController.createRole);
router.put('/:id', ownerOnly, roleController.updateRole);
router.delete('/:id', ownerOnly, roleController.deleteRole);

module.exports = router;

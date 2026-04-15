const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');

router.use(protect);

// Read — staff.view permission
router.get('/', rbac('staff', 'view'), staffController.getStaff);
router.get('/:id', rbac('staff', 'view'), staffController.getStaffMember);

// Mutations — owner only
router.post('/', ownerOnly, staffController.createStaff);
router.put('/:id', ownerOnly, staffController.updateStaff);
router.delete('/:id', ownerOnly, staffController.deactivateStaff);

module.exports = router;

const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac, ownerOnly } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const staffValidation = require('../validations/staff.validation');

router.use(protect);

// Read — staff.view permission
router.get('/', rbac('staff', 'view'), staffController.getStaff);
router.get('/:id', rbac('staff', 'view'), staffController.getStaffMember);

// Mutations — owner only (staff able to edit staff could escalate privileges)
router.post('/', ownerOnly, validate(staffValidation.createStaff), staffController.createStaff);
router.put('/:id', ownerOnly, validate(staffValidation.updateStaff), staffController.updateStaff);
router.delete('/:id', ownerOnly, staffController.deactivateStaff);

module.exports = router;

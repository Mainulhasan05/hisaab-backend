const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { protect } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload.middleware');

router.use(protect);

router.put('/profile/avatar', upload.single('avatar'), userController.updateAvatar);
router.patch('/profile/avatar', upload.single('avatar'), userController.updateAvatar);

module.exports = router;

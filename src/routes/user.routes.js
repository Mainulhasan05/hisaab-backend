const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { protect } = require('../middleware/auth.middleware');
const { upload, handleUploadError } = require('../middleware/upload.middleware');

router.use(protect);

// `protect` only — every signed-in user, owner and staff alike, may set their
// own picture. The controller writes to `req.user`, so this cannot touch
// anyone else's profile.
//
// `handleUploadError` sits between multer and the controller so a wrong field
// name or oversized file answers 400 with a usable message instead of the bare
// 500 "Unexpected field" this route used to return.
router.put('/profile/avatar', upload.single('avatar'), handleUploadError, userController.updateAvatar);
router.patch('/profile/avatar', upload.single('avatar'), handleUploadError, userController.updateAvatar);

module.exports = router;

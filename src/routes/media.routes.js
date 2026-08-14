const express = require('express');
const router = express.Router();
const mediaController = require('../controllers/media.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbacAny } = require('../middleware/permission.middleware');
const { upload, handleUploadError } = require('../middleware/upload.middleware');
const { requireAnyFeature } = require('../utils/features.util');

router.use(protect);

/**
 * The endpoint exists only for shops that can actually put a photo somewhere.
 * Either capability opens it — they are independent axes, and a shop given only
 * `categoryImages` still needs to upload. 404 rather than 403, per
 * `requireAnyFeature`: a capability the shop does not have should not be
 * advertised by its own error message.
 */
router.use(requireAnyFeature(['productImages', 'categoryImages']));

/**
 * Upload is gated on being able to EDIT one of the things a photo can go on.
 *
 * `rbacAny` rather than a single pair for the same reason as the feature guard
 * above: whoever maintains the category list may not be the person who edits
 * products. A view-only cashier gets a 403 and cannot spend the shop's quota.
 *
 * `handleUploadError` sits between multer and the controller so an oversized
 * file or a wrong field name is a 400 that names the problem, rather than the
 * bare 500 multer produces on its own.
 */
router.post(
  '/',
  rbacAny([['products', 'update'], ['products', 'create'], ['categories', 'update'], ['categories', 'create']]),
  upload.single('image'),
  handleUploadError,
  mediaController.uploadMedia
);

module.exports = router;

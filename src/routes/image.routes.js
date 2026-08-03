const express = require('express');

const imageController = require('../controllers/image.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbacAny } = require('../middleware/permission.middleware');
const { handleUploadError, imageUpload } = require('../middleware/upload.middleware');

const router = express.Router();

router.use(protect);

// Uploads are used for product images and shop branding — require a
// permission that implies content editing (owner always bypasses).
const canUpload = rbacAny([
  ['products', 'create'],
  ['products', 'update'],
  ['settings', 'update'],
]);

router.get('/config', imageController.getConfig);
router.post(
  '/upload',
  canUpload,
  imageUpload.single('image'),
  handleUploadError,
  imageController.uploadSingle
);
router.post(
  '/upload/multiple',
  canUpload,
  imageUpload.array('images', Number(process.env.IMAGE_UPLOAD_MAX_FILES) || 10),
  handleUploadError,
  imageController.uploadMultiple
);
router.post('/base64', canUpload, imageController.uploadBase64);
router.post('/url', canUpload, imageController.uploadUrl);

module.exports = router;

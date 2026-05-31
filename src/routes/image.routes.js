const express = require('express');

const imageController = require('../controllers/image.controller');
const { protect } = require('../middleware/auth.middleware');
const { handleUploadError, imageUpload } = require('../middleware/upload.middleware');

const router = express.Router();

router.use(protect);

router.get('/config', imageController.getConfig);
router.post(
  '/upload',
  imageUpload.single('image'),
  handleUploadError,
  imageController.uploadSingle
);
router.post(
  '/upload/multiple',
  imageUpload.array('images', Number(process.env.IMAGE_UPLOAD_MAX_FILES) || 10),
  handleUploadError,
  imageController.uploadMultiple
);
router.post('/base64', imageController.uploadBase64);
router.post('/url', imageController.uploadUrl);

module.exports = router;

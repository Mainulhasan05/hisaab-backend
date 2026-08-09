const express = require('express');
const router = express.Router();
const imageUploadController = require('../controllers/imageUpload.controller');
const { protect } = require('../middleware/auth.middleware');
const { upload, handleUploadError } = require('../middleware/upload.middleware');

router.use(protect);

router.get('/status', imageUploadController.getUploadStatus);
// Same treatment as the avatar route — multer errors become 400s that name the
// problem rather than 500s that do not.
router.post('/image', upload.single('image'), handleUploadError, imageUploadController.uploadSingleImage);
router.post('/image/base64', imageUploadController.uploadBase64Image);
router.post('/image/url', imageUploadController.uploadUrlImage);

module.exports = router;

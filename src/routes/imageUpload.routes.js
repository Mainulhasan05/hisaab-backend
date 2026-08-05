const express = require('express');
const router = express.Router();
const imageUploadController = require('../controllers/imageUpload.controller');
const { protect } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload.middleware');

router.use(protect);

router.get('/status', imageUploadController.getUploadStatus);
router.post('/image', upload.single('image'), imageUploadController.uploadSingleImage);
router.post('/image/base64', imageUploadController.uploadBase64Image);
router.post('/image/url', imageUploadController.uploadUrlImage);

module.exports = router;

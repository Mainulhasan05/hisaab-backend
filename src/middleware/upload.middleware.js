const multer = require('multer');

const imageService = require('../services/image.service');
const { AppError } = require('./error.middleware');

const storage = multer.memoryStorage();

const imageFileFilter = (req, file, callback) => {
  try {
    imageService.validateImage(file);
    callback(null, true);
  } catch (error) {
    callback(error);
  }
};

const imageUpload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: imageService.getMaxSize(),
    files: Number(process.env.IMAGE_UPLOAD_MAX_FILES) || 10,
  },
});

const handleUploadError = (err, req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image file is too large'
      : err.message;

    return next(new AppError(message, 'ইমেজ ফাইল আপলোড করা যায়নি', 400));
  }

  return next(err);
};

module.exports = {
  imageUpload,
  handleUploadError,
};

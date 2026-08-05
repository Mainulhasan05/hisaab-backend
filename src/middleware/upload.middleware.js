const multer = require('multer');
const { AppError } = require('./error.middleware');

// Memory storage for high-performance direct buffer processing
const storage = multer.memoryStorage();

// Max file size: 20MB limit (or configurable via process.env)
const maxSizeBytes = parseInt(process.env.IMAGE_UPLOAD_MAX_SIZE, 10) || 20 * 1024 * 1024; // 20MB

// Allowed MIME types
const allowedMimeTypes = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Invalid file type '${file.mimetype}'. Only images (JPEG, PNG, GIF, WebP, BMP) are allowed.`,
        `অবৈধ ফাইল টাইপ '${file.mimetype}'। শুধুমাত্র ছবি (JPEG, PNG, GIF, WebP, BMP) আপলোড করা যাবে।`,
        400
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: maxSizeBytes,
  },
  fileFilter,
});

module.exports = {
  upload,
  maxSizeBytes,
  allowedMimeTypes,
};

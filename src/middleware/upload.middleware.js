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

/**
 * Turn multer's errors into ones a caller can act on.
 *
 * A `MulterError` is a client mistake — wrong field name, file too big, too
 * many files — but it reaches Express as a plain error, so without this it
 * surfaces as a bare 500 whose only clue is a two-word message. That is exactly
 * how an avatar upload reported `500 "Unexpected field"`: nothing in the
 * response said which field was unexpected or which one was wanted.
 *
 * `LIMIT_UNEXPECTED_FILE` carries the offending field in `err.field`, so the
 * message can name both sides of the mismatch.
 */
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(maxSizeBytes / (1024 * 1024));
      return next(new AppError(
        `File is larger than the ${mb}MB limit`,
        `ফাইলের সাইজ ${mb}MB এর বেশি হতে পারবে না`,
        400
      ));
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError(
        `Unexpected file field '${err.field}'. Send the file under the field name this endpoint expects.`,
        `'${err.field}' নামে ফাইল পাঠানো যাবে না — সঠিক ফিল্ড নাম ব্যবহার করুন।`,
        400
      ));
    }

    return next(new AppError(err.message, err.message, 400));
  }
  next(err);
};

module.exports = {
  upload,
  imageUpload: upload,
  handleUploadError,
  maxSizeBytes,
  allowedMimeTypes,
};


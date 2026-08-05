const imageUploadService = require('../services/imageUpload.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');
const { maxSizeBytes, allowedMimeTypes } = require('../middleware/upload.middleware');

/**
 * @desc    Get ImgBB service status & upload limits
 * @route   GET /api/upload/status
 * @access  Protected
 */
exports.getUploadStatus = asyncHandler(async (req, res) => {
  const configured = imageUploadService.isConfigured();

  return ApiResponse.success(res, {
    data: {
      isConfigured: configured,
      provider: 'ImgBB',
      maxFileSizeMB: Math.round(maxSizeBytes / (1024 * 1024)),
      maxSizeBytes,
      allowedMimeTypes,
    },
    message: configured
      ? 'Image upload service is active and operational'
      : 'Image upload service is currently unconfigured',
    messageBn: configured
      ? 'ইমেজ আপলোড সার্ভিস চালু আছে'
      : 'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
  });
});

/**
 * @desc    Upload single image via Multer
 * @route   POST /api/upload/image
 * @access  Protected
 */
exports.uploadSingleImage = asyncHandler(async (req, res) => {
  if (!imageUploadService.isConfigured()) {
    throw new AppError(
      'Image upload service is not configured on this server.',
      'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
      503
    );
  }

  if (!req.file) {
    throw new AppError('Please select an image file to upload.', 'একটি ছবি নির্বাচন করুন', 400);
  }

  const result = await imageUploadService.uploadFromMulter(req.file);

  return ApiResponse.success(res, {
    data: result,
    message: 'Image uploaded successfully',
    messageBn: 'ছবি সফলভাবে আপলোড হয়েছে',
  });
});

/**
 * @desc    Upload image via Base64 string payload
 * @route   POST /api/upload/image/base64
 * @access  Protected
 */
exports.uploadBase64Image = asyncHandler(async (req, res) => {
  if (!imageUploadService.isConfigured()) {
    throw new AppError(
      'Image upload service is not configured on this server.',
      'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
      503
    );
  }

  const { image, filename } = req.body;
  if (!image) {
    throw new AppError('Please provide a Base64 image payload in the "image" field.', 'বেস৬৪ ইমেজ ডাটা দিন', 400);
  }

  const result = await imageUploadService.uploadFromBase64(image, filename);

  return ApiResponse.success(res, {
    data: result,
    message: 'Base64 image uploaded successfully',
    messageBn: 'ছবি সফলভাবে আপলোড হয়েছে',
  });
});

/**
 * @desc    Upload image from remote URL
 * @route   POST /api/upload/image/url
 * @access  Protected
 */
exports.uploadUrlImage = asyncHandler(async (req, res) => {
  if (!imageUploadService.isConfigured()) {
    throw new AppError(
      'Image upload service is not configured on this server.',
      'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
      503
    );
  }

  const { url, filename } = req.body;
  if (!url) {
    throw new AppError('Please provide a remote image URL in the "url" field.', 'ইমেজ ইউআরএল দিন', 400);
  }

  const result = await imageUploadService.uploadFromUrl(url, { filename });

  return ApiResponse.success(res, {
    data: result,
    message: 'Remote image uploaded successfully',
    messageBn: 'ছবি সফলভাবে আপলোড হয়েছে',
  });
});

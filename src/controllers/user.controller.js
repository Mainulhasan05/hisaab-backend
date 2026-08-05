const User = require('../models/User.model');
const imageUploadService = require('../services/imageUpload.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');

/**
 * @desc    Upload or update user profile avatar
 * @route   PUT /api/users/profile/avatar (or PUT /api/auth/profile/avatar)
 * @access  Private
 */
exports.updateAvatar = asyncHandler(async (req, res) => {
  let uploadResult;

  if (req.file) {
    // Single file upload via Multer
    uploadResult = await imageUploadService.uploadFromMulter(req.file);
  } else if (req.body.avatarBase64 || req.body.image) {
    // Base64 string payload
    const base64Str = req.body.avatarBase64 || req.body.image;
    uploadResult = await imageUploadService.uploadFromBase64(base64Str, `avatar-${req.user._id}.png`);
  } else if (req.body.avatarUrl || req.body.url) {
    // Remote URL
    const url = req.body.avatarUrl || req.body.url;
    uploadResult = await imageUploadService.uploadFromUrl(url, { filename: `avatar-${req.user._id}.png` });
  } else {
    throw new AppError('Please provide an image file, base64 payload, or image URL', 'অবৈধ বা অনুপস্থিত অবতার ইমেজ ডাটা', 400);
  }

  const avatarUrl = uploadResult.url;
  const avatarThumbnail = uploadResult.thumbnail;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    {
      $set: {
        avatar: avatarUrl,
        avatarUrl,
        avatarThumbnail,
      },
    },
    { new: true, runValidators: true }
  ).select('-password');

  return ApiResponse.success(res, {
    data: {
      user,
      avatarUrl,
      avatarThumbnail,
      upload: uploadResult,
    },
    message: 'Profile avatar updated successfully',
    messageBn: 'প্রোফাইল ছবি সফলভাবে আপডেট হয়েছে',
  });
});

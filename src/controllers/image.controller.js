const imageService = require('../services/image.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');

exports.getConfig = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, {
    data: imageService.getUploadConfig(),
    message: 'Image upload configuration retrieved successfully',
    messageBn: 'ইমেজ আপলোড কনফিগারেশন পাওয়া গেছে',
  });
});

exports.uploadSingle = asyncHandler(async (req, res) => {
  const image = await imageService.uploadFromMulter(req.file, {
    expiration: req.body.expiration,
  });

  return ApiResponse.created(res, {
    data: image,
    message: 'Image uploaded successfully',
    messageBn: 'ইমেজ সফলভাবে আপলোড হয়েছে',
  });
});

exports.uploadMultiple = asyncHandler(async (req, res) => {
  const images = await imageService.uploadManyFromMulter(req.files, {
    expiration: req.body.expiration,
  });

  return ApiResponse.created(res, {
    data: images,
    message: 'Images uploaded successfully',
    messageBn: 'ইমেজগুলো সফলভাবে আপলোড হয়েছে',
  });
});

exports.uploadBase64 = asyncHandler(async (req, res) => {
  const { image, filename, expiration, mimeType } = req.body;
  const uploadedImage = await imageService.uploadFromBase64(image, filename, {
    expiration,
    mimeType,
  });

  return ApiResponse.created(res, {
    data: uploadedImage,
    message: 'Image uploaded successfully',
    messageBn: 'ইমেজ সফলভাবে আপলোড হয়েছে',
  });
});

exports.uploadUrl = asyncHandler(async (req, res) => {
  const { imageUrl, expiration } = req.body;
  const image = await imageService.uploadFromUrl(imageUrl, { expiration });

  return ApiResponse.created(res, {
    data: image,
    message: 'Image uploaded successfully',
    messageBn: 'ইমেজ সফলভাবে আপলোড হয়েছে',
  });
});

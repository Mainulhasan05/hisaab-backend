const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');
const mediaService = require('../services/media.service');
const Shop = require('../models/Shop.model');
const { AppError } = require('../middleware/error.middleware');
const { storageState, platformStorageSettings } = require('../utils/storageQuota.util');

/**
 * Upload one image into the shop's storage.
 *
 * Staged, not attached. The response carries a `mediaId` the form holds until
 * the user saves the product or category — that save is what makes the image
 * referenced (see `media.service.reconcileRefs`). An upload the user abandons
 * is swept 48 hours later, which is why this endpoint can afford to do nothing
 * clever about cancellation.
 *
 * One file per request on purpose. The client compresses and uploads images one
 * at a time (P2): three parallel uploads from a cheap Android phone means three
 * simultaneous canvas encodes, and that is how the tab dies.
 */
exports.uploadMedia = asyncHandler(async (req, res) => {
  if (!(await mediaService.isReady())) {
    throw new AppError(
      'Image storage is not configured on this server',
      'সার্ভারে ছবি সংরক্ষণ সুবিধা এখনো প্রস্তুত নয়',
      503
    );
  }

  const file = req.file || (Array.isArray(req.files) ? req.files[0] : null);
  if (!file) {
    throw new AppError(
      'Please attach an image under the field name "image"',
      'একটি ছবি নির্বাচন করুন',
      400
    );
  }

  const { media, deduped } = await mediaService.uploadImage(req.shop, file, {
    userId: req.user?._id || null,
  });

  // The shop's position AFTER this upload, so the picker can show "৪২MB / ১০০MB"
  // without a second round trip — and so a shop that just crossed the warning
  // threshold learns about it here rather than on the next failed upload.
  // Re-read rather than reusing `req.shop`: that one came from the auth cache
  // and still holds the usage figure from before this upload, which is the one
  // number on this response the caller is most likely to act on.
  const settings = await platformStorageSettings();
  const shop = await Shop.findById(req.shop._id).select('storage').lean();

  return ApiResponse.success(res, {
    statusCode: deduped ? 200 : 201,
    data: {
      media: media.toClientJSON(),
      // True when the bytes were already ours — the client may want to say
      // "এই ছবিটি আগেই আপলোড করা আছে" instead of showing a fresh upload.
      deduped,
      storage: storageState(shop, settings),
    },
    message: deduped ? 'Image already stored' : 'Image uploaded',
    messageBn: deduped ? 'ছবিটি আগে থেকেই সংরক্ষিত আছে' : 'ছবি আপলোড হয়েছে',
  });
});

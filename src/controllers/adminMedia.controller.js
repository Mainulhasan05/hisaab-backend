/**
 * Admin media library endpoints — thin wrappers, same shape as
 * `adminStorage.controller`. All policy lives in the services; nothing here
 * decides anything.
 *
 * Every route in this file is mounted behind `protect, adminOnly`
 * (MEDIA_GALLERY_PLAN.md I-20). There is no shop-facing counterpart, and adding
 * one is a product decision, not a routing change.
 */

const asyncHandler = require('../utils/asyncHandler.util');
const ApiResponse = require('../utils/response.util');
const platformMediaService = require('../services/platformMedia.service');
const mediaFolderService = require('../services/mediaFolder.service');
const { AppError } = require('../middleware/error.middleware');

// ── Files ───────────────────────────────────────────────────────────────────

exports.list = asyncHandler(async (req, res) => {
  const { folder, kind, search, tag, page, limit } = req.query;

  const result = await platformMediaService.list({
    // Three distinct states, and they must stay distinct: absent = no filter,
    // 'root' = files in no folder, an id = that folder. Collapsing the first two
    // hides unfiled files behind a filter nobody thinks to clear.
    folder: folder === undefined ? undefined : (folder === 'root' || folder === '' ? null : folder),
    kind: kind || null,
    search: search || null,
    tag: tag || null,
    page,
    limit,
  });

  return ApiResponse.success(res, {
    data: {
      items: result.items.map((m) => m.toClientJSON()),
      total: result.total,
      page: result.page,
      limit: result.limit,
    },
    message: 'Media retrieved successfully',
  });
});

exports.usage = asyncHandler(async (req, res) => {
  const [usage, videoServable] = await Promise.all([
    platformMediaService.usage(),
    platformMediaService.isVideoServable(),
  ]);

  return ApiResponse.success(res, {
    data: {
      ...usage,
      // The gate from MEDIA_GALLERY_PLAN.md §6.4, reported so the UI can explain
      // why video is unavailable instead of simply not offering it.
      videoServable,
      consumers: platformMediaService.consumers(),
    },
    message: 'Library usage retrieved successfully',
  });
});

exports.upload = asyncHandler(async (req, res) => {
  if (!(await platformMediaService.isReady())) {
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

  const { media, deduped } = await platformMediaService.uploadImage(file, {
    folder: req.body?.folder || null,
    title: req.body?.title || null,
    altText: req.body?.altText || null,
    tags: parseTags(req.body?.tags),
    adminId: req.admin?._id || null,
  });

  // The library's position AFTER this upload, so the picker can show the meter
  // without a second round trip.
  const usage = await platformMediaService.usage();

  return ApiResponse.success(res, {
    statusCode: deduped ? 200 : 201,
    data: { media: media.toClientJSON(), deduped, usage },
    message: deduped ? 'File already stored' : 'File uploaded',
    messageBn: deduped ? 'ফাইলটি আগে থেকেই সংরক্ষিত আছে' : 'ফাইল আপলোড হয়েছে',
  });
});

exports.detail = asyncHandler(async (req, res) => {
  const media = await platformMediaService.getById(req.params.id);
  // Resolved through each consumer's own callback — this is the "যেখানে
  // ব্যবহৃত" list, and the reason `refs` exists rather than a bare counter.
  const usedBy = await platformMediaService.describeRefs([media]);

  return ApiResponse.success(res, {
    data: { media: media.toClientJSON(), usedBy },
    message: 'Media retrieved successfully',
  });
});

exports.update = asyncHandler(async (req, res) => {
  const media = await platformMediaService.update(req.params.id, {
    title: req.body?.title,
    altText: req.body?.altText,
    tags: req.body?.tags === undefined ? undefined : parseTags(req.body.tags),
    folder: req.body?.folder === undefined
      ? undefined
      : (req.body.folder === 'root' || req.body.folder === '' ? null : req.body.folder),
  });

  return ApiResponse.success(res, {
    data: media.toClientJSON(),
    message: 'Media updated successfully',
    messageBn: 'ফাইল আপডেট হয়েছে',
  });
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await platformMediaService.remove(req.params.id);

  return ApiResponse.success(res, {
    data: result,
    message: 'File marked for reclamation',
    // Deliberately not "deleted": the bytes go after the grace period, and
    // telling an admin it is gone when it is recoverable costs us the one
    // window in which a mistake can be undone.
    messageBn: 'ফাইলটি সরানো হয়েছে — গ্রেস পিরিয়ড শেষে মুছে যাবে',
  });
});

// ── Folders ─────────────────────────────────────────────────────────────────

exports.listFolders = asyncHandler(async (req, res) => {
  const tree = await mediaFolderService.listWithUsage();

  return ApiResponse.success(res, {
    data: tree,
    message: 'Folders retrieved successfully',
  });
});

exports.createFolder = asyncHandler(async (req, res) => {
  const folder = await mediaFolderService.create(
    {
      name: req.body?.name,
      slug: req.body?.slug || null,
      parent: req.body?.parent || null,
      description: req.body?.description || '',
    },
    req.admin?._id || null
  );

  return ApiResponse.created(res, {
    data: folder.toClientJSON(),
    message: 'Folder created successfully',
    messageBn: 'ফোল্ডার তৈরি হয়েছে',
  });
});

exports.updateFolder = asyncHandler(async (req, res) => {
  const folder = await mediaFolderService.rename(
    req.params.id,
    { name: req.body?.name, description: req.body?.description },
    req.admin?._id || null
  );

  return ApiResponse.success(res, {
    data: folder.toClientJSON(),
    message: 'Folder updated successfully',
    messageBn: 'ফোল্ডার আপডেট হয়েছে',
  });
});

exports.moveFolder = asyncHandler(async (req, res) => {
  const parent = req.body?.parent === 'root' || req.body?.parent === '' ? null : req.body?.parent;
  const folder = await mediaFolderService.move(req.params.id, parent || null, req.admin?._id || null);

  return ApiResponse.success(res, {
    data: folder.toClientJSON(),
    message: 'Folder moved successfully',
    messageBn: 'ফোল্ডার সরানো হয়েছে',
  });
});

exports.removeFolder = asyncHandler(async (req, res) => {
  // `describeRefs` is injected rather than imported by the folder service, so
  // that service keeps knowing nothing about the consumer registry.
  const result = await mediaFolderService.remove(req.params.id, {
    describeRefs: (docs) => platformMediaService.describeRefs(docs),
  });

  return ApiResponse.success(res, {
    data: result,
    message: 'Folder deleted successfully',
    messageBn: 'ফোল্ডার মুছে ফেলা হয়েছে — ভিতরের ফাইলগুলো উপরের ফোল্ডারে সরানো হয়েছে',
  });
});

// ── Maintenance ─────────────────────────────────────────────────────────────

/**
 * Repair the derived numbers.
 *
 * Both counters here are incremental so that the upload gate can be atomic, and
 * anything incremental drifts. Exposed as a button rather than left to a job so
 * an admin looking at a figure they do not believe can settle it immediately.
 */
exports.recalculate = asyncHandler(async (req, res) => {
  const [usage, paths] = await Promise.all([
    platformMediaService.recalculateUsage(),
    mediaFolderService.rebuildPaths(),
  ]);

  return ApiResponse.success(res, {
    data: { usage, paths },
    message: 'Library figures recalculated',
    messageBn: 'গ্যালারির হিসাব ঠিক করা হয়েছে',
  });
});

/** Tags arrive as JSON from fetch and as a comma string from a multipart form. */
function parseTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      // Fall through to comma splitting — a malformed JSON tag list is a
      // client bug, not a reason to refuse the upload it came with.
    }
  }
  return str.split(',');
}

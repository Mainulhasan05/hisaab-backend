const PageContent = require('../models/PageContent.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');
const { refuseDeletion } = require('../utils/deletionDisabled.util');

// Get page by slug (public)
exports.getPageBySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;

  const page = await PageContent.getBySlug(slug);

  if (!page) {
    throw new AppError('পেজ পাওয়া যায়নি', 'Page not found', 404);
  }

  return ApiResponse.success(res, {
    data: page,
    message: 'Page retrieved successfully',
    messageBn: 'পেজ লোড হয়েছে',
  });
});

// Get all pages (admin only)
exports.getAllPages = asyncHandler(async (req, res) => {
  const pages = await PageContent.find()
    .select('slug title titleBn isActive updatedAt lastUpdatedBy')
    .populate('lastUpdatedBy', 'name')
    .sort({ slug: 1 })
    .lean();

  return ApiResponse.success(res, {
    data: pages,
    message: 'Pages retrieved successfully',
    messageBn: 'পেজ তালিকা লোড হয়েছে',
  });
});

// Get single page for editing (admin only)
exports.getPageForEdit = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const page = await PageContent.findById(id)
    .populate('lastUpdatedBy', 'name');

  if (!page) {
    throw new AppError('পেজ পাওয়া যায়নি', 'Page not found', 404);
  }

  return ApiResponse.success(res, {
    data: page,
    message: 'Page retrieved successfully',
    messageBn: 'পেজ লোড হয়েছে',
  });
});

// Update page content (admin only)
exports.updatePage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, titleBn, content, contentBn, metaDescription, metaDescriptionBn, isActive } = req.body;

  const page = await PageContent.findById(id);

  if (!page) {
    throw new AppError('পেজ পাওয়া যায়নি', 'Page not found', 404);
  }

  // Update fields
  if (title !== undefined) page.title = title;
  if (titleBn !== undefined) page.titleBn = titleBn;
  if (content !== undefined) page.content = content;
  if (contentBn !== undefined) page.contentBn = contentBn;
  if (metaDescription !== undefined) page.metaDescription = metaDescription;
  if (metaDescriptionBn !== undefined) page.metaDescriptionBn = metaDescriptionBn;
  if (isActive !== undefined) page.isActive = isActive;

  page.lastUpdatedBy = req.admin._id;

  await page.save();

  return ApiResponse.success(res, {
    data: page,
    message: 'Page updated successfully',
    messageBn: 'পেজ আপডেট হয়েছে',
  });
});

// Create new page (admin only)
exports.createPage = asyncHandler(async (req, res) => {
  const { slug, title, titleBn, content, contentBn, metaDescription, metaDescriptionBn } = req.body;

  // Check if slug already exists
  const existingPage = await PageContent.findOne({ slug: slug.toLowerCase() });
  if (existingPage) {
    throw new AppError('এই স্লাগ দিয়ে পেজ আছে', 'Page with this slug already exists', 400);
  }

  const page = await PageContent.create({
    slug: slug.toLowerCase(),
    title,
    titleBn,
    content,
    contentBn,
    metaDescription,
    metaDescriptionBn,
    lastUpdatedBy: req.admin._id,
  });

  return ApiResponse.success(res, {
    data: page,
    message: 'Page created successfully',
    messageBn: 'পেজ তৈরি হয়েছে',
    statusCode: 201,
  });
});

// Delete page — DISABLED. Route is not mounted; this fails closed if it ever is.
exports.deletePage = asyncHandler(async () => {
  refuseDeletion(
    'a page',
    'Unpublish it instead: PATCH /api/pages/:id with { isActive: false }.'
  );
});

// Seed default pages (admin only)
exports.seedDefaultPages = asyncHandler(async (req, res) => {
  await PageContent.seedDefaults();

  return ApiResponse.success(res, {
    message: 'Default pages seeded successfully',
    messageBn: 'ডিফল্ট পেজ তৈরি হয়েছে',
  });
});

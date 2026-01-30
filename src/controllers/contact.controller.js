const Contact = require('../models/Contact.model');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { AppError } = require('../middleware/error.middleware');

// Rate limit config
const RATE_LIMIT_MAX = 2; // Max submissions
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour in milliseconds

// Submit contact form (public)
exports.submitContact = asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  // Get client IP
  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';

  // Rate limiting - check submissions from this IP in the last hour
  const oneHourAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentSubmissions = await Contact.countDocuments({
    ipAddress: clientIp,
    createdAt: { $gte: oneHourAgo }
  });

  if (recentSubmissions >= RATE_LIMIT_MAX) {
    const remainingTime = Math.ceil((RATE_LIMIT_WINDOW_MS - (Date.now() - oneHourAgo.getTime())) / 60000);
    throw new AppError(
      `আপনি ইতিমধ্যে ${RATE_LIMIT_MAX}টি বার্তা পাঠিয়েছেন। অনুগ্রহ করে ${remainingTime} মিনিট পর আবার চেষ্টা করুন।`,
      `You have already sent ${RATE_LIMIT_MAX} messages. Please try again in ${remainingTime} minutes.`,
      429
    );
  }

  // Validation
  if (!name || !subject || !message) {
    throw new AppError('নাম, বিষয় ও বার্তা আবশ্যক', 'Name, subject, and message are required', 400);
  }

  if (!email && !phone) {
    throw new AppError('ইমেইল বা ফোন নম্বর অন্তত একটি দিন', 'Email or phone is required', 400);
  }

  // Create contact submission
  const contact = await Contact.create({
    name: name.trim(),
    email: email?.trim() || null,
    phone: phone?.trim() || null,
    subject: subject.trim(),
    message: message.trim(),
    ipAddress: clientIp,
    userAgent: req.headers['user-agent'],
  });

  // Send SMS notification to admin
  try {
    const smsService = require('../services/sms.service');
    const adminPhone = process.env.ADMIN_CONTACT_PHONE || '01757995016';

    await smsService.sendSingle({
      to: adminPhone,
      message: `হিসাব যোগাযোগ ফর্ম:\nনাম: ${name}\nবিষয়: ${subject}\nফোন: ${phone || 'N/A'}`,
    });
  } catch (smsError) {
    // Log but don't fail the request
    console.error('Failed to send contact notification SMS:', smsError.message);
  }

  return ApiResponse.success(res, {
    data: { id: contact._id },
    message: 'Your message has been sent successfully',
    messageBn: 'আপনার বার্তা সফলভাবে পাঠানো হয়েছে',
    statusCode: 201,
  });
});

// Get all contacts (admin only)
exports.getContacts = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status, search } = req.query;

  const query = {};
  if (status && status !== 'all') {
    query.status = status;
  }
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { subject: { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (page - 1) * limit;

  const [contacts, total, statusCounts] = await Promise.all([
    Contact.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    Contact.countDocuments(query),
    Contact.getStatusCounts(),
  ]);

  return ApiResponse.paginated(res, {
    data: contacts,
    page: parseInt(page),
    limit: parseInt(limit),
    total,
    statusCounts,
    message: 'Contacts retrieved successfully',
    messageBn: 'যোগাযোগ তালিকা লোড হয়েছে',
  });
});

// Get single contact (admin only)
exports.getContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findById(req.params.id)
    .populate('repliedBy', 'name');

  if (!contact) {
    throw new AppError('যোগাযোগ পাওয়া যায়নি', 'Contact not found', 404);
  }

  // Mark as read if new
  if (contact.status === 'new') {
    contact.status = 'read';
    await contact.save();
  }

  return ApiResponse.success(res, {
    data: contact,
    message: 'Contact retrieved successfully',
    messageBn: 'যোগাযোগ বিস্তারিত লোড হয়েছে',
  });
});

// Update contact status (admin only)
exports.updateContactStatus = asyncHandler(async (req, res) => {
  const { status, reply } = req.body;

  const contact = await Contact.findById(req.params.id);
  if (!contact) {
    throw new AppError('যোগাযোগ পাওয়া যায়নি', 'Contact not found', 404);
  }

  if (status) {
    contact.status = status;
  }

  if (reply) {
    contact.reply = reply;
    contact.repliedAt = new Date();
    contact.repliedBy = req.admin._id;
    contact.status = 'replied';
  }

  await contact.save();

  return ApiResponse.success(res, {
    data: contact,
    message: 'Contact updated successfully',
    messageBn: 'যোগাযোগ আপডেট হয়েছে',
  });
});

// Delete contact (admin only)
exports.deleteContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findByIdAndDelete(req.params.id);

  if (!contact) {
    throw new AppError('যোগাযোগ পাওয়া যায়নি', 'Contact not found', 404);
  }

  return ApiResponse.success(res, {
    message: 'Contact deleted successfully',
    messageBn: 'যোগাযোগ মুছে ফেলা হয়েছে',
  });
});

// Get contact stats (admin only)
exports.getContactStats = asyncHandler(async (req, res) => {
  const statusCounts = await Contact.getStatusCounts();

  // Get recent contacts
  const recentContacts = await Contact.find()
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name subject status createdAt')
    .lean();

  return ApiResponse.success(res, {
    data: {
      ...statusCounts,
      recent: recentContacts,
    },
    message: 'Contact stats retrieved successfully',
    messageBn: 'যোগাযোগ পরিসংখ্যান লোড হয়েছে',
  });
});

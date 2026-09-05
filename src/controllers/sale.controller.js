const saleService = require('../services/sale.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizeSales, sanitizeReport } = require('../utils/dataSanitizer.util');

// Get all sales
exports.getSales = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const result = await saleService.getSales(req.shop._id, options);
  result.data = sanitizeSales(result.data, req);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Sales retrieved successfully',
    messageBn: 'বিক্রয় তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single sale
exports.getSale = asyncHandler(async (req, res) => {
  const sale = await saleService.getSaleById(req.shop._id, req.params.id, req.branchId, req);
  return ApiResponse.success(res, {
    data: sanitizeSales(sale, req),
    message: 'Sale retrieved successfully',
    messageBn: 'বিক্রয় সফলভাবে লোড হয়েছে',
  });
});

// Create sale
exports.createSale = asyncHandler(async (req, res) => {
  const sale = await saleService.createSale(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.success(res, {
    data: sanitizeSales(sale, req),
    message: 'Sale created successfully',
    messageBn: 'বিক্রয় সফলভাবে সম্পন্ন হয়েছে',
    statusCode: 201,
  });
});

/**
 * Hand a parcel to a courier. The COD amount moves off the customer's খাতা and
 * onto that courier's balance — see COD_PLAN.md.
 */
exports.dispatchToCourier = asyncHandler(async (req, res) => {
  const result = await saleService.dispatchToCourier(
    req.shop._id,
    req.user._id,
    { saleId: req.params.id, account: req.body.account },
    req
  );
  return ApiResponse.success(res, {
    data: sanitizeReport(result, req),
    message: 'Parcel handed to courier',
    messageBn: 'পার্সেল কুরিয়ারে হস্তান্তর হয়েছে',
  });
});

/** The parcel came back. Release the money the courier was holding. */
exports.undispatchFromCourier = asyncHandler(async (req, res) => {
  const result = await saleService.undispatchFromCourier(
    req.shop._id,
    req.user._id,
    { saleId: req.params.id, reason: req.body.reason },
    req
  );
  return ApiResponse.success(res, {
    data: sanitizeReport(result, req),
    message: 'Parcel return recorded',
    messageBn: 'পার্সেল ফেরত রেকর্ড হয়েছে',
  });
});

// Record payment
exports.recordPayment = asyncHandler(async (req, res) => {
  const result = await saleService.recordPayment(req.shop._id, req.user._id, req.params.id, req.body, req.branchId, req);
  return ApiResponse.success(res, {
    data: sanitizeReport(result, req),
    message: 'Payment recorded successfully',
    messageBn: 'পেমেন্ট সফলভাবে রেকর্ড করা হয়েছে',
  });
});

// Revise a printed sale.
//
// The body is a full cart — the same payload `POST /sales` takes — so the
// response is the NEW live invoice, not a patch result. The client reprints
// from it: the customer is still holding the old paper.
exports.reviseSale = asyncHandler(async (req, res) => {
  const sale = await saleService.reviseSale(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: sanitizeSales(sale, req),
    message: 'Sale revised successfully',
    messageBn: 'বিক্রয় সফলভাবে সংশোধন হয়েছে',
  });
});

// Cancel sale
exports.cancelSale = asyncHandler(async (req, res) => {
  const sale = await saleService.cancelSale(req.shop._id, req.user._id, req.params.id, req.body.reason, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeSales(sale, req),
    message: 'Sale cancelled successfully',
    messageBn: 'বিক্রয় সফলভাবে বাতিল করা হয়েছে',
  });
});

// Get filtered sales summary (aggregated stats)
exports.getSalesSummary = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const summary = await saleService.getSalesSummary(req.shop._id, options);
  return ApiResponse.success(res, {
    data: sanitizeReport(summary, req),
    message: 'Sales summary retrieved successfully',
    messageBn: 'বিক্রয় সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get today's summary
exports.getTodaySummary = asyncHandler(async (req, res) => {
  const summary = await saleService.getTodaySummary(req.shop._id, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(summary, req),
    message: 'Today\'s summary retrieved successfully',
    messageBn: 'আজকের সারাংশ সফলভাবে লোড হয়েছে',
  });
});

// Get recent sales
/**
 * "Has this customer bought this before, and at what price?"
 *
 * Answers for ONE customer and ONE product, because that is the question the
 * till asks — the cashier is looking at a single cart line with a single
 * customer attached. Nothing is returned when the pair has no history; the
 * client renders that as "আগে নেননি" rather than as an error.
 *
 * No `sanitizeReport`: the service never projects `buyingPrice` in the first
 * place, so there is no cost figure in this payload to strip.
 */
exports.getCustomerProductHistory = asyncHandler(async (req, res) => {
  const result = await saleService.getCustomerProductHistory(
    req.shop._id,
    {
      customerId: req.query.customer,
      productId: req.query.product,
      variantId: req.query.variant || null,
      limit: req.query.limit,
    },
    req
  );

  return ApiResponse.success(res, {
    data: result,
    message: 'Customer purchase history retrieved',
    messageBn: 'আগের কেনাকাটার তথ্য লোড হয়েছে',
  });
});

exports.getRecentSales = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const sales = await saleService.getRecentSales(req.shop._id, limit, req.branchId);
  return ApiResponse.success(res, {
    data: sanitizeReport(sales, req),
    message: 'Recent sales retrieved successfully',
    messageBn: 'সাম্প্রতিক বিক্রয় সফলভাবে লোড হয়েছে',
  });
});

// Get payments for a sale
exports.getSalePayments = asyncHandler(async (req, res) => {
  const payments = await saleService.getSalePayments(req.shop._id, req.params.id, req.branchId);
  return ApiResponse.success(res, {
    data: payments,
    message: 'Sale payments fetched',
    messageBn: 'বিক্রয়ের পেমেন্ট সমূহ পাওয়া গেছে',
  });
});

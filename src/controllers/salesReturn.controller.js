const salesReturnService = require('../services/salesReturn.service');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const { sanitizeReport } = require('../utils/dataSanitizer.util');

// Create sales return
exports.createReturn = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.createReturn(
    req.shop._id,
    req.user._id,
    req.body,
    req
  );
  return ApiResponse.created(res, {
    data: salesReturn,
    message: 'Sales return created successfully',
    messageBn: 'মাল ফেরত সফলভাবে সম্পন্ন হয়েছে',
  });
});

// Settle a refund that was recorded as "pay later" (store_credit).
exports.settleRefund = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.settleRefund(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body,
    req
  );
  return ApiResponse.success(res, {
    data: salesReturn,
    message: 'Refund settled successfully',
    messageBn: 'ফেরতের টাকা পরিশোধ হয়েছে',
  });
});

// Get all returns (paginated)
exports.getReturns = asyncHandler(async (req, res) => {
  // Branch is assigned unconditionally, overwriting anything the query string
  // carried: spreading `req.query` first meant a client-supplied `branchId`
  // survived whenever the resolved scope was null, letting a caller slice the
  // list by a branch the scope never granted.
  const options = { ...req.query, branchId: req.branchId || null };
  const result = await salesReturnService.getReturns(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    // Every return document carries `profitReduction`. The route asks for
    // `sales.view`, so a cashier lists them — and would read off the profit
    // given back on every row. Nothing on the client consumes the field; the
    // server computes it when the return is created.
    data: sanitizeReport(result.data, req),
    message: 'Returns retrieved successfully',
    messageBn: 'ফেরত তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get single return
exports.getReturn = asyncHandler(async (req, res) => {
  const salesReturn = await salesReturnService.getReturnById(
    req.shop._id,
    req.params.id,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizeReport(salesReturn, req),
    message: 'Return retrieved successfully',
    messageBn: 'ফেরত সফলভাবে লোড হয়েছে',
  });
});

// Get returns for a specific sale
exports.getReturnsBySale = asyncHandler(async (req, res) => {
  const returns = await salesReturnService.getReturnsBySale(
    req.shop._id,
    req.params.saleId,
    req
  );
  return ApiResponse.success(res, {
    data: sanitizeReport(returns, req),
    message: 'Sale returns retrieved successfully',
    messageBn: 'বিক্রয়ের ফেরত তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Get returnable items for a sale
exports.getReturnableItems = asyncHandler(async (req, res) => {
  const result = await salesReturnService.getReturnableItems(
    req.shop._id,
    req.params.saleId,
    req
  );
  return ApiResponse.success(res, {
    // The rows carry each line's `buyingPrice` — the cost figure
    // `products.view_cost` exists to withhold, and the return modal never reads
    // it. `sanitizeReport` strips cost and profit keys independently, so a
    // cashier who may see profit but not cost (or the reverse) still gets the
    // half they are entitled to.
    data: sanitizeReport(result, req),
    message: 'Returnable items retrieved successfully',
    messageBn: 'ফেরতযোগ্য আইটেম সফলভাবে লোড হয়েছে',
  });
});

// Get returns summary
exports.getReturnsSummary = asyncHandler(async (req, res) => {
  // Only the date window is taken from the query string. `branchId` comes from
  // the resolved scope and is NOT spread in from `req.query`, so a caller
  // cannot ask for another branch's totals — and the cards always count the
  // same rows `getReturns` lists.
  const summary = await salesReturnService.getReturnsSummary(
    req.shop._id,
    {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      branchId: req.branchId || null,
    }
  );
  return ApiResponse.success(res, {
    // `totalProfitLoss` is how much profit the day's returns handed back — the
    // same confidential figure `sales.profit` is, reached by another name. The
    // route only asks for `sales.view`, which a cashier holds, so the payload
    // has to go through the same strip every report response does.
    data: sanitizeReport(summary, req),
    message: 'Returns summary retrieved successfully',
    messageBn: 'ফেরত সারাংশ সফলভাবে লোড হয়েছে',
  });
});

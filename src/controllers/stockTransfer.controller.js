const stockTransferService = require('../services/stockTransfer.service');
const asyncHandler = require('../utils/asyncHandler.util');

// Shop scope comes from req.shop, set by auth.middleware `protect`. It was
// previously read from `req.user.currentShop` — a field that exists on neither
// the User schema nor the request — so every filter below was built with
// `shop: undefined`, which Mongoose strips, leaving these queries unscoped
// across the entire platform.

exports.createTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.createTransfer(
    { ...req.body, shop: req.shop._id },
    req.user._id,
    req
  );
  res.status(201).json(result);
});

// What the destination is missing, before anything is created. Writes nothing.
exports.previewTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.previewTransfer(
    { ...req.body, shop: req.shop._id },
    req
  );
  res.json(result);
});

// What the destination is low on that this branch can spare. Owner only.
exports.getTransferSuggestions = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransferSuggestions(
    req.shop._id,
    req.query,
    req
  );
  res.json(result);
});

exports.getTransfers = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransfers(
    req.shop._id,
    req.query,
    req
  );
  res.json(result);
});

// Product-wise and line-wise detail across many transfers — the চালান register.
exports.getTransferReport = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransferReport(
    req.shop._id,
    req.query,
    req
  );
  res.json(result);
});

exports.getTransferById = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransferById(
    req.params.id,
    req.shop._id,
    req
  );
  res.json(result);
});

exports.approveTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.approveTransfer(
    req.params.id,
    req.shop._id,
    req.user._id,
    req
  );
  res.json(result);
});

exports.receiveTransfer = asyncHandler(async (req, res) => {
  const { links, createMissing, createNew } = req.body || {};
  // Only the decisions — never `skipActingBranch`, which the service accepts
  // from createTransfer's owner path alone.
  const resolve = (links || createMissing || createNew) ? { links, createMissing, createNew } : null;
  const result = await stockTransferService.receiveTransfer(
    req.params.id,
    req.shop._id,
    req.user._id,
    req.body.receivedItems,
    req,
    resolve ? { resolve } : {}
  );
  res.json(result);
});

// Before receiving: which lines land, which need a match or a new product.
exports.getReceiveCheck = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getReceiveCheck(req.params.id, req.shop._id, req);
  res.json(result);
});

exports.rejectTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.rejectTransfer(
    req.params.id,
    req.shop._id,
    req.user._id,
    req.body.reason,
    req
  );
  res.json(result);
});

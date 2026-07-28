const stockTransferService = require('../services/stockTransfer.service');
const asyncHandler = require('../utils/asyncHandler.util');

exports.createTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.createTransfer(
    { ...req.body, shop: req.user.currentShop },
    req.user._id
  );
  res.status(201).json(result);
});

exports.getTransfers = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransfers(
    req.user.currentShop,
    req.query
  );
  res.json(result);
});

exports.getTransferById = asyncHandler(async (req, res) => {
  const result = await stockTransferService.getTransferById(
    req.params.id,
    req.user.currentShop
  );
  res.json(result);
});

exports.approveTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.approveTransfer(
    req.params.id,
    req.user.currentShop,
    req.user._id
  );
  res.json(result);
});

exports.receiveTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.receiveTransfer(
    req.params.id,
    req.user.currentShop,
    req.user._id,
    req.body.receivedItems
  );
  res.json(result);
});

exports.rejectTransfer = asyncHandler(async (req, res) => {
  const result = await stockTransferService.rejectTransfer(
    req.params.id,
    req.user.currentShop,
    req.user._id,
    req.body.reason
  );
  res.json(result);
});

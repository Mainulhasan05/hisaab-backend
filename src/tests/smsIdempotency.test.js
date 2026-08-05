/**
 * Unit Test Suite for Cashier SMS Permissions & Invoice SMS Deduplication
 */

const { ROLE_PRESETS } = require('../config/permissions');
const smsService = require('../services/sms.service');
const SMSLog = require('../models/SMSLog.model');
const Sale = require('../models/Sale.model');
const Shop = require('../models/Shop.model');
const SMSQuota = require('../models/SMSQuota.model');
const mongoose = require('mongoose');

describe('Cashier SMS Permissions & Invoice Deduplication', () => {
  const mockShopId = new mongoose.Types.ObjectId().toString();
  const mockUserId = new mongoose.Types.ObjectId().toString();
  const mockSaleId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Cashier Preset Permissions', () => {
    it('should include view and create permissions for sms module in cashier preset', () => {
      const cashierPerms = ROLE_PRESETS.cashier.permissions;
      expect(cashierPerms.sms).toBeDefined();
      expect(cashierPerms.sms.view).toBe(true);
      expect(cashierPerms.sms.create).toBe(true);
    });
  });

  describe('Invoice SMS Deduplication', () => {
    it('should prevent sending duplicate SMS for an invoice if sale.smsSent is true', async () => {
      const invoiceNo = 'INV-2026-0001';

      jest.spyOn(Sale, 'findById').mockResolvedValue({
        _id: mockSaleId,
        invoiceNo,
        smsSent: true,
        smsSentAt: new Date()
      });

      const sendSingleSpy = jest.spyOn(smsService, 'sendSingle');

      // Execute sendSaleReceiptAsync
      smsService.sendSaleReceiptAsync(mockShopId, mockUserId, {
        id: mockSaleId,
        invoiceNumber: invoiceNo,
        total: 500,
        paid: 500,
        due: 0,
        customerPhone: '01700000000',
        sendSms: true
      });

      // Allow setImmediate queue to run
      await new Promise(resolve => setImmediate(resolve));

      // sendSingle should NOT be called because smsSent was true
      expect(sendSingleSpy).not.toHaveBeenCalled();
    });

    it('should prevent sending duplicate SMS if SMSLog already exists for invoiceNumber', async () => {
      const invoiceNo = 'INV-2026-0002';

      jest.spyOn(Sale, 'findById').mockResolvedValue({
        _id: mockSaleId,
        invoiceNo,
        smsSent: false
      });

      jest.spyOn(SMSLog, 'findOne').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        shop: mockShopId,
        invoiceNumber: invoiceNo,
        status: 'sent',
        createdAt: new Date()
      });

      const updateSaleSpy = jest.spyOn(Sale, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
      const sendSingleSpy = jest.spyOn(smsService, 'sendSingle');

      smsService.sendSaleReceiptAsync(mockShopId, mockUserId, {
        id: mockSaleId,
        invoiceNumber: invoiceNo,
        total: 500,
        paid: 500,
        due: 0,
        customerPhone: '01700000000',
        sendSms: true
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(sendSingleSpy).not.toHaveBeenCalled();
      expect(updateSaleSpy).toHaveBeenCalledWith(
        { _id: mockSaleId },
        { $set: { smsSent: true, smsSentAt: expect.any(Date) } }
      );
    });
  });
});

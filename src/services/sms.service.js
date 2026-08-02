const axios = require('axios');
// All gateway calls share a hard timeout — Node's default is none, so a hung
// gateway would otherwise leak sockets and pending promises indefinitely
const smsHttp = axios.create({ timeout: Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000 });
const SMSLog = require('../models/SMSLog.model');
const SMSQuota = require('../models/SMSQuota.model');
const { formatPhone } = require('../utils/phone.util');
const { SMS_TYPES, SMS_STATUS } = require('../config/constants');
const logger = require('../utils/logger.util');
const { countSms, isUnicode } = require('../utils/smsCounter.util');
const { getBranchForCreate, scopeByBranch } = require('../utils/branchScope.util');

// MimSMS API Configuration
const MIMSMS = {
  BASE_URL: 'https://api.mimsms.com/api/SmsSending',
  SINGLE: '/SMS',
  BULK: '/OneToMany',
  DYNAMIC: '/DSMS',
  BALANCE: '/balanceCheck'
};

const formatSmsAmount = (amount) => {
  const value = Number(amount) || 0;
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
};

const getGsmSafeShopName = (shopName) => {
  if (!shopName || isUnicode(shopName)) {
    return 'Hisaab';
  }

  return shopName;
};

class SMSService {
  /**
   * Send OTP (no quota check for registration)
   */
  async sendOTP(phone, otp) {
    const formattedPhone = formatPhone(phone);
    const message = `আপনার হিসাব OTP: ${otp}\nমেয়াদ: ৫ মিনিট`;

    // OTPs are secrets — only log them in development, never in production logs
    if (process.env.NODE_ENV === 'development' || process.env.SKIP_SMS === 'true') {
      logger.info(`[DEVELOPMENT OTP] Phone: ${formattedPhone} | OTP Code: ${otp}`);
      return { success: true, message: 'OTP logged to console' };
    }

    try {
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.SINGLE, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: formattedPhone,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: 'T', // Transactional
        Message: message
      });

      logger.info(`OTP sent to ${formattedPhone}: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to send OTP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send single SMS
   */
  async sendSingle(shopId, userId, phone, message, customerId = null, req = null) {
    // Calculate segment cost
    const smsInfo = countSms(message);
    const segmentCost = smsInfo.segments || 1;
    // Check quota
    const quota = await SMSQuota.getOrCreate(shopId);
    if (quota.remainingQuota < segmentCost) {
      throw new Error(`Insufficient SMS quota. Need ${segmentCost}, have ${quota.remainingQuota}`);
    }

    const formattedPhone = formatPhone(phone);

    try {
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.SINGLE, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: formattedPhone,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: 'T',
        Message: message
      });

      // Log SMS
      const smsLog = await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: [{
          phone: formattedPhone,
          customer: customerId,
          status: SMS_STATUS.SENT
        }],
        message,
        type: SMS_TYPES.SINGLE,
        transactionId: response.data?.TransactionId,
        cost: segmentCost,
        status: SMS_STATUS.SENT,
        sentCount: 1,
        apiResponse: response.data,
        sentBy: userId
      });

      // Deduct quota (segment-aware)
      await quota.deductQuota(segmentCost);

      logger.info(`SMS sent to ${formattedPhone} for shop ${shopId}`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      // Log failed attempt
      await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: [{ phone: formattedPhone, customer: customerId, status: SMS_STATUS.FAILED }],
        message,
        type: SMS_TYPES.SINGLE,
        status: SMS_STATUS.FAILED,
        errorMessage: error.message,
        sentBy: userId
      });

      logger.error(`Failed to send SMS: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send bulk SMS (same message to multiple recipients)
   */
  async sendBulk(shopId, userId, recipients, message, req = null) {
    const count = recipients.length;

    // Calculate segment-aware cost: segments per message × recipient count
    const smsInfo = countSms(message);
    const totalCost = (smsInfo.segments || 1) * count;

    // Check quota
    const quota = await SMSQuota.getOrCreate(shopId);
    if (quota.remainingQuota < totalCost) {
      throw new Error(`Insufficient SMS quota. Need ${totalCost} (${smsInfo.segments} segments × ${count} recipients), have ${quota.remainingQuota}`);
    }

    // Format all phone numbers
    const formattedRecipients = recipients.map(r => ({
      ...r,
      phone: formatPhone(r.phone)
    }));

    const phoneNumbers = formattedRecipients.map(r => r.phone).join(',');

    try {
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.BULK, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        MobileNumber: phoneNumbers,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: 'P', // Promotional
        Message: message
      });

      // Log SMS
      const smsLog = await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: formattedRecipients.map(r => ({
          phone: r.phone,
          customer: r.customerId,
          customerName: r.customerName,
          status: SMS_STATUS.SENT
        })),
        message,
        type: SMS_TYPES.BULK,
        transactionId: response.data?.TransactionId,
        cost: totalCost,
        status: SMS_STATUS.SENT,
        sentCount: count,
        apiResponse: response.data,
        sentBy: userId
      });

      // Deduct quota (segment-aware)
      await quota.deductQuota(totalCost);

      logger.info(`Bulk SMS sent to ${count} recipients for shop ${shopId}`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: formattedRecipients.map(r => ({
          phone: r.phone,
          customer: r.customerId,
          status: SMS_STATUS.FAILED
        })),
        message,
        type: SMS_TYPES.BULK,
        status: SMS_STATUS.FAILED,
        failedCount: count,
        errorMessage: error.message,
        sentBy: userId
      });

      logger.error(`Failed to send bulk SMS: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send dynamic SMS (personalized messages)
   */
  async sendDynamic(shopId, userId, recipients, req = null) {
    const count = recipients.length;

    // Calculate total segment cost across all personalized messages
    const totalCost = recipients.reduce((sum, r) => {
      const info = countSms(r.message);
      return sum + (info.segments || 1);
    }, 0);

    // Check quota
    const quota = await SMSQuota.getOrCreate(shopId);
    if (quota.remainingQuota < totalCost) {
      throw new Error(`Insufficient SMS quota. Need ${totalCost} segments for ${count} recipients, have ${quota.remainingQuota}`);
    }

    // Prepare message data for MimSMS
    const messageData = recipients.map(r => ({
      MobileNumber: formatPhone(r.phone),
      Message: r.message
    }));

    try {
      const response = await smsHttp.post(MIMSMS.BASE_URL + MIMSMS.DYNAMIC, {
        UserName: process.env.MIMSMS_USERNAME,
        Apikey: process.env.MIMSMS_API_KEY,
        SenderName: process.env.MIMSMS_SENDER_ID,
        TransactionType: 'T',
        MessageData: messageData
      });

      // Log SMS
      const smsLog = await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: recipients.map(r => ({
          phone: formatPhone(r.phone),
          customer: r.customerId,
          customerName: r.customerName,
          message: r.message,
          status: SMS_STATUS.SENT
        })),
        message: 'Dynamic SMS - Multiple personalized messages',
        type: SMS_TYPES.DYNAMIC,
        transactionId: response.data?.TransactionId,
        cost: totalCost,
        status: SMS_STATUS.SENT,
        sentCount: count,
        apiResponse: response.data,
        sentBy: userId
      });

      // Deduct quota (segment-aware)
      await quota.deductQuota(totalCost);

      logger.info(`Dynamic SMS sent to ${count} recipients for shop ${shopId}`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      await SMSLog.create({
        shop: shopId,
        branch: req ? getBranchForCreate(req) : null,
        recipients: recipients.map(r => ({
          phone: formatPhone(r.phone),
          customer: r.customerId,
          message: r.message,
          status: SMS_STATUS.FAILED
        })),
        message: 'Dynamic SMS - Failed',
        type: SMS_TYPES.DYNAMIC,
        status: SMS_STATUS.FAILED,
        failedCount: count,
        errorMessage: error.message,
        sentBy: userId
      });

      logger.error(`Failed to send dynamic SMS: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check MimSMS balance
   */
  async checkBalance() {
    try {
      const response = await smsHttp.get(MIMSMS.BASE_URL + MIMSMS.BALANCE, {
        params: {
          UserName: process.env.MIMSMS_USERNAME,
          Apikey: process.env.MIMSMS_API_KEY
        }
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to check SMS balance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get SMS history for shop
   */
  async getHistory(shopId, options = {}) {
    return SMSLog.getShopHistory(shopId, options);
  }

  /**
   * Get shop quota
   */
  async getQuota(shopId) {
    let quota = await SMSQuota.findOne({ shop: shopId });
    if (!quota) {
      quota = {
        totalQuota: 0,
        usedQuota: 0,
        remainingQuota: 0,
        isEnabled: false,
      };
    }
    return quota;
  }

  /**
   * Send single SMS (wrapper for controller)
   */
  async sendSingleSMS(shopId, userId, data, req = null) {
    const { phone, message, customerId } = data;
    return this.sendSingle(shopId, userId, phone, message, customerId, req);
  }

  /**
   * Send bulk SMS (wrapper for controller)
   */
  async sendBulkSMS(shopId, userId, data, req = null) {
    const { recipients, message } = data;
    return this.sendBulk(shopId, userId, recipients, message, req);
  }

  /**
   * Send dynamic SMS (wrapper for controller)
   */
  async sendDynamicSMS(shopId, userId, recipients, req = null) {
    return this.sendDynamic(shopId, userId, recipients, req);
  }

  /**
   * Send due reminder SMS to customers
   */
  async sendDueReminder(shopId, userId, customerIds, req = null) {
    const Customer = require('../models/Customer.model');
    const Shop = require('../models/Shop.model');

    const shop = await Shop.findById(shopId);
    const customers = await Customer.find(
      req ? scopeByBranch(req, {
        _id: { $in: customerIds },
        shop: shopId,
        totalDue: { $gt: 0 },
      }) : {
        _id: { $in: customerIds },
        shop: shopId,
        totalDue: { $gt: 0 },
      }
    );

    if (customers.length === 0) {
      return { success: true, message: 'No customers with due found', sentCount: 0 };
    }

    // Prepare dynamic messages
    const recipients = customers.map(customer => ({
      phone: customer.phone,
      customerId: customer._id,
      customerName: customer.name,
      message: `প্রিয় ${customer.name},\nআপনার বকেয়া: ৳${customer.totalDue}\n${shop.name} থেকে অনুরোধ করা হচ্ছে যত দ্রুত সম্ভব বকেয়া পরিশোধ করুন।\nধন্যবাদ।`,
    }));

    return this.sendDynamic(shopId, userId, recipients, req);
  }

  /**
   * Get SMS history for shop
   */
  async getSMSHistory(shopId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    const filter = req ? scopeByBranch(req, { shop: shopId }) : { shop: shopId };

    const [history, total] = await Promise.all([
      SMSLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SMSLog.countDocuments(filter),
    ]);

    return {
      data: history,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Send sale receipt SMS (non-blocking - runs async in background)
   * This method returns immediately and sends SMS in the background
   */
  sendSaleReceiptAsync(shopId, userId, saleData) {
    const Shop = require('../models/Shop.model');
    const Customer = require('../models/Customer.model');

    // Run in background (non-blocking) using setImmediate
    setImmediate(async () => {
      try {
        // Get shop with settings
        const shop = await Shop.findById(shopId);
        if (!shop) {
          logger.warn(`SMS: Shop not found for sale receipt: ${shopId}`);
          return;
        }

        // Check if auto SMS is enabled OR if forced by sendSms flag
        const smsSettings = shop.settings?.smsSettings || {};
        const forceSend = saleData.sendSms === true;
        if (!forceSend && !smsSettings.autoSendOnSale) {
          logger.info(`SMS: Auto-send disabled for shop ${shop.name} and not forced.`);
          return;
        }

        // Check minimum sale amount (ignore if forced)
        if (!forceSend && smsSettings.minSaleAmountForSms > 0 && saleData.total < smsSettings.minSaleAmountForSms) {
          logger.info(`SMS: Sale amount ${saleData.total} below minimum ${smsSettings.minSaleAmountForSms}`);
          return;
        }

        // Get customer phone
        let customerPhone = saleData.customerPhone;
        let customerName = saleData.customerName || 'গ্রাহক';

        if (!customerPhone && saleData.customerId) {
          const customer = await Customer.findById(saleData.customerId);
          if (customer) {
            customerPhone = customer.phone;
            customerName = customer.name;
          }
        }

        // Check if we should send (customer has phone)
        if (!customerPhone) {
          logger.info(`SMS: No phone number for customer in sale ${saleData.invoiceNumber}`);
          return;
        }

        // Check SMS quota
        const quota = await SMSQuota.findOne({ shop: shopId });
        if (!quota || !quota.isEnabled || quota.remainingQuota < 1) {
          logger.warn(`SMS: Insufficient quota for shop ${shop.name}`);
          return;
        }

        // Keep sale receipt SMS ASCII/GSM-7 so it usually costs one segment.
        const message = `${getGsmSafeShopName(shop.name)}\nInv:${saleData.invoiceNumber}\nTotal:Tk${formatSmsAmount(saleData.total)}\nPaid:Tk${formatSmsAmount(saleData.paid)}\nDue:Tk${formatSmsAmount(saleData.due)}\nThanks for visiting`;

        // Send SMS
        await this.sendSingle(shopId, userId, customerPhone, message, saleData.customerId);
        logger.info(`SMS: Sale receipt sent for ${saleData.invoiceNumber} to ${customerPhone}`);

      } catch (error) {
        logger.error(`SMS: Failed to send sale receipt: ${error.message}`);
        // Don't throw - this is background processing
      }
    });

    // Return immediately - SMS sends in background
    return { queued: true };
  }

  /**
   * Send payment receipt SMS (non-blocking)
   */
  sendPaymentReceiptAsync(shopId, userId, paymentData) {
    const Shop = require('../models/Shop.model');
    const Customer = require('../models/Customer.model');

    setImmediate(async () => {
      try {
        const shop = await Shop.findById(shopId);
        if (!shop) return;

        const smsSettings = shop.settings?.smsSettings || {};
        if (!smsSettings.autoSendOnDuePayment) return;

        const customer = await Customer.findById(paymentData.customerId);
        if (!customer || !customer.phone) return;

        const quota = await SMSQuota.findOne({ shop: shopId });
        if (!quota || !quota.isEnabled || quota.remainingQuota < 1) return;

        const message = `${customer.name},\n৳${paymentData.amount} পেমেন্ট পাওয়া গেছে।\nবর্তমান বকেয়া: ৳${customer.totalDue}\nধন্যবাদ - ${shop.name}`;

        await this.sendSingle(shopId, userId, customer.phone, message, customer._id);
        logger.info(`SMS: Payment receipt sent to ${customer.phone}`);

      } catch (error) {
        logger.error(`SMS: Failed to send payment receipt: ${error.message}`);
      }
    });

    return { queued: true };
  }

  /**
   * Get SMS templates
   */
  getTemplates() {
    return [
      {
        id: 'due_reminder',
        name: 'বকেয়া স্মারক',
        nameEn: 'Due Reminder',
        template: 'প্রিয় {customer_name},\nআপনার বকেয়া: ৳{due_amount}\nঅনুগ্রহ করে যত দ্রুত সম্ভব পরিশোধ করুন।\n{shop_name}',
        variables: ['customer_name', 'due_amount', 'shop_name'],
      },
      {
        id: 'payment_received',
        name: 'পেমেন্ট প্রাপ্তি',
        nameEn: 'Payment Received',
        template: 'প্রিয় {customer_name},\nআপনার ৳{amount} পেমেন্ট পাওয়া গেছে।\nবর্তমান বকেয়া: ৳{remaining_due}\nধন্যবাদ - {shop_name}',
        variables: ['customer_name', 'amount', 'remaining_due', 'shop_name'],
      },
      {
        id: 'sale_receipt',
        name: 'বিক্রয় রশিদ',
        nameEn: 'Sale Receipt',
        template: '{shop_name}\nInv:{invoice_no}\nTotal:Tk{total}\nPaid:Tk{paid}\nDue:Tk{due}\nThanks for visiting',
        variables: ['shop_name', 'invoice_no', 'total', 'paid', 'due'],
      },
      {
        id: 'custom',
        name: 'কাস্টম মেসেজ',
        nameEn: 'Custom Message',
        template: '',
        variables: [],
      },
    ];
  }
}

module.exports = new SMSService();

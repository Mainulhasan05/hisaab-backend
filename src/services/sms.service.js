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
const { branchFilter, requireBranch, isBranchCustomerScope } = require('../utils/branchScope.util');
// Message bodies live in one place because the dashboard previews them to the
// shopkeeper before sending — see the header of smsTemplates.util.js.
const {
  formatSmsAmount,
  gsmSafeShopName: getGsmSafeShopName,
  buildSaleReceipt,
  buildPaymentReceipt,
  buildDueReminder,
  buildOtp,
} = require('../utils/smsTemplates.util');

// MimSMS API Configuration
const MIMSMS = {
  BASE_URL: 'https://api.mimsms.com/api/SmsSending',
  SINGLE: '/SMS',
  BULK: '/OneToMany',
  DYNAMIC: '/DSMS',
  BALANCE: '/balanceCheck'
};

class SMSService {
  /**
   * Send OTP (no quota check for registration)
   */
  async sendOTP(phone, otp) {
    const formattedPhone = formatPhone(phone);
    const message = buildOtp(otp);

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
  async sendSingle(shopId, userId, phone, message, customerId = null, req = null, options = {}) {
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
        branch: req ? requireBranch(req) : null,
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
        sentBy: userId,
        invoiceNumber: options.invoiceNumber || null,
        sale: options.saleId || null
      });

      // Deduct quota (segment-aware)
      await quota.deductQuota(segmentCost);

      logger.info(`SMS sent to ${formattedPhone} for shop ${shopId}`);
      return { success: true, smsLog, response: response.data };
    } catch (error) {
      // Log failed attempt
      await SMSLog.create({
        shop: shopId,
        branch: req ? requireBranch(req) : null,
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
        branch: req ? requireBranch(req) : null,
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
        branch: req ? requireBranch(req) : null,
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
        branch: req ? requireBranch(req) : null,
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
        branch: req ? requireBranch(req) : null,
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
    const CustomerBalance = require('../models/CustomerBalance.model');
    const Shop = require('../models/Shop.model');

    const shop = await Shop.findById(shopId);

    // NEVER wrap this in branch scoping. The Customer model has no `branch`
    // field, so `branch: <id>` matched zero documents and due reminders
    // silently sent nothing for every staff member and for any owner with a
    // branch selected (FEATURE_AUDIT.md H-7).
    const customers = await Customer.find({
      _id: { $in: customerIds },
      shop: shopId,
    });

    // Under separate books the amount in the message must be what the customer
    // owes THIS branch — texting them the shop-wide figure would both overstate
    // the debt and disclose another branch's business. The due > 0 filter moves
    // here for the same reason: a customer who owes another branch but not this
    // one must not be reminded by this one.
    const branchScoped = isBranchCustomerScope(req);
    let dueByCustomer = null;
    if (branchScoped) {
      const rows = await CustomerBalance.find({
        shop: shopId,
        branch: req.branchId,
        customer: { $in: customerIds },
        totalDue: { $gt: 0 },
      }).lean();
      dueByCustomer = new Map(rows.map((r) => [String(r.customer), r.totalDue]));
    }

    const owing = customers
      .map((customer) => ({
        customer,
        due: branchScoped
          ? (dueByCustomer.get(String(customer._id)) || 0)
          : (customer.totalDue || 0),
      }))
      .filter((entry) => entry.due > 0);

    if (owing.length === 0) {
      return { success: true, message: 'No customers with due found', sentCount: 0 };
    }

    // Prepare dynamic messages
    const recipients = owing.map(({ customer, due }) => ({
      phone: customer.phone,
      customerId: customer._id,
      customerName: customer.name,
      message: buildDueReminder({
        customerName: customer.name,
        due,
        shopName: shop.name,
      }),
    }));

    return this.sendDynamic(shopId, userId, recipients, req);
  }

  /**
   * Get SMS history for shop
   */
  async getSMSHistory(shopId, options = {}, req = null) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    const filter = req ? branchFilter(req, { shop: shopId }) : { shop: shopId };

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
    const Sale = require('../models/Sale.model');

    // Run in background (non-blocking) using setImmediate
    setImmediate(async () => {
      try {
        const invoiceNo = saleData?.invoiceNumber || saleData?.invoiceNo;
        if (!invoiceNo) return;

        // Deduplication Guard 1: Check if Sale document has smsSent = true
        const saleId = saleData?.id || saleData?._id;
        let saleDoc = null;
        if (saleId) {
          saleDoc = await Sale.findById(saleId);
        } else {
          saleDoc = await Sale.findOne({ shop: shopId, invoiceNo });
        }

        if (saleDoc?.smsSent) {
          logger.warn(`SMS: Duplicate send attempt prevented for invoice ${invoiceNo}`);
          return;
        }

        // Deduplication Guard 2: Check if an SMSLog already exists for this invoice
        const existingLog = await SMSLog.findOne({
          shop: shopId,
          invoiceNumber: invoiceNo,
          status: { $in: [SMS_STATUS.SENT, SMS_STATUS.DELIVERED, SMS_STATUS.PENDING] }
        });
        if (existingLog) {
          logger.warn(`SMS: Duplicate SMSLog prevented for invoice ${invoiceNo}`);
          if (saleDoc && !saleDoc.smsSent) {
            await Sale.updateOne({ _id: saleDoc._id }, { $set: { smsSent: true, smsSentAt: existingLog.createdAt } });
          }
          return;
        }

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
        let customerName = saleData.customerName || 'Customer';

        if (!customerPhone && saleData.customerId) {
          const customer = await Customer.findById(saleData.customerId);
          if (customer) {
            customerPhone = customer.phone;
            customerName = customer.name;
          }
        }

        // Check if we should send (customer has phone)
        if (!customerPhone) {
          logger.info(`SMS: No phone number for customer in sale ${invoiceNo}`);
          return;
        }

        // Check SMS quota
        const quota = await SMSQuota.findOne({ shop: shopId });
        if (!quota || !quota.isEnabled || quota.remainingQuota < 1) {
          logger.warn(`SMS: Insufficient quota for shop ${shop.name}`);
          return;
        }

        // Built from the shared template so the till's preview and this message
        // cannot disagree — see smsTemplates.util.js.
        const message = buildSaleReceipt({
          invoiceNo,
          total: saleData.total,
          paid: saleData.paid,
          due: saleData.due,
          shopName: shop.name,
        });

        // Send SMS with invoice metadata
        const sendResult = await this.sendSingle(shopId, userId, customerPhone, message, saleData.customerId, null, {
          invoiceNumber: invoiceNo,
          saleId: saleDoc?._id || null
        });

        // Mark Sale document as smsSent: true
        if (sendResult?.success && saleDoc) {
          await Sale.updateOne(
            { _id: saleDoc._id },
            { $set: { smsSent: true, smsSentAt: new Date() } }
          );
        }

        logger.info(`SMS: Sale receipt sent for ${invoiceNo} to ${customerPhone}`);

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

        // `customer` is re-read here, after the collection has settled, so
        // `totalDue` is already the post-payment balance. The client preview
        // subtracts the amount itself to arrive at the same number.
        const message = buildPaymentReceipt({
          customerName: customer.name,
          amount: paymentData.amount,
          remainingDue: customer.totalDue,
          shopName: shop.name,
        });

        await this.sendSingle(shopId, userId, customer.phone, message, customer._id);
        logger.info(`SMS: Payment receipt sent to ${customer.phone}`);

      } catch (error) {
        logger.error(`SMS: Failed to send payment receipt: ${error.message}`);
      }
    });

    return { queued: true };
  }

  /**
   * Get SMS templates with dynamic shop name
   */
  async getTemplates(shopId = null) {
    let shopName = 'Your Shop';
    if (shopId) {
      try {
        const Shop = require('../models/Shop.model');
        const shop = await Shop.findById(shopId).select('name').lean();
        if (shop?.name) {
          shopName = getGsmSafeShopName(shop.name);
        }
      } catch (err) {
        logger.error(`SMS: Failed to fetch shop name for templates: ${err.message}`);
      }
    }

    // Built by passing placeholders THROUGH the real builders, so a template
    // offered on the SMS page always has the same shape as the message the
    // automatic flows send. Editing a body in smsTemplates.util.js updates the
    // picker for free; forgetting to update the picker is no longer possible.
    return [
      {
        id: 'due_reminder',
        name: 'Due Reminder',
        nameEn: 'Due Reminder',
        template: buildDueReminder({
          customerName: '{customer_name}',
          due: '{due_amount}',
          shopName,
        }),
        variables: ['customer_name', 'due_amount', 'shop_name'],
      },
      {
        id: 'payment_received',
        // This one used to open "Dear {customer_name}," while the message the
        // app actually sends on a due collection opens with the bare name. The
        // template now IS that message, so the picker stops advertising a
        // greeting the automatic flow never sends.
        name: 'Payment Received',
        nameEn: 'Payment Received',
        template: buildPaymentReceipt({
          customerName: '{customer_name}',
          amount: '{amount}',
          remainingDue: '{remaining_due}',
          shopName,
        }),
        variables: ['customer_name', 'amount', 'remaining_due', 'shop_name'],
      },
      {
        id: 'sale_receipt',
        name: 'Sale Receipt',
        nameEn: 'Sale Receipt',
        template: buildSaleReceipt({
          invoiceNo: '{invoice_no}',
          total: '{total}',
          paid: '{paid}',
          due: '{due}',
          shopName,
        }),
        variables: ['shop_name', 'invoice_no', 'total', 'paid', 'due'],
      },
      {
        id: 'custom',
        name: 'Custom Message',
        nameEn: 'Custom Message',
        template: `Dear Customer, thank you for shopping with us! - ${shopName}`,
        variables: ['shop_name'],
      },
    ];
  }
}

module.exports = new SMSService();

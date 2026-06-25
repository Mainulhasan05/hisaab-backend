const mongoose = require('mongoose');
const { PAYMENT_METHODS } = require('../config/constants');

const expenseSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExpenseCategory',
    required: [true, 'খরচের ক্যাটাগরি দিন']
  },
  categoryName: {
    type: String,
    required: [true, 'ক্যাটাগরির নাম দিন']
  },
  amount: {
    type: Number,
    required: [true, 'টাকার পরিমাণ দিন'],
    min: [0.01, 'টাকার পরিমাণ ০ এর বেশি হতে হবে']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'বিবরণ ৫০০ অক্ষরের বেশি হতে পারবে না']
  },
  date: {
    type: Date,
    default: Date.now,
    required: [true, 'তারিখ দিন']
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PAYMENT_METHODS),
    default: PAYMENT_METHODS.CASH
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes - Optimized for scalability
expenseSchema.index({ shop: 1, branch: 1, date: -1 }); // Date-based listing with branch
expenseSchema.index({ shop: 1, branch: 1, category: 1, date: -1 }); // Category-wise expenses with branch

// Static: Get summary by category for a date range
expenseSchema.statics.getSummaryByCategory = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    date: { $gte: startDate, $lte: endDate }
  };

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$category',
        categoryName: { $first: '$categoryName' },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { total: -1 } }
  ]);
};

// Static: Get total expenses for a date range
expenseSchema.statics.getTotal = async function(shopId, startDate, endDate) {
  const match = {
    shop: new mongoose.Types.ObjectId(shopId),
    date: { $gte: startDate, $lte: endDate }
  };

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

  return result[0] || { total: 0, count: 0 };
};

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;

const mongoose = require('mongoose');

const geminiKeySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'অ্যাকাউন্টের নাম দিন'],
    trim: true
  },
  apiKey: {
    type: String,
    required: [true, 'API Key দিন'],
    trim: true
  },
  dailyLimit: {
    type: Number,
    default: 1500,
    min: [1, 'দৈনিক লিমিট কমপক্ষে ১ হতে হবে']
  },
  requestsToday: {
    type: Number,
    default: 0
  },
  totalRequests: {
    type: Number,
    default: 0
  },
  lastUsedAt: {
    type: Date,
    default: null
  },
  lastResetDate: {
    type: String,
    default: () => new Date().toISOString().split('T')[0]
  },
  isActive: {
    type: Boolean,
    default: true
  },
  status: {
    type: String,
    enum: ['active', 'quota_exceeded', 'invalid'],
    default: 'active'
  },
  lastErrorMessage: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

geminiKeySchema.index({ isActive: 1, status: 1, requestsToday: 1 });

// Helper to mask key for API responses (e.g. AIzaSy...X9Y7)
geminiKeySchema.methods.getMaskedKey = function() {
  if (!this.apiKey) return '';
  if (this.apiKey.length <= 10) return '••••••••';
  return `${this.apiKey.substring(0, 6)}••••••••${this.apiKey.substring(this.apiKey.length - 4)}`;
};

const GeminiKey = mongoose.model('GeminiKey', geminiKeySchema);

module.exports = GeminiKey;

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { normalizePhone } = require('../utils/phone.util');

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: [true, 'ফোন নম্বর দিন'],
    trim: true
  },
  password: {
    type: String,
    required: [true, 'পাসওয়ার্ড দিন'],
    minlength: [6, 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে'],
    select: false
  },
  name: {
    type: String,
    required: [true, 'নাম দিন'],
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন']
  },
  // ── RBAC fields ──
  isOwner: {
    type: Boolean,
    default: false
  },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    default: null
  },
  // ── End RBAC ──
  avatar: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  lastLogin: {
    type: Date
  },
  passwordChangedAt: {
    type: Date
  },
  otp: {
    code: String,
    expiresAt: Date,
    sentAt: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
userSchema.index({ phone: 1, shop: 1 }, { unique: true });
userSchema.index({ shop: 1, isActive: 1 });

// Normalize phone before saving
userSchema.pre('save', function(next) {
  if (this.isModified('phone')) {
    this.phone = normalizePhone(this.phone);
  }
  next();
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);

  // Update passwordChangedAt
  if (!this.isNew) {
    this.passwordChangedAt = Date.now() - 1000;
  }

  next();
});

// Compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

/**
 * Generate JWT Token with embedded permissions
 * Owner gets permissions: null (bypasses all checks)
 * Employee gets the full permissions object from their Role
 */
userSchema.methods.generateToken = function() {
  const payload = {
    id: this._id,
    shop: this.shop._id || this.shop,
    isOwner: this.isOwner,
    permissions: null, // default for owners
  };

  // If not owner and role is populated with permissions, embed them
  if (!this.isOwner && this.role && typeof this.role === 'object' && this.role.permissions) {
    payload.permissions = this.role.permissions;
  }

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
};

// Check if password changed after token was issued
userSchema.methods.changedPasswordAfter = function(jwtTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return jwtTimestamp < changedTimestamp;
  }
  return false;
};

// Generate OTP
userSchema.methods.generateOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.otp = {
    code: otp,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    sentAt: new Date()
  };
  return otp;
};

// Check if user has a valid (non-expired) OTP
userSchema.methods.hasValidOTP = function() {
  return this.otp && this.otp.code && this.otp.expiresAt > new Date();
};

// Check if OTP can be resent (60-second cooldown)
userSchema.methods.canResendOTP = function() {
  if (!this.otp || !this.otp.sentAt) return true;
  const cooldown = 60 * 1000; // 60 seconds
  return (Date.now() - new Date(this.otp.sentAt).getTime()) >= cooldown;
};

// Verify OTP
userSchema.methods.verifyOTP = function(code) {
  if (!this.otp || !this.otp.code) return false;
  if (this.otp.expiresAt < new Date()) return false;
  return this.otp.code === code;
};

// Clear OTP
userSchema.methods.clearOTP = function() {
  this.otp = undefined;
};

// Update last login
userSchema.methods.updateLastLogin = async function() {
  this.lastLogin = new Date();
  await this.save({ validateBeforeSave: false });
};

// Static: Find by phone and shop
userSchema.statics.findByPhoneAndShop = function(phone, shopId) {
  const normalizedPhone = normalizePhone(phone);
  return this.findOne({ phone: normalizedPhone, shop: shopId, isActive: true });
};

// Don't return password and otp in JSON
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.otp;
  return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = User;

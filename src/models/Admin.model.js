const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { ADMIN_ROLES } = require('../config/constants');
const { normalizePhone } = require('../utils/phone.util');

const adminSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: [true, 'ফোন নম্বর দিন'],
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'পাসওয়ার্ড দিন'],
    minlength: [8, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে'],
    select: false
  },
  name: {
    type: String,
    required: [true, 'নাম দিন'],
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না']
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  role: {
    type: String,
    enum: {
      values: Object.values(ADMIN_ROLES),
      message: 'অবৈধ ভূমিকা'
    },
    default: ADMIN_ROLES.ADMIN
  },
  avatar: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  passwordChangedAt: {
    type: Date
  },
  loginAttempts: {
    type: Number,
    default: 0
  },
  lockUntil: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes (email is indexed via unique constraint on schema definition)

// Normalize phone before saving
adminSchema.pre('save', function(next) {
  if (this.isModified('phone')) {
    this.phone = normalizePhone(this.phone);
  }
  next();
});

// Hash password before saving
adminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  const salt = await bcrypt.genSalt(11);
  this.password = await bcrypt.hash(this.password, salt);

  if (!this.isNew) {
    this.passwordChangedAt = Date.now() - 1000;
  }

  next();
});

// Virtual: Is locked
adminSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Virtual: Is super admin
adminSchema.virtual('isSuperAdmin').get(function() {
  return this.role === ADMIN_ROLES.SUPER_ADMIN;
});

// Compare password
adminSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate JWT Token
adminSchema.methods.generateToken = function() {
  return jwt.sign(
    {
      id: this._id,
      role: this.role,
      isAdmin: true
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
};

// Check if password changed after token was issued
adminSchema.methods.changedPasswordAfter = function(jwtTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return jwtTimestamp < changedTimestamp;
  }
  return false;
};

// Update last login
adminSchema.methods.updateLastLogin = async function() {
  this.lastLogin = new Date();
  this.loginAttempts = 0;
  this.lockUntil = undefined;
  await this.save({ validateBeforeSave: false });
};

// Increment login attempts
adminSchema.methods.incrementLoginAttempts = async function() {
  // Reset if lock has expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    this.loginAttempts = 1;
    this.lockUntil = undefined;
  } else {
    this.loginAttempts += 1;

    // Lock account after 5 failed attempts
    if (this.loginAttempts >= 5 && !this.isLocked) {
      this.lockUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
    }
  }

  await this.save({ validateBeforeSave: false });
};

// Check permission (role-based)
adminSchema.methods.hasPermission = function(requiredRole) {
  const roleHierarchy = {
    [ADMIN_ROLES.SUPER_ADMIN]: 3,
    [ADMIN_ROLES.ADMIN]: 2,
    [ADMIN_ROLES.SUPPORT]: 1
  };

  return roleHierarchy[this.role] >= roleHierarchy[requiredRole];
};

// Static: Find by phone
adminSchema.statics.findByPhone = function(phone) {
  const normalizedPhone = normalizePhone(phone);
  return this.findOne({ phone: normalizedPhone, isActive: true });
};

// Don't return password in JSON
adminSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  return obj;
};

const Admin = mongoose.model('Admin', adminSchema);

module.exports = Admin;

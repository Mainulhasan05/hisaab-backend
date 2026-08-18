const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { normalizePhone } = require('../utils/phone.util');

/**
 * How many devices an account remembers. Ten covers a shopkeeper's phone, the
 * counter PC, a tablet and a few networks with room to spare; past that the
 * array stops being a memory and starts being a log.
 */
const MAX_KNOWN_DEVICES = 10;

/**
 * Fingerprint one login context.
 *
 * The IP is reduced to its /24 (v4) or /64 (v6) prefix before hashing. Mobile
 * data in Bangladesh reassigns the host octet constantly — Grameenphone and
 * Robi will hand the same shopkeeper a different address several times a day —
 * so hashing the full address would mark almost every login as a new device and
 * make the alert worthless. The network is the stable part, and a device moving
 * to a genuinely different network is exactly what should be reported.
 *
 * Truncated to 32 hex characters: this is a sameness check, not a secret, and
 * 128 bits is far past any collision concern for a ten-entry list.
 */
function buildDeviceHash(ip, userAgent) {
  const raw = String(ip || '');
  let network = raw;

  if (raw.includes(':')) {
    // IPv6 — first four groups is the /64 the client sits in.
    network = raw.split(':').slice(0, 4).join(':');
  } else if (raw.includes('.')) {
    network = raw.split('.').slice(0, 3).join('.');
  }

  return crypto
    .createHash('sha256')
    .update(`${network}|${String(userAgent || '')}`)
    .digest('hex')
    .slice(0, 32);
}

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
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null // null = org-level (owner) or single-branch shop
  },
  // Owner only: the branch they last had active, so a new session lands where
  // they left off instead of defaulting to a view they can't write from.
  // Ignored for staff, who are pinned to `branch` above.
  lastActiveBranch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  avatar: {
    type: String
  },
  avatarUrl: {
    type: String
  },
  avatarThumbnail: {
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
  lastActiveAt: {
    type: Date,
    index: true
  },

  /**
   * The last network a successful login came from. Denormalised for the
   * platform alert, which has to say "from where" without a second query.
   */
  lastLoginIp: {
    type: String,
    default: null
  },

  /**
   * Devices this account has successfully logged in from before.
   *
   * ── WHY ON THE DOCUMENT AND NOT IN REDIS ────────────────────────────────
   *
   * This list is what makes "login from an unrecognised device" mean anything.
   * Redis was the obvious home — it is a cache-shaped question — but Redis is
   * OPTIONAL in this project (USE_REDIS) and its memory fallback is emptied by
   * every restart. A device memory that forgets on deploy would fire a
   * security alert for every user on the platform the first time each of them
   * logged in after a release, which trains the operator to ignore exactly the
   * alert class that matters.
   *
   * `hash` is a truncated sha256 of (ip network + user-agent). The raw values
   * are kept alongside it only so an alert can be read by a human; matching is
   * on the hash.
   *
   * Capped at MAX_KNOWN_DEVICES on write. Uncapped this grows once per café
   * wifi forever, and a login document that has to be read on every request is
   * the wrong place for an unbounded array.
   */
  knownDevices: [{
    _id: false,
    hash: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    firstSeenAt: { type: Date },
    lastSeenAt: { type: Date }
  }],
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
userSchema.index({ shop: 1, branch: 1 }); // Staff-per-branch counts + branch deactivation checks

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

  const salt = await bcrypt.genSalt(11);
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

// `crypto` is required once at the top of the file, with the other imports.

/**
 * Generate Access Token with embedded permissions and jti
 */
userSchema.methods.generateAccessToken = function() {
  const jti = crypto.randomUUID();
  const payload = {
    id: this._id,
    shop: this.shop._id || this.shop,
    isOwner: this.isOwner,
    permissions: null, // default for owners
    branch: this.branch?._id || this.branch || null, // branch assignment (null for owners/single-branch)
    jti,
    type: 'access',
  };

  // If not owner and role is populated with permissions, embed them
  if (!this.isOwner && this.role && typeof this.role === 'object' && this.role.permissions) {
    payload.permissions = this.role.permissions;
  }

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '30d'
  });
};

/**
 * Generate Refresh Token with jti
 */
userSchema.methods.generateRefreshToken = function() {
  const jti = crypto.randomUUID();
  const payload = {
    id: this._id,
    shop: this.shop._id || this.shop,
    jti,
    type: 'refresh',
  };

  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '30d'
  });
};

/**
 * Generate Auth Token Pair (Access + Refresh)
 */
userSchema.methods.generateAuthTokens = function() {
  return {
    accessToken: this.generateAccessToken(),
    refreshToken: this.generateRefreshToken(),
  };
};

userSchema.methods.generateToken = function() {
  return this.generateAccessToken();
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

/**
 * Update last login, and record which device it came from.
 *
 * Returns `{ isFirstLogin, isNewDevice, deviceCount }` — what the platform
 * alert needs in order to say something more useful than "someone logged in".
 * Returning it rather than emitting the alert here keeps the model free of a
 * dependency on the notifier, and keeps the decision to notify in the service
 * that knows about preferences.
 *
 * Called with no context (`updateLastLogin()`) it degrades to exactly its old
 * behaviour, so existing callers are unaffected.
 */
userSchema.methods.updateLastLogin = async function(context = {}) {
  const { ip = null, userAgent = null } = context;

  // Before the timestamp is overwritten — after it, every login looks like a
  // repeat, and "first ever login" is the single highest-signal event here.
  const isFirstLogin = !this.lastLogin;

  this.lastLogin = new Date();

  let isNewDevice = false;

  // No context means an internal caller that has no request to describe. Do
  // not touch the device list: recording a device with a null fingerprint
  // would make the NEXT real login look familiar when it is not.
  if (ip || userAgent) {
    const hash = buildDeviceHash(ip, userAgent);
    const now = new Date();
    const known = (this.knownDevices || []).find((d) => d.hash === hash);

    if (known) {
      known.lastSeenAt = now;
      known.ip = ip || known.ip;
    } else {
      // A user's very first login is a new device by definition. It is NOT
      // reported as one: the first-login alert already covers it, and firing
      // both would put two messages in the channel for one event.
      isNewDevice = !isFirstLogin;

      this.knownDevices = [
        ...(this.knownDevices || []),
        { hash, ip, userAgent: (userAgent || '').slice(0, 200), firstSeenAt: now, lastSeenAt: now }
      ]
        // Newest last; drop the oldest once over the cap. Recency is the right
        // eviction order — the device someone has not used in a year SHOULD
        // read as unfamiliar when it comes back.
        .slice(-MAX_KNOWN_DEVICES);
    }

    this.lastLoginIp = ip || this.lastLoginIp;
  }

  await this.save({ validateBeforeSave: false });

  return { isFirstLogin, isNewDevice, deviceCount: (this.knownDevices || []).length };
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

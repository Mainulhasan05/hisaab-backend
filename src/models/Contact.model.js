const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'নাম দিন'],
    trim: true,
    maxlength: [100, 'নাম ১০০ অক্ষরের বেশি হতে পারবে না'],
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  subject: {
    type: String,
    required: [true, 'বিষয় দিন'],
    trim: true,
    maxlength: [200, 'বিষয় ২০০ অক্ষরের বেশি হতে পারবে না'],
  },
  message: {
    type: String,
    required: [true, 'বার্তা দিন'],
    trim: true,
    maxlength: [2000, 'বার্তা ২০০০ অক্ষরের বেশি হতে পারবে না'],
  },
  status: {
    type: String,
    enum: ['new', 'read', 'replied', 'closed'],
    default: 'new',
  },
  reply: {
    type: String,
    trim: true,
  },
  repliedAt: {
    type: Date,
  },
  repliedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  ipAddress: {
    type: String,
  },
  userAgent: {
    type: String,
  },
}, {
  timestamps: true,
});

// Indexes
contactSchema.index({ status: 1 });
contactSchema.index({ createdAt: -1 });
contactSchema.index({ ipAddress: 1, createdAt: -1 }); // For rate limiting queries

// Static method to get counts by status
contactSchema.statics.getStatusCounts = async function() {
  const result = await this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);

  const counts = {
    new: 0,
    read: 0,
    replied: 0,
    closed: 0,
    total: 0,
  };

  result.forEach(item => {
    counts[item._id] = item.count;
    counts.total += item.count;
  });

  return counts;
};

const Contact = mongoose.model('Contact', contactSchema);

module.exports = Contact;

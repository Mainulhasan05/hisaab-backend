const mongoose = require('mongoose');

/**
 * Appointment Model — represents a scheduled booking for a service
 * Links customer, service, and provider with a time slot.
 */
const appointmentSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: [true, 'দোকান নির্বাচন করুন'],
    index: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch'
  },
  // Who is the appointment for
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'ক্লায়েন্ট নির্বাচন করুন']
  },
  // What service
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: [true, 'সেবা নির্বাচন করুন']
  },
  // Who will perform the service
  provider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // When
  date: {
    type: Date,
    required: [true, 'তারিখ দিন'],
    index: true
  },
  startTime: {
    type: String,  // "10:00", "14:30"
    required: [true, 'শুরুর সময় দিন']
  },
  endTime: {
    type: String   // "11:00", "15:30"
  },
  // Status workflow: scheduled → confirmed → in_progress → completed
  status: {
    type: String,
    enum: ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'],
    default: 'scheduled',
    index: true
  },
  // Notes
  notes: {
    type: String,
    trim: true
  },
  // Cancellation
  cancellationReason: {
    type: String,
    trim: true
  },
  cancelledAt: {
    type: Date
  },
  // Reminder tracking
  reminderSent: {
    type: Boolean,
    default: false
  },
  reminderSentAt: {
    type: Date
  },
  // Links to billing and treatment
  linkedSale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale'
  },
  linkedTreatment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Treatment'
  },
  // Color tag for calendar UI (hex color)
  color: {
    type: String,
    default: '#3B82F6'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
appointmentSchema.index({ shop: 1, date: 1, status: 1 });
appointmentSchema.index({ shop: 1, customer: 1 });
appointmentSchema.index({ shop: 1, provider: 1, date: 1 });
appointmentSchema.index({ shop: 1, status: 1, reminderSent: 1 });

// Virtual: is the appointment in the past?
appointmentSchema.virtual('isPast').get(function() {
  return this.date < new Date();
});

appointmentSchema.set('toJSON', { virtuals: true });
appointmentSchema.set('toObject', { virtuals: true });

const Appointment = mongoose.model('Appointment', appointmentSchema);

module.exports = Appointment;

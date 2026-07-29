/**
 * Appointment Reminder Cron Job
 *
 * Runs every hour and sends SMS reminders for appointments scheduled tomorrow
 * that haven't received a reminder yet.
 *
 * Usage: require and call startAppointmentReminderCron() in your app startup.
 */
const cron = require('node-cron');
const Appointment = require('../models/Appointment.model');
const Shop = require('../models/Shop.model');
const smsService = require('../services/sms.service');
const logger = require('../utils/logger.util');

// Bangladesh is UTC+6
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;

function getTomorrowBDRange() {
  const bdNow = new Date(Date.now() + BD_OFFSET_MS);
  const dateStr = bdNow.toISOString().split('T')[0];
  const [year, month, day] = dateStr.split('-').map(Number);

  // Tomorrow start/end in UTC
  const tomorrowStart = new Date(Date.UTC(year, month - 1, day + 1) - BD_OFFSET_MS);
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { tomorrowStart, tomorrowEnd };
}

async function sendAppointmentReminders() {
  const startTime = Date.now();
  logger.info('[CRON] Appointment reminder job started');

  try {
    const { tomorrowStart, tomorrowEnd } = getTomorrowBDRange();

    // Find appointments for tomorrow that haven't been reminded
    const appointments = await Appointment.find({
      date: { $gte: tomorrowStart, $lte: tomorrowEnd },
      status: { $in: ['scheduled', 'confirmed'] },
      reminderSent: { $ne: true },
    })
      .populate('customer', 'name phone')
      .populate('service', 'name')
      .populate('shop', 'name enabledModules')
      .limit(200)
      .lean();

    if (appointments.length === 0) {
      logger.info('[CRON] No appointment reminders to send');
      return;
    }

    let sentCount = 0;
    let failCount = 0;

    for (const appt of appointments) {
      try {
        // Skip if shop doesn't have appointments module enabled
        if (!appt.shop?.enabledModules?.appointments) continue;

        // Skip if no customer phone
        const phone = appt.customer?.phone || appt.customerPhone;
        if (!phone) continue;

        const customerName = appt.customer?.name || appt.customerName || 'প্রিয় গ্রাহক';
        const serviceName = appt.service?.name || appt.serviceName || 'সেবা';
        const shopName = appt.shop?.name || 'আমাদের দোকান';
        const time = appt.startTime || '';

        // Build Bangla SMS message
        const message = `প্রিয় ${customerName}, আগামীকাল ${time}-এ "${serviceName}" এর জন্য আপনার অ্যাপয়েন্টমেন্ট আছে। ${shopName}`;

        await smsService.sendSingle(
          appt.shop._id,
          null, // userId — system-generated
          phone,
          message,
          appt.customer?._id || null,
          null // no request context
        );

        // Mark reminder as sent
        await Appointment.updateOne(
          { _id: appt._id },
          { $set: { reminderSent: true, reminderSentAt: new Date() } }
        );

        sentCount++;
      } catch (err) {
        failCount++;
        logger.error(`[CRON] Failed to send reminder for appointment ${appt._id}: ${err.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[CRON] Appointment reminders done: ${sentCount} sent, ${failCount} failed, ${elapsed}ms`);
  } catch (err) {
    logger.error(`[CRON] Appointment reminder job failed: ${err.message}`);
  }
}

/**
 * Start the appointment reminder cron job.
 * Runs every hour at minute 0 (e.g., 8:00, 9:00, 10:00...).
 * In production, you may want to run at specific times like 8PM for next-day reminders.
 */
function startAppointmentReminderCron() {
  // Run at 8PM BD time every day (8PM BD = 2PM UTC = minute 0, hour 14)
  const schedule = process.env.APPOINTMENT_REMINDER_CRON || '0 14 * * *';

  cron.schedule(schedule, sendAppointmentReminders, {
    timezone: 'Asia/Dhaka',
    scheduled: true,
  });

  logger.info(`[CRON] Appointment reminder cron scheduled: ${schedule}`);
}

module.exports = {
  startAppointmentReminderCron,
  sendAppointmentReminders, // Export for manual trigger/testing
};

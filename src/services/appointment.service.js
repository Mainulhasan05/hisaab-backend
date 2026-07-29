const Appointment = require('../models/Appointment.model');
const { AppError } = require('../middleware/error.middleware');

class AppointmentService {
  /**
   * Get appointments with filters (date range, status, provider, customer)
   */
  async getAppointments(shopId, query = {}) {
    const {
      page = 1,
      limit = 100,
      startDate,
      endDate,
      date,
      status,
      provider,
      customer,
      sortBy = 'date',
      sortOrder = 'asc',
    } = query;

    const filter = { shop: shopId };

    // Date filtering
    if (date) {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      filter.date = { $gte: dayStart, $lte: dayEnd };
    } else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    if (status) filter.status = status;
    if (provider) filter.provider = provider;
    if (customer) filter.customer = customer;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1, startTime: 1 };

    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('customer', 'name phone')
        .populate('service', 'name duration price code')
        .populate('provider', 'name phone')
        .populate('linkedSale', 'invoiceNumber totalAmount')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Appointment.countDocuments(filter),
    ]);

    return {
      appointments,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  }

  /**
   * Get a single appointment
   */
  async getAppointment(shopId, appointmentId) {
    const appointment = await Appointment.findOne({ _id: appointmentId, shop: shopId })
      .populate('customer', 'name phone address')
      .populate('service', 'name duration price code description')
      .populate('provider', 'name phone')
      .populate('linkedSale')
      .populate('linkedTreatment')
      .populate('createdBy', 'name');

    if (!appointment) {
      throw new AppError('Appointment not found', 'অ্যাপয়েন্টমেন্ট পাওয়া যায়নি', 404);
    }
    return appointment;
  }

  /**
   * Create a new appointment
   */
  async createAppointment(shopId, data, userId) {
    // Calculate endTime from service duration if not provided
    if (!data.endTime && data.startTime && data.serviceDuration) {
      const [hours, minutes] = data.startTime.split(':').map(Number);
      const totalMinutes = hours * 60 + minutes + data.serviceDuration;
      const endHours = Math.floor(totalMinutes / 60);
      const endMins = totalMinutes % 60;
      data.endTime = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
    }
    delete data.serviceDuration;

    const appointment = await Appointment.create({
      ...data,
      shop: shopId,
      createdBy: userId,
    });

    return appointment;
  }

  /**
   * Update an appointment
   */
  async updateAppointment(shopId, appointmentId, data) {
    const appointment = await Appointment.findOne({ _id: appointmentId, shop: shopId });
    if (!appointment) {
      throw new AppError('Appointment not found', 'অ্যাপয়েন্টমেন্ট পাওয়া যায়নি', 404);
    }

    const allowedFields = [
      'customer', 'service', 'provider', 'date', 'startTime', 'endTime',
      'status', 'notes', 'color', 'linkedSale', 'linkedTreatment',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        appointment[field] = data[field];
      }
    }

    // Handle cancellation
    if (data.status === 'cancelled' && data.cancellationReason) {
      appointment.cancellationReason = data.cancellationReason;
      appointment.cancelledAt = new Date();
    }

    await appointment.save();
    return appointment;
  }

  /**
   * Update appointment status
   */
  async updateStatus(shopId, appointmentId, status, reason) {
    const appointment = await Appointment.findOne({ _id: appointmentId, shop: shopId });
    if (!appointment) {
      throw new AppError('Appointment not found', 'অ্যাপয়েন্টমেন্ট পাওয়া যায়নি', 404);
    }

    appointment.status = status;
    if (status === 'cancelled' && reason) {
      appointment.cancellationReason = reason;
      appointment.cancelledAt = new Date();
    }

    await appointment.save();
    return appointment;
  }

  /**
   * Delete an appointment
   */
  async deleteAppointment(shopId, appointmentId) {
    const appointment = await Appointment.findOne({ _id: appointmentId, shop: shopId });
    if (!appointment) {
      throw new AppError('Appointment not found', 'অ্যাপয়েন্টমেন্ট পাওয়া যায়নি', 404);
    }

    await appointment.deleteOne();
    return { deleted: true };
  }

  /**
   * Get today's appointments count and upcoming reminders
   */
  async getTodaySummary(shopId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [todayCount, upcomingCount, completedToday] = await Promise.all([
      Appointment.countDocuments({
        shop: shopId,
        date: { $gte: today, $lt: tomorrow },
        status: { $nin: ['cancelled', 'no_show'] },
      }),
      Appointment.countDocuments({
        shop: shopId,
        date: { $gte: today },
        status: 'scheduled',
        reminderSent: false,
      }),
      Appointment.countDocuments({
        shop: shopId,
        date: { $gte: today, $lt: tomorrow },
        status: 'completed',
      }),
    ]);

    return { todayCount, upcomingCount, completedToday };
  }

  /**
   * Get appointments for a specific provider on a specific date (for availability check)
   */
  async getProviderSchedule(shopId, providerId, date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    return Appointment.find({
      shop: shopId,
      provider: providerId,
      date: { $gte: dayStart, $lte: dayEnd },
      status: { $nin: ['cancelled', 'no_show'] },
    })
      .populate('service', 'name duration')
      .populate('customer', 'name')
      .sort({ startTime: 1 })
      .lean();
  }
  /**
   * Link a completed appointment to a sale
   */
  async linkSale(shopId, appointmentId, saleId) {
    const appointment = await Appointment.findOne({ _id: appointmentId, shop: shopId });
    if (!appointment) {
      throw new AppError('Appointment not found', 'অ্যাপয়েন্টমেন্ট পাওয়া যায়নি', 404);
    }
    appointment.linkedSale = saleId;
    appointment.status = 'completed';
    await appointment.save();
    return appointment;
  }

  /**
   * Dashboard summary: total, completed, upcoming for today
   */
  async getTodaySummaryForDashboard(shopId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [total, completed] = await Promise.all([
      Appointment.countDocuments({
        shop: shopId,
        date: { $gte: today, $lt: tomorrow },
        status: { $nin: ['cancelled'] },
      }),
      Appointment.countDocuments({
        shop: shopId,
        date: { $gte: today, $lt: tomorrow },
        status: 'completed',
      }),
    ]);

    return { total, completed, upcoming: total - completed };
  }
}

module.exports = new AppointmentService();

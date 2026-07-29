const Treatment = require('../models/Treatment.model');
const { AppError } = require('../middleware/error.middleware');

class TreatmentService {
  async getTreatments(shopId, query = {}) {
    const { page = 1, limit = 20, customer, service, status, search } = query;
    const filter = { shop: shopId };
    if (customer) filter.customer = customer;
    if (service) filter.service = service;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { targetArea: { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [treatments, total] = await Promise.all([
      Treatment.find(filter)
        .populate('customer', 'name phone')
        .populate('service', 'name code duration')
        .populate('sessions.provider', 'name')
        .populate('sessions.equipment', 'name brand')
        .sort({ updatedAt: -1 })
        .skip(skip).limit(parseInt(limit)).lean(),
      Treatment.countDocuments(filter),
    ]);
    return { treatments, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } };
  }

  async getTreatment(shopId, treatmentId) {
    const treatment = await Treatment.findOne({ _id: treatmentId, shop: shopId })
      .populate('customer', 'name phone address')
      .populate('service', 'name code duration price packageSessions')
      .populate('sessions.provider', 'name phone')
      .populate('sessions.equipment', 'name brand model defaultSettings')
      .populate('linkedSale')
      .populate('createdBy', 'name');
    if (!treatment) throw new AppError('Treatment not found', 'ট্রিটমেন্ট পাওয়া যায়নি', 404);
    return treatment;
  }

  async createTreatment(shopId, data, userId) {
    const treatment = await Treatment.create({ ...data, shop: shopId, createdBy: userId });
    return treatment;
  }

  async updateTreatment(shopId, treatmentId, data) {
    const treatment = await Treatment.findOne({ _id: treatmentId, shop: shopId });
    if (!treatment) throw new AppError('Treatment not found', 'ট্রিটমেন্ট পাওয়া যায়নি', 404);
    const allowed = ['name', 'targetArea', 'totalSessions', 'status', 'sessionInterval', 'notes', 'totalCost', 'paidAmount'];
    for (const f of allowed) { if (data[f] !== undefined) treatment[f] = data[f]; }
    if (data.status === 'completed') treatment.completedDate = new Date();
    await treatment.save();
    return treatment;
  }

  async addSession(shopId, treatmentId, sessionData) {
    const treatment = await Treatment.findOne({ _id: treatmentId, shop: shopId });
    if (!treatment) throw new AppError('Treatment not found', 'ট্রিটমেন্ট পাওয়া যায়নি', 404);
    const sessionNumber = treatment.sessions.length + 1;
    treatment.sessions.push({ ...sessionData, sessionNumber });
    // Auto-complete treatment if all sessions done
    const completedCount = treatment.sessions.filter(s => s.status === 'completed').length + (sessionData.status === 'completed' ? 1 : 0);
    if (completedCount >= treatment.totalSessions) {
      treatment.status = 'completed';
      treatment.completedDate = new Date();
    }
    await treatment.save();
    return treatment;
  }

  async updateSession(shopId, treatmentId, sessionId, sessionData) {
    const treatment = await Treatment.findOne({ _id: treatmentId, shop: shopId });
    if (!treatment) throw new AppError('Treatment not found', 'ট্রিটমেন্ট পাওয়া যায়নি', 404);
    const session = treatment.sessions.id(sessionId);
    if (!session) throw new AppError('Session not found', 'সেশন পাওয়া যায়নি', 404);
    const allowed = ['date', 'provider', 'equipment', 'machineSettings', 'treatedArea', 'notes', 'clientReaction', 'status', 'beforePhotos', 'afterPhotos'];
    for (const f of allowed) { if (sessionData[f] !== undefined) session[f] = sessionData[f]; }
    if (sessionData.status === 'completed') session.completedAt = new Date();
    await treatment.save();
    return treatment;
  }

  async deleteTreatment(shopId, treatmentId) {
    const treatment = await Treatment.findOne({ _id: treatmentId, shop: shopId });
    if (!treatment) throw new AppError('Treatment not found', 'ট্রিটমেন্ট পাওয়া যায়নি', 404);
    await treatment.deleteOne();
    return { deleted: true };
  }

  async getCustomerTreatments(shopId, customerId) {
    return Treatment.find({ shop: shopId, customer: customerId })
      .populate('service', 'name code')
      .sort({ updatedAt: -1 }).lean();
  }
}

module.exports = new TreatmentService();

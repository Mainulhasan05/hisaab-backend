const Equipment = require('../models/Equipment.model');
const { AppError } = require('../middleware/error.middleware');

class EquipmentService {
  async getEquipment(shopId, query = {}) {
    const { page = 1, limit = 50, status, search } = query;
    const filter = { shop: shopId };
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } },
        { model: { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [equipment, total] = await Promise.all([
      Equipment.find(filter)
        .populate('linkedServices', 'name')
        .sort({ createdAt: -1 })
        .skip(skip).limit(parseInt(limit)).lean(),
      Equipment.countDocuments(filter),
    ]);
    return { equipment, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } };
  }

  async getOne(shopId, equipmentId) {
    const eq = await Equipment.findOne({ _id: equipmentId, shop: shopId })
      .populate('linkedServices', 'name code')
      .populate('createdBy', 'name');
    if (!eq) throw new AppError('Equipment not found', 'যন্ত্রপাতি পাওয়া যায়নি', 404);
    return eq;
  }

  async create(shopId, data, userId) {
    return Equipment.create({ ...data, shop: shopId, createdBy: userId });
  }

  async update(shopId, equipmentId, data) {
    const eq = await Equipment.findOne({ _id: equipmentId, shop: shopId });
    if (!eq) throw new AppError('Equipment not found', 'যন্ত্রপাতি পাওয়া যায়নি', 404);
    const allowed = ['name', 'brand', 'model', 'serialNumber', 'defaultSettings', 'linkedServices', 'purchaseDate', 'lastMaintenanceDate', 'nextMaintenanceDate', 'maintenanceNotes', 'status', 'isActive', 'image'];
    for (const f of allowed) { if (data[f] !== undefined) eq[f] = data[f]; }
    await eq.save();
    return eq;
  }

  async remove(shopId, equipmentId) {
    const eq = await Equipment.findOne({ _id: equipmentId, shop: shopId });
    if (!eq) throw new AppError('Equipment not found', 'যন্ত্রপাতি পাওয়া যায়নি', 404);
    eq.isActive = false;
    eq.status = 'retired';
    await eq.save();
    return eq;
  }

  async getActiveForSession(shopId) {
    return Equipment.find({ shop: shopId, isActive: true, status: 'active' })
      .select('name brand model defaultSettings')
      .sort({ name: 1 }).lean();
  }
}

module.exports = new EquipmentService();

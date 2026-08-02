const Supplier = require('../models/Supplier.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');

class SupplierService {
  // Get all suppliers with search and pagination
  async getSuppliers(shopId, options = {}) {
    const {
      page = 1,
      limit = 50,
      search,
      sortBy = 'name',
      sortOrder = 'asc',
    } = options;

    const query = { shop: shopId, isActive: true };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const sortField = ['name', 'createdAt', 'totalDue'].includes(sortBy) ? sortBy : 'name';
    const sort = { [sortField]: sortOrder === 'desc' ? -1 : 1 };

    const [suppliers, total] = await Promise.all([
      Supplier.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Supplier.countDocuments(query),
    ]);

    return {
      data: suppliers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Get single supplier
  async getSupplierById(shopId, supplierId) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
      isActive: true,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    return supplier;
  }

  // Create supplier
  async createSupplier(shopId, userId, data) {
    const { name, phone, address, notes } = data;

    // Check duplicate name
    const existing = await Supplier.findOne({
      shop: shopId,
      name: { $regex: `^${name.trim()}$`, $options: 'i' },
      isActive: true,
    });

    if (existing) {
      throw new AppError('এই নামে সরবরাহকারী আগে থেকেই আছে', 'Supplier with this name already exists', 400);
    }

    const supplier = await Supplier.create({
      shop: shopId,
      name: name.trim(),
      phone: phone?.trim(),
      address: address?.trim(),
      notes: notes?.trim(),
      createdBy: userId,
    });

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_create',
      actionBn: 'নতুন সরবরাহকারী যোগ',
      description: `Added supplier: ${supplier.name}`,
      descriptionBn: `নতুন সরবরাহকারী যোগ: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
    });

    return supplier;
  }

  // Update supplier
  async updateSupplier(shopId, userId, supplierId, data) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
      isActive: true,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    // Check duplicate name if name is being changed
    if (data.name && data.name.trim() !== supplier.name) {
      const existing = await Supplier.findOne({
        shop: shopId,
        name: { $regex: `^${data.name.trim()}$`, $options: 'i' },
        isActive: true,
        _id: { $ne: supplierId },
      });

      if (existing) {
        throw new AppError('এই নামে সরবরাহকারী আগে থেকেই আছে', 'Supplier with this name already exists', 400);
      }
    }

    const beforeData = { name: supplier.name, phone: supplier.phone };

    if (data.name) supplier.name = data.name.trim();
    if (data.phone !== undefined) supplier.phone = data.phone?.trim();
    if (data.address !== undefined) supplier.address = data.address?.trim();
    if (data.notes !== undefined) supplier.notes = data.notes?.trim();

    await supplier.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_update',
      actionBn: 'সরবরাহকারী আপডেট',
      description: `Updated supplier: ${supplier.name}`,
      descriptionBn: `সরবরাহকারী আপডেট: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
      changes: {
        before: beforeData,
        after: { name: supplier.name, phone: supplier.phone },
      },
    });

    return supplier;
  }

  // Delete supplier (soft delete)
  async deleteSupplier(shopId, userId, supplierId) {
    const supplier = await Supplier.findOne({
      _id: supplierId,
      shop: shopId,
    });

    if (!supplier) {
      throw new AppError('সরবরাহকারী পাওয়া যায়নি', 'Supplier not found', 404);
    }

    supplier.isActive = false;
    await supplier.save();

    // Audit log
    await AuditLog.create({
      shop: shopId,
      user: userId,
      action: 'supplier_delete',
      actionBn: 'সরবরাহকারী মুছে ফেলা',
      description: `Deleted supplier: ${supplier.name}`,
      descriptionBn: `সরবরাহকারী মুছে ফেলা: ${supplier.name}`,
      entity: {
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
      },
    });

    return { success: true };
  }
}

module.exports = new SupplierService();

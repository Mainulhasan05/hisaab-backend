const Service = require('../models/Service.model');
const { AppError } = require('../middleware/error.middleware');

class ServiceService {
  /**
   * Get all services for a shop with filters and pagination
   */
  async getServices(shopId, query = {}) {
    const {
      page = 1,
      limit = 50,
      search,
      category,
      isActive,
      isPackage,
      sortBy = 'sortOrder',
      sortOrder = 'asc',
    } = query;

    const filter = { shop: shopId };

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true' || isActive === true;
    }
    if (isPackage !== undefined) {
      filter.isPackage = isPackage === 'true' || isPackage === true;
    }
    if (category) {
      filter.category = category;
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [services, total] = await Promise.all([
      Service.find(filter)
        .populate('category', 'name')
        .populate('assignedProviders', 'name phone')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Service.countDocuments(filter),
    ]);

    return {
      services,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    };
  }

  /**
   * Get a single service by ID
   */
  async getService(shopId, serviceId) {
    const service = await Service.findOne({ _id: serviceId, shop: shopId })
      .populate('category', 'name')
      .populate('assignedProviders', 'name phone')
      .populate('consumables.product', 'name code sellingPrice')
      .populate('createdBy', 'name');

    if (!service) {
      throw new AppError('Service not found', 'সেবা পাওয়া যায়নি', 404);
    }
    return service;
  }

  /**
   * Create a new service
   */
  async createService(shopId, data, userId) {
    const serviceData = {
      ...data,
      shop: shopId,
      createdBy: userId,
    };

    const service = await Service.create(serviceData);
    return service;
  }

  /**
   * Update a service
   */
  async updateService(shopId, serviceId, data) {
    const service = await Service.findOne({ _id: serviceId, shop: shopId });
    if (!service) {
      throw new AppError('Service not found', 'সেবা পাওয়া যায়নি', 404);
    }

    // Update allowed fields
    const allowedFields = [
      'name', 'description', 'category', 'duration', 'price', 'memberPrice',
      'isPackage', 'packageSessions', 'packagePrice', 'consumables',
      'assignedProviders', 'images', 'isActive', 'sortOrder'
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        service[field] = data[field];
      }
    }

    await service.save();
    return service;
  }

  /**
   * Delete a service (soft delete by setting isActive: false)
   */
  async deleteService(shopId, serviceId) {
    const service = await Service.findOne({ _id: serviceId, shop: shopId });
    if (!service) {
      throw new AppError('Service not found', 'সেবা পাওয়া যায়নি', 404);
    }

    // Soft delete
    service.isActive = false;
    await service.save();
    return service;
  }

  /**
   * Toggle service active status
   */
  async toggleStatus(shopId, serviceId) {
    const service = await Service.findOne({ _id: serviceId, shop: shopId });
    if (!service) {
      throw new AppError('Service not found', 'সেবা পাওয়া যায়নি', 404);
    }

    service.isActive = !service.isActive;
    await service.save();
    return service;
  }

  /**
   * Get services for POS/billing (active only, minimal fields)
   */
  async getServicesForBilling(shopId, search) {
    const filter = { shop: shopId, isActive: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    return Service.find(filter)
      .select('name code price memberPrice duration isPackage packageSessions packagePrice category')
      .populate('category', 'name')
      .sort({ sortOrder: 1 })
      .limit(50)
      .lean();
  }
}

module.exports = new ServiceService();

/**
 * Admin Seeder
 * Seeds the default super admin account
 */

const Admin = require('../models/Admin.model');
const { ADMIN_ROLES } = require('../config/constants');
const logger = require('../utils/logger.util');

// Default super admin credentials
// IMPORTANT: Change these in production via environment variables
const DEFAULT_SUPER_ADMIN = {
  phone: process.env.SUPER_ADMIN_PHONE || '01700000000',
  password: process.env.SUPER_ADMIN_PASSWORD || 'Admin@123456',
  name: process.env.SUPER_ADMIN_NAME || 'Super Admin',
  email: process.env.SUPER_ADMIN_EMAIL || 'admin@hisaab.com',
  role: ADMIN_ROLES.SUPER_ADMIN
};

/**
 * Seed default super admin
 * Only creates if no super admin exists
 */
async function seedSuperAdmin() {
  try {
    // Check if any super admin exists
    const existingSuperAdmin = await Admin.findOne({ role: ADMIN_ROLES.SUPER_ADMIN });

    if (existingSuperAdmin) {
      logger.info('Super admin already exists, skipping seed');
      return { created: false, admin: existingSuperAdmin };
    }

    // Create super admin
    const admin = await Admin.create({
      phone: DEFAULT_SUPER_ADMIN.phone,
      password: DEFAULT_SUPER_ADMIN.password,
      name: DEFAULT_SUPER_ADMIN.name,
      email: DEFAULT_SUPER_ADMIN.email,
      role: DEFAULT_SUPER_ADMIN.role,
      isActive: true
    });

    logger.info(`Super admin created successfully`);
    logger.info(`Phone: ${DEFAULT_SUPER_ADMIN.phone}`);
    logger.info(`Password: ${DEFAULT_SUPER_ADMIN.password}`);
    logger.warn('IMPORTANT: Change the default password immediately in production!');

    return { created: true, admin };
  } catch (error) {
    // Handle duplicate key error (admin already exists)
    if (error.code === 11000) {
      logger.info('Super admin already exists (duplicate key)');
      return { created: false, error: 'Already exists' };
    }

    logger.error('Failed to seed super admin:', error.message);
    throw error;
  }
}

/**
 * Create an admin account (for manual use)
 */
async function createAdmin(data) {
  const { phone, password, name, email, role = ADMIN_ROLES.ADMIN, createdBy } = data;

  const admin = await Admin.create({
    phone,
    password,
    name,
    email,
    role,
    createdBy,
    isActive: true
  });

  return admin;
}

module.exports = {
  seedSuperAdmin,
  createAdmin,
  DEFAULT_SUPER_ADMIN
};

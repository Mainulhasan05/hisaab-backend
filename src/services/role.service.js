const Role = require('../models/Role.model');
const User = require('../models/User.model');
const { AppError } = require('../middleware/error.middleware');
const { ROLE_PRESETS, buildPermissions } = require('../config/permissions');

class RoleService {
  /**
   * Get all roles for a shop
   */
  async getRoles(shopId) {
    return await Role.find({ shop: shopId, isActive: true }).sort({ isDefault: -1, name: 1 });
  }

  /**
   * Get role by ID (scoped to shop)
   */
  async getRole(roleId, shopId) {
    const role = await Role.findOne({ _id: roleId, shop: shopId });
    if (!role) {
      throw new AppError('Role not found', 'ভূমিকা পাওয়া যায়নি', 404);
    }
    return role;
  }

  /**
   * Create a new role
   */
  async createRole(shopId, data) {
    const { name, permissions } = data;

    // Check uniqueness
    const existing = await Role.findOne({ shop: shopId, name: name.trim() });
    if (existing) {
      throw new AppError(
        'A role with this name already exists',
        'এই নামের ভূমিকা ইতোমধ্যে আছে',
        409
      );
    }

    const role = await Role.create({
      shop: shopId,
      name: name.trim(),
      permissions: permissions || buildPermissions(false),
      isDefault: false,
    });

    return role;
  }

  /**
   * Update a role's name and/or permissions
   */
  async updateRole(roleId, shopId, data) {
    const role = await Role.findOne({ _id: roleId, shop: shopId });
    if (!role) {
      throw new AppError('Role not found', 'ভূমিকা পাওয়া যায়নি', 404);
    }

    if (data.name !== undefined) {
      // Check uniqueness for new name
      const existing = await Role.findOne({ shop: shopId, name: data.name.trim(), _id: { $ne: roleId } });
      if (existing) {
        throw new AppError('A role with this name already exists', 'এই নামের ভূমিকা ইতোমধ্যে আছে', 409);
      }
      role.name = data.name.trim();
    }

    if (data.permissions !== undefined) {
      role.permissions = data.permissions;
    }

    await role.save();
    return role;
  }

  /**
   * Soft-delete a role
   * Blocks if any active employees are assigned to it
   */
  async deleteRole(roleId, shopId) {
    const role = await Role.findOne({ _id: roleId, shop: shopId });
    if (!role) {
      throw new AppError('Role not found', 'ভূমিকা পাওয়া যায়নি', 404);
    }

    // Check if any active users are assigned
    const assignedCount = await User.countDocuments({ shop: shopId, role: roleId, isActive: true, isOwner: false });
    if (assignedCount > 0) {
      throw new AppError(
        `Cannot delete role: ${assignedCount} active employee(s) are assigned to it`,
        `এই ভূমিকা মুছতে পারবেন না — ${assignedCount} জন কর্মচারী এই ভূমিকায় আছেন`,
        409
      );
    }

    role.isActive = false;
    await role.save();
    return { message: 'Role deleted' };
  }

  /**
   * Get available role presets
   */
  getPresets() {
    return Object.entries(ROLE_PRESETS).map(([key, preset]) => ({
      key,
      name: preset.name,
      nameEn: preset.nameEn,
      permissions: preset.permissions,
    }));
  }
}

module.exports = new RoleService();

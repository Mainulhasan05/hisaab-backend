const Role = require('../models/Role.model');
const User = require('../models/User.model');
const { AppError } = require('../middleware/error.middleware');
const {
  ROLE_PRESETS,
  PRESET_VERSION,
  buildPermissions,
  mergePermissions,
  findUnknownPermissionKeys,
  getPermissionMatrix,
} = require('../config/permissions');
const { invalidateUserAuthCache } = require('../utils/authCache.util');
const { applyPresetUpgrades } = require('../utils/rolePreset.util');

class RoleService {
  /**
   * Get all roles for a shop.
   * Self-heals: if a shop somehow has zero roles (e.g. seeding failed at
   * registration), the default presets are re-seeded here.
   */
  async getRoles(shopId) {
    let roles = await Role.find({ shop: shopId, isActive: true }).sort({ isDefault: -1, name: 1 });

    // Seed any preset this shop is missing — covers both a shop with zero roles
    // (seeding failed at registration) and shops that predate a newly added
    // preset. Roles the owner soft-deleted keep their doc, so the shop+name
    // unique index makes insertMany skip them and they stay deleted.
    const existingNames = new Set(await Role.distinct('name', { shop: shopId }));
    const missing = Object.values(ROLE_PRESETS)
      .filter((p) => !existingNames.has(p.name))
      .map((p) => ({
        shop: shopId,
        name: p.name,
        permissions: p.permissions,
        isDefault: true,
        presetVersion: PRESET_VERSION,
      }));
    if (missing.length > 0) {
      await Role.insertMany(missing, { ordered: false }).catch(() => {});
      roles = await Role.find({ shop: shopId, isActive: true }).sort({ isDefault: -1, name: 1 });
    }

    await applyPresetUpgrades(roles);

    return roles;
  }

  /**
   * Assert the client-sent permissions object has no unknown keys
   */
  _assertKnownPermissionKeys(permissions) {
    const unknown = findUnknownPermissionKeys(permissions);
    if (unknown.length > 0) {
      throw new AppError(
        `Unknown permission keys: ${unknown.join(', ')}`,
        `অজানা অনুমতি: ${unknown.join(', ')}`,
        400
      );
    }
  }

  /**
   * Flush the auth cache for every user assigned to a role, so permission
   * changes take effect on their next request instead of at next login.
   */
  async _invalidateRoleUsers(roleId, shopId) {
    const users = await User.find({ shop: shopId, role: roleId }).select('_id').lean();
    await Promise.all(users.map((u) => invalidateUserAuthCache(u._id).catch(() => {})));
  }

  /**
   * The full module × action matrix, for clients to render the roles UI from
   */
  getMatrix() {
    return getPermissionMatrix();
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

    this._assertKnownPermissionKeys(permissions);

    const role = await Role.create({
      shop: shopId,
      name: name.trim(),
      permissions: permissions
        ? mergePermissions(buildPermissions(false), permissions)
        : buildPermissions(false),
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
      this._assertKnownPermissionKeys(data.permissions);
      // Merge onto the role's current permissions: modules the client didn't
      // send stay untouched, so a stale/partial client can't wipe them.
      const current = role.permissions?.toObject ? role.permissions.toObject() : (role.permissions || {});
      role.permissions = mergePermissions(current, data.permissions);
    }

    await role.save();

    // Permissions changed → make it effective for logged-in staff now
    await this._invalidateRoleUsers(roleId, shopId);

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
    await this._invalidateRoleUsers(roleId, shopId);
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

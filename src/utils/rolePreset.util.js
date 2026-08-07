const Role = require('../models/Role.model');
const User = require('../models/User.model');
const {
  PRESET_VERSION,
  presetKeyForRoleName,
  buildPresetUpgradePatch,
} = require('../config/permissions');
const { invalidateUserAuthCache } = require('./authCache.util');

/**
 * Bring preset-derived roles up to the current PRESET_VERSION.
 *
 * Editing ROLE_PRESETS only affects newly seeded shops — every shop that
 * already exists holds its own Role documents, so a preset change is invisible
 * to them without this. Each newer revision's grants are applied once per role,
 * then the role is stamped with the version it reached, so a shop owner who
 * later narrows a default role is not overruled on the next read.
 *
 * Grants only, never revokes: an owner who widened a role keeps their edits.
 *
 * Mutates the passed documents in place so callers can return fresh data
 * without a second query. Failures are swallowed — an upgrade that can't be
 * written must never break login or the roles page.
 *
 * @param {Array} roles - Role documents (or plain objects with _id/name/permissions)
 * @returns {Promise<number>} how many roles were upgraded
 */
async function applyPresetUpgrades(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return 0;

  const pending = [];
  for (const role of roles) {
    if (!role || !role._id) continue;
    const from = role.presetVersion || 0;
    if (from >= PRESET_VERSION) continue;

    // Custom roles aren't tracked by any preset — leave them alone.
    const presetKey = presetKeyForRoleName(role.name);
    if (!presetKey) continue;

    pending.push({ role, patch: buildPresetUpgradePatch(presetKey, from) });
  }

  if (pending.length === 0) return 0;

  await Promise.all(
    pending.map(({ role, patch }) =>
      Role.updateOne(
        { _id: role._id },
        { $set: { ...(patch || {}), presetVersion: PRESET_VERSION } }
      ).catch(() => {})
    )
  );

  // Reflect the grants on the in-memory docs the caller is about to use.
  for (const { role, patch } of pending) {
    role.presetVersion = PRESET_VERSION;
    if (!patch) continue;
    for (const path of Object.keys(patch)) {
      const [, modKey, action] = path.split('.');
      if (!role.permissions) continue;
      if (!role.permissions[modKey]) role.permissions[modKey] = {};
      role.permissions[modKey][action] = true;
    }
  }

  // Staff sessions cache their resolved permissions; drop those so the new
  // grants take effect on the next request rather than after a re-login.
  const upgradedIds = pending.filter(({ patch }) => patch).map(({ role }) => role._id);
  if (upgradedIds.length > 0) {
    const affected = await User.find({ role: { $in: upgradedIds } })
      .select('_id')
      .catch(() => []);
    await Promise.all(
      affected.map((u) => invalidateUserAuthCache(u._id).catch(() => {}))
    );
  }

  return pending.length;
}

module.exports = { applyPresetUpgrades };

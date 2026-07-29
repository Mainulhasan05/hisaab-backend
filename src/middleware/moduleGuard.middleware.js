/**
 * Module Guard Middleware
 * Checks if a specific module is enabled for the requesting shop.
 * Used to restrict access to service-based features (appointments, treatments, etc.)
 * for shops that don't have those modules enabled.
 *
 * Usage in routes:
 *   router.get('/appointments', auth(), moduleGuard('appointments'), controller.list);
 */
const { AppError } = require('./error.middleware');

const moduleGuard = (moduleName) => {
  return (req, res, next) => {
    // Skip for admin requests (they don't have req.shop)
    if (req.admin) return next();

    const shop = req.shop;
    if (!shop) {
      return next(new AppError(
        'Shop context required',
        'দোকান তথ্য পাওয়া যায়নি',
        403
      ));
    }

    // If enabledModules is not set on the shop, allow by default (backward compat)
    if (!shop.enabledModules) return next();

    const isEnabled = shop.enabledModules[moduleName];

    // If the module key doesn't exist in enabledModules, allow by default
    if (isEnabled === undefined) return next();

    if (!isEnabled) {
      return next(new AppError(
        `Module '${moduleName}' is not enabled for this shop`,
        'এই ফিচারটি আপনার দোকানের জন্য সক্রিয় নয়',
        403
      ));
    }

    next();
  };
};

module.exports = moduleGuard;

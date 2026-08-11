const express = require('express');
const router = express.Router();
const brandController = require('../controllers/brand.controller');
const { protect } = require('../middleware/auth.middleware');
const { rbac } = require('../middleware/permission.middleware');
const { validate } = require('../middleware/validate.middleware');
const { requireFeature } = require('../utils/features.util');
const brandValidation = require('../validations/brand.validation');

router.use(protect);

/**
 * The whole resource is behind the capability. A shop without `brands` gets a
 * 404 on every verb, so the API cannot serve a feature the shop has not been
 * given even if a client asks for it directly.
 */
router.use(requireFeature('brands'));

/**
 * Brands ride on the CATEGORIES permission rather than carrying their own
 * module. Both are catalogue vocabulary maintained by the same person, and a
 * separate module would leave every existing custom role across every shop with
 * no brand access until its preset was upgraded — a migration bought for a
 * distinction nobody asked for.
 */
router.get('/', rbac('categories', 'view'), brandController.getBrands);
router.post('/', rbac('categories', 'create'), validate(brandValidation.createBrand), brandController.createBrand);
router.get('/:id', rbac('categories', 'view'), brandController.getBrand);
router.put('/:id', rbac('categories', 'update'), validate(brandValidation.updateBrand), brandController.updateBrand);
router.delete('/:id', rbac('categories', 'delete'), brandController.deleteBrand);

module.exports = router;

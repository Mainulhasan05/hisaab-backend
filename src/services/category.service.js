const mongoose = require('mongoose');
const Category = require('../models/Category.model');
const Product = require('../models/Product.model');
const ShopCategory = require('../models/ShopCategory.model');
const CATEGORY_SEEDS = require('../seeds/categorySeeds');
const { AppError } = require('../middleware/error.middleware');
const cacheService = require('./cache.service');
const mediaService = require('./media.service');
const { KEYS, getTTL } = require('../config/cacheKeys');
const { hasFeature } = require('../utils/features.util');

/**
 * A shopkeeper's category name goes into a RegExp for the case-insensitive
 * duplicate check, and those names are free text — "শার্ট (৪০%)" would
 * otherwise be an unbalanced group and throw a SyntaxError out of Mongoose.
 */
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CategoryService {
  /**
   * The one place that answers "does this shop already have a category called
   * X" — case-insensitively, and REGARDLESS of `isActive`.
   *
   * Both halves matter:
   *
   *   · case-insensitive, because `{shop, name}` is a byte-comparison unique
   *     index. "Shirt" and "shirt" are two rows to Mongo and one category to
   *     the person reading the dropdown, and inline creation from the product
   *     form is a machine for producing that pair.
   *
   *   · including inactive rows, because a soft-deleted category still OCCUPIES
   *     its slot in that unique index. Before this existed, deleting "মশলা" and
   *     then adding it again raised a raw E11000 that reached the user as a 500
   *     — the category page said "কিছু ভুল হয়েছে" for an action that was
   *     entirely reasonable, and nothing on screen explained why.
   */
  async _findByName(shopId, name) {
    return Category.findOne({
      shop: shopId,
      name: { $regex: `^${escapeRegex(String(name).trim())}$`, $options: 'i' },
    });
  }

  /**
   * What to do when `_findByName` hit something. Returns the same
   * `{ category, created }` shape every write path here returns.
   *
   * Three outcomes, and the middle one is the reason this is not just "return
   * the row":
   *
   *   live, same parent      → hand it back. Creating is idempotent, which is
   *                            what lets a double-tapped button and a retried
   *                            request both be harmless.
   *   live, different parent → 409 with a sentence that says where it lives.
   *                            Silently reusing it would file a subcategory
   *                            under a parent the shopkeeper never chose, and
   *                            the unique index means we cannot make a second
   *                            one either. Say so rather than guess.
   *   soft-deleted           → bring it back where the caller asked for it.
   */
  async _reuseExisting(shopId, existing, parent) {
    const samePlace = String(existing.parent || '') === String(parent || '');

    if (existing.isActive) {
      if (samePlace) return { category: existing, created: false };
      throw new AppError(
        `A category named "${existing.name}" already exists in this shop`,
        `"${existing.name}" নামে একটি ক্যাটাগরি আগে থেকেই আছে`,
        409
      );
    }

    existing.isActive = true;
    existing.parent = parent;
    await existing.save();

    // `deleteCategory` released this photo's reference on the way out, and its
    // own comment says a restore path must put it back — this is that path.
    // `reconcileRefs` raises `refCount` and clears `orphanedAt`, which is what
    // takes the image back off the reclamation clock. If the grace period had
    // already elapsed and the bytes are gone, the `updateMany` simply matches
    // nothing; the category returns without a working photo rather than the
    // whole restore failing.
    await mediaService.reconcileRefs(shopId, [], mediaService.mediaIdsOfCategory(existing));
    await this.invalidateCache(shopId);

    return { category: existing, created: true };
  }

  /**
   * Get a category with this name, wherever it already lives — creating it only
   * if nothing matches.
   *
   * The looser sibling of `createCategory`, and the difference is deliberate:
   *
   *   createCategory     "make this category HERE"  → 409 if the name is taken
   *                                                   somewhere else
   *   findOrCreateByName "give me the category called X" → takes the existing
   *                                                   one wherever it sits
   *
   * Callers who have a name and no opinion about the tree want the second. The
   * product form's inline creator is one: a shopkeeper who types "শার্ট" into
   * the category box while it already exists as a subcategory has not made a
   * mistake, they just could not see it — handing them the existing row is
   * right, and refusing would be baffling. Bulk import is the other, and it
   * used to carry its own copy of this logic (product.service.js).
   *
   * @returns {Promise<{category: Object, created: boolean}>}
   */
  async findOrCreateByName(shopId, rawName, { parent = null } = {}) {
    const name = String(rawName || '').trim();
    if (!name) {
      throw new AppError('Category name is required', 'ক্যাটাগরির নাম দিন', 400);
    }

    const existing = await this._findByName(shopId, name);
    if (existing && existing.isActive) {
      return { category: existing, created: false };
    }

    // Either nothing matched, or the match is soft-deleted and `createCategory`
    // will revive it in the requested place.
    return this.createCategory(shopId, { name, parent });
  }
  /**
   * Turn a caller-supplied `imageMediaId` into fields this service may store.
   *
   * The category form's image control is one slot, so this is the single-image
   * cousin of `product.service._applyImageRefs` and follows the same two rules:
   * the media must belong to THIS shop (`resolveOwned` 400s otherwise, which is
   * the tenant boundary), and the URL comes from the ShopMedia document rather
   * than from the client.
   *
   * Returns `null` when there is nothing to apply — either the capability is off
   * or the caller said nothing about the image — and the caller then leaves the
   * stored value alone. That is what keeps an existing photo intact when an
   * admin turns `categoryImages` off and someone renames the category.
   *
   * `{ image: null, imageMediaId: null }` is the deliberate REMOVE, reachable
   * only with the capability on.
   */
  async _resolveImage(shopId, data, req) {
    if (!hasFeature(req, 'categoryImages')) return null;

    const hasMedia = 'imageMediaId' in data;
    const hasUrl = 'image' in data;
    if (!hasMedia && !hasUrl) return null;

    if (!data.imageMediaId) {
      // Either an explicit clear, or an external URL with no media behind it.
      // Both leave `imageMediaId` null, which is what tells reclamation these
      // are not our bytes.
      return { image: hasUrl ? (data.image || null) : null, imageMediaId: null };
    }

    const owned = await mediaService.resolveOwned(shopId, [data.imageMediaId]);
    const media = owned.get(String(data.imageMediaId));
    return {
      // The medium rendition: a category tile is never rendered at full size.
      image: media.mediumUrl || media.url,
      imageMediaId: media._id,
    };
  }

  /**
   * Invalidate category cache for a shop
   */
  async invalidateCache(shopId) {
    await cacheService.delete(KEYS.CATEGORIES(shopId));
  }

  /**
   * Get all categories with subcategories for a shop
   */
  async getCategories(shopId) {
    // Try cache first
    const cacheKey = KEYS.CATEGORIES(shopId);
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const categories = await Category.getCategoriesWithSubcategories(shopId);

    // Cache the result
    await cacheService.set(cacheKey, categories, getTTL.categories);
    return categories;
  }

  /**
   * Get single category by ID
   */
  async getCategoryById(shopId, categoryId) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
      isActive: true,
    }).populate({
      path: 'subcategories',
      match: { isActive: true },
      options: { sort: { order: 1, name: 1 } },
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    return category;
  }

  /**
   * Create a category at a specific place in the tree.
   *
   * Returns `{ category, created }` rather than the bare document, because
   * "already existed" is a normal, reportable outcome here and not an error —
   * the caller shows a different sentence for it. See `_reuseExisting`.
   */
  async createCategory(shopId, data, req = null) {
    const name = String(data.name || '').trim();
    if (!name) {
      throw new AppError('Category name is required', 'ক্যাটাগরির নাম দিন', 400);
    }

    const parent = data.parent || null;

    const existing = await this._findByName(shopId, name);
    if (existing) return this._reuseExisting(shopId, existing, parent);

    const categoryData = {
      shop: shopId,
      name,
      icon: data.icon || null,
      parent,
      order: data.order || 0,
      description: data.description || '',
    };

    const image = await this._resolveImage(shopId, data, req);
    if (image) Object.assign(categoryData, image);

    let category;
    try {
      category = await Category.create(categoryData);
    } catch (error) {
      // Two requests raced past the `_findByName` above — a real possibility
      // now that a button in the product form can create categories, and the
      // shopkeeper's phone is on a network where a double-tap is a rational
      // habit. The unique index is the thing that actually decides; losing the
      // race just means re-reading the winner's row.
      if (error?.code === 11000) {
        const raced = await this._findByName(shopId, name);
        if (raced) return this._reuseExisting(shopId, raced, parent);
      }
      throw error;
    }

    // The image stops being `staged` and becomes referenced. After the write,
    // so a failed create cannot leave a reference to a category that is not
    // there. No-op when the category has no photo, which is most of them.
    await mediaService.reconcileRefs(shopId, [], mediaService.mediaIdsOfCategory(category));

    // Invalidate cache
    await this.invalidateCache(shopId);

    return { category, created: true };
  }

  /**
   * Update a category
   */
  async updateCategory(shopId, categoryId, data, req = null) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    // Read before anything is assigned — the only moment the old reference is
    // still on the document.
    const previousMediaIds = mediaService.mediaIdsOfCategory(category);

    // A rename onto a name the shop already uses hits the same unique index
    // that `createCategory` now guards, and used to surface the same raw E11000
    // as a 500. Compared against the category's own id so re-saving a category
    // without touching its name is never a collision with itself, and so is
    // fixing only the capitalisation of one.
    if (data.name !== undefined && String(data.name).trim() !== category.name) {
      const clash = await this._findByName(shopId, data.name);
      if (clash && String(clash._id) !== String(category._id)) {
        throw new AppError(
          `A category named "${clash.name}" already exists in this shop`,
          `"${clash.name}" নামে একটি ক্যাটাগরি আগে থেকেই আছে`,
          409
        );
      }
    }

    const allowed = ['name', 'icon', 'order', 'description', 'isActive'];
    allowed.forEach((field) => {
      if (data[field] !== undefined) {
        category[field] = data[field];
      }
    });

    // Not in the allowlist above on purpose: `image` and `imageMediaId` must
    // move together and only through the resolver, or a client could set the URL
    // without the id and store an unaccounted-for photo that looks like ours.
    const image = await this._resolveImage(shopId, data, req);
    if (image) {
      category.image = image.image;
      category.imageMediaId = image.imageMediaId;
    }

    await category.save();

    await mediaService.reconcileRefs(
      shopId,
      previousMediaIds,
      mediaService.mediaIdsOfCategory(category)
    );

    // Invalidate cache
    await this.invalidateCache(shopId);

    return category;
  }

  /**
   * Delete a category (soft delete)
   */
  async deleteCategory(shopId, categoryId) {
    const category = await Category.findOne({
      _id: categoryId,
      shop: shopId,
    });

    if (!category) {
      throw new AppError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি', 404);
    }

    // Every category this delete will take down — this one and, because the
    // updateMany below deactivates them, its subcategories.
    const subcategories = await Category.find({ parent: categoryId, shop: shopId })
      .select('imageMediaId')
      .lean();

    /**
     * Is anything still filed under here?
     *
     * ⚠️ THE SUBTREE, NOT JUST THIS ROW. This used to count only products
     * pointing AT `categoryId`, which let a parent holding no products of its
     * own be deleted while its subcategories held hundreds — and the
     * `updateMany` five lines down then deactivated those subcategories too.
     * The products survived, but every one of them pointed at a category no
     * screen would ever show again: gone from the category filter, gone from
     * the storefront, and unfixable in bulk because the shop could no longer
     * see the category to rename it. The guard read as if it covered this
     * (`$or` on both fields) while covering only half of it.
     *
     * `isDeleted` rather than `isActive` is the second half of the same fix.
     * A product the shop has merely switched OFF is still their product with
     * still-real stock behind it; it comes back the moment they switch it on,
     * and it should not have lost its category in the meantime.
     */
    const subtreeIds = [categoryId, ...subcategories.map((sub) => sub._id)];
    const productCount = await Product.countDocuments({
      shop: shopId,
      $or: [{ category: { $in: subtreeIds } }, { subcategory: { $in: subtreeIds } }],
      isDeleted: { $ne: true },
    });

    if (productCount > 0) {
      throw new AppError(
        'Cannot delete category with products',
        `এই ক্যাটাগরিতে ${productCount}টি পণ্য আছে, মুছে ফেলা যাবে না`,
        400
      );
    }

    await Category.updateMany(
      { parent: categoryId, shop: shopId },
      { isActive: false }
    );

    const previousMediaIds = [
      ...mediaService.mediaIdsOfCategory(category),
      ...subcategories.flatMap((sub) => mediaService.mediaIdsOfCategory(sub)),
    ];

    category.isActive = false;
    await category.save();

    // Release the photos so the orphan clock can start. Nothing else ever does:
    // `getCategories` only returns `isActive: true`, so a deleted category is
    // invisible to every screen and its image would otherwise sit in the shop's
    // quota forever.
    //
    // ⚠️ This is the one place where "delete" and "deactivate" being the SAME
    // flag matters. There is no UI that lists inactive categories, so nothing can
    // resurrect one and find its image reclaimed. If a "restore category" screen
    // is ever added, it must re-attach these references — or, better, give
    // Category a real `isDeleted` field so the two states stop sharing one flag.
    //
    // ONE restore path now exists: re-adding a category by the same name finds
    // the soft-deleted row and revives it (`_reuseExisting`), and it does
    // re-attach, as instructed above. Note it revives ONLY the row itself — the
    // subcategories deactivated here stay down, because reviving them would
    // re-reference photos this line has already released without anything
    // having asked for them back.
    await mediaService.reconcileRefs(shopId, previousMediaIds, []);

    // Invalidate cache
    await this.invalidateCache(shopId);
  }

  // ── Suggested categories (opt-in, replaces signup auto-seeding) ────────────
  //
  // The seed lists are good data — a curated grocery taxonomy genuinely helps
  // a shop that wants one. What was wrong was applying it unasked at
  // registration: a grocery signup got 85 rows, a cosmetics one 78, and roughly
  // eight in ten of them never held a product for the life of the account. The
  // shopkeeper's first screen was a required dropdown holding sixty-three names
  // they had not chosen and mostly did not stock.
  //
  // So the same data now arrives here, on request, parents-first, after they
  // have seen the app — and never as a precondition to adding their first
  // product.

  /**
   * Resolve the suggestion template for a shop type.
   *
   * Prefers the DB-backed `ShopCategory.defaultCategories` (which the admin
   * console edits) and falls back to the static seeds, matching exactly what
   * `seeds/categorySeeder.js` did at registration — the source of truth for
   * "what would we have suggested" must not fork now that the timing changed.
   */
  async _resolveTemplate(shopType) {
    const key = shopType || 'other';

    try {
      const dbShopCat = await ShopCategory.findOne({ key })
        .select('defaultCategories')
        .lean();
      if (dbShopCat?.defaultCategories?.length > 0) return dbShopCat.defaultCategories;
    } catch (error) {
      console.error('Error fetching shop category template:', error.message);
    }

    return CATEGORY_SEEDS[key] || [];
  }

  /**
   * The suggestion list for this shop, each entry flagged with whether the shop
   * already has a category by that name.
   *
   * `exists` is what makes the panel re-runnable: a cloth shop that starts
   * stocking cosmetics next year opens it again and sees seven fresh
   * suggestions and one already-added, rather than a list that would silently
   * do nothing.
   */
  async getSuggestions(shop) {
    // `shop.type`, NOT `shop.shopType`. The registration payload calls it
    // `shopType` and `Shop.create` maps it onto `type`; reading the payload's
    // name off the document silently yields undefined, falls through to the
    // 'other' template, and hands every shop the same ten generic categories
    // while looking like it worked. (`metaCapi.service.js` has this exact bug.)
    const template = await this._resolveTemplate(shop?.type);

    const owned = await Category.find({ shop: shop._id, isActive: true })
      .select('name')
      .lean();
    const have = new Set(owned.map((c) => String(c.name).toLowerCase().trim()));
    const known = (name) => have.has(String(name).toLowerCase().trim());

    // `nameBn || name` mirrors the seeder. The static seeds are already Bengali
    // in `name` and the DB schema has no `nameBn` at all, so this is parity
    // insurance rather than a live branch.
    return template.map((seed) => {
      const name = seed.nameBn || seed.name;
      return {
        name,
        icon: seed.icon || null,
        order: seed.order || 0,
        exists: known(name),
        subcategories: (seed.subcategories || []).map((sub) => {
          const subName = sub.nameBn || sub.name;
          return { name: subName, order: sub.order || 0, exists: known(subName) };
        }),
      };
    });
  }

  /**
   * Create the suggestions the shopkeeper ticked.
   *
   * Idempotent by construction — every write goes through `createCategory`,
   * which returns the existing row rather than duplicating it. Applying the
   * same selection twice is a no-op, so a double-tap or a retry cannot produce
   * a second "মুদি" .
   *
   * @param {Object} shop
   * @param {Object} payload
   * @param {string[]} payload.names           parent names to create
   * @param {boolean} payload.includeSubcategories
   */
  async applyTemplate(shop, { names = [], includeSubcategories = false } = {}) {
    if (!Array.isArray(names) || names.length === 0) {
      throw new AppError(
        'Pick at least one category',
        'অন্তত একটি ক্যাটাগরি বাছাই করুন',
        400
      );
    }

    const template = await this.getSuggestions(shop);
    const wanted = new Set(names.map((n) => String(n).toLowerCase().trim()));

    const result = { categories: 0, subcategories: 0, skipped: 0 };

    for (const suggestion of template) {
      if (!wanted.has(suggestion.name.toLowerCase().trim())) continue;

      const parent = await this._applyOne(shop._id, {
        name: suggestion.name,
        icon: suggestion.icon,
        order: suggestion.order,
        parent: null,
      });

      if (!parent.category) {
        result.skipped += 1;
        continue;
      }
      if (parent.created) result.categories += 1;

      if (!includeSubcategories) continue;

      for (const sub of suggestion.subcategories) {
        const child = await this._applyOne(shop._id, {
          name: sub.name,
          order: sub.order,
          parent: parent.category._id,
        });
        if (!child.category) result.skipped += 1;
        else if (child.created) result.subcategories += 1;
      }
    }

    return result;
  }

  /**
   * One template row, where "the shop already uses this name somewhere else" is
   * an ordinary skip rather than a failure.
   *
   * Without this, a single collision — a shop that hand-made "শার্ট" as a
   * top-level category before opening the panel — would 409 the whole batch and
   * lose the other eleven categories the shopkeeper ticked.
   */
  async _applyOne(shopId, data) {
    try {
      return await this.createCategory(shopId, data);
    } catch (error) {
      if (error?.statusCode === 409) return { category: null, created: false };
      throw error;
    }
  }

  // ── Tidy-up (for shops that were auto-seeded before this changed) ──────────

  /**
   * Every active category with a live product count, so the tidy-up screen can
   * show what is safe to remove.
   *
   * ⚠️ Counted from `Product`, NOT from the stored `Category.productCount`.
   * That field is maintained incrementally by `updateProductCount`, which means
   * it is exactly the kind of derived counter that drifts — this app already
   * has two open drift bugs of that shape. A stale zero here would pre-tick a
   * category holding stock, and the shopkeeper would confirm a screen that told
   * them it was empty.
   *
   * A parent reports its whole subtree, so a parent with no products of its own
   * but a busy subcategory reads as in-use — the same rule `deleteCategory`
   * enforces, computed the same way, because a tidy-up that offers a row the
   * delete will refuse is just a broken screen.
   */
  async getUsage(shopId) {
    const categories = await Category.find({ shop: shopId, isActive: true })
      .select('name icon parent order')
      .sort({ order: 1, name: 1 })
      .lean();

    const counts = await Product.aggregate([
      { $match: { shop: new mongoose.Types.ObjectId(String(shopId)), isDeleted: { $ne: true } } },
      {
        $project: {
          ids: {
            $setUnion: [
              { $cond: [{ $ifNull: ['$category', false] }, ['$category'], []] },
              { $cond: [{ $ifNull: ['$subcategory', false] }, ['$subcategory'], []] },
            ],
          },
        },
      },
      { $unwind: '$ids' },
      { $group: { _id: '$ids', n: { $sum: 1 } } },
    ]);

    const direct = new Map(counts.map((row) => [String(row._id), row.n]));
    const childrenOf = new Map();
    for (const cat of categories) {
      if (!cat.parent) continue;
      const key = String(cat.parent);
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(cat);
    }

    return categories
      .filter((cat) => !cat.parent)
      .map((cat) => {
        const children = (childrenOf.get(String(cat._id)) || []).map((sub) => ({
          _id: sub._id,
          name: sub.name,
          productCount: direct.get(String(sub._id)) || 0,
        }));
        const own = direct.get(String(cat._id)) || 0;
        const total = own + children.reduce((sum, sub) => sum + sub.productCount, 0);

        return {
          _id: cat._id,
          name: cat.name,
          icon: cat.icon || null,
          productCount: own,
          subtreeProductCount: total,
          subcategories: children,
        };
      });
  }

  /**
   * Soft-delete several categories in one confirmed action.
   *
   * Every id goes through `deleteCategory`, so the "has products" guard, the
   * subcategory cascade and the photo release are the same code the single
   * delete uses — a bulk path with its own copy of those rules is a bulk path
   * that will eventually disagree with them.
   *
   * Partial success is reported, not thrown. If two of forty rows gained a
   * product between the screen loading and the button being pressed, removing
   * the other thirty-eight is still what the shopkeeper asked for; the two come
   * back named so they can see why.
   */
  async bulkDelete(shopId, ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError(
        'Pick at least one category',
        'অন্তত একটি ক্যাটাগরি বাছাই করুন',
        400
      );
    }

    if (ids.length > 200) {
      throw new AppError(
        'Too many categories at once',
        'একবারে সর্বোচ্চ ২০০টি ক্যাটাগরি মুছে ফেলা যাবে',
        400
      );
    }

    const result = { deleted: 0, failed: [] };

    for (const id of ids) {
      try {
        await this.deleteCategory(shopId, id);
        result.deleted += 1;
      } catch (error) {
        const category = await Category.findOne({ _id: id, shop: shopId })
          .select('name')
          .lean()
          .catch(() => null);
        result.failed.push({
          _id: id,
          name: category?.name || null,
          reason: error?.messageBn || error?.message || 'মুছে ফেলা যায়নি',
        });
      }
    }

    return result;
  }
}

module.exports = new CategoryService();

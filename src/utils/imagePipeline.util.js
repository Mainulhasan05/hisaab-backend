/**
 * Decode an uploaded image once, resize it into the stored renditions.
 *
 * Extracted from `media.service` when the platform media library
 * (MEDIA_GALLERY_PLAN.md) became a second caller. There must be exactly one
 * place that decides how an image is stored: two copies of these numbers would
 * drift, and the drift would show up as a shop's thumbnails and the admin
 * library's thumbnails being subtly different sizes for no reason anyone could
 * name.
 *
 * This module knows nothing about shops, quotas, buckets or documents. Bytes in,
 * buffers out.
 */

const { AppError } = require('../middleware/error.middleware');
const logger = require('./logger.util');

// Loaded defensively, and treated as fatal rather than degraded. Without sharp
// we cannot resize, cannot make renditions, and would be storing a 4MB camera
// JPEG under a name claiming to be a 200KB WebP. That is a 503, not a fallback.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  logger.warn('sharp is not available — R2 image uploads will be refused with 503');
}

/**
 * The renditions, widest first.
 *
 * `original` is a cap rather than a size: a client-compressed 1200px photo is
 * stored at 1200px, not upscaled. 1600 is the point past which a product photo
 * stops looking better on any phone screen and starts only costing money.
 *
 * Quality drops with size on purpose — WebP artefacts that are visible at full
 * size are invisible at 200px, and the thumbnail is the rendition that gets
 * fetched dozens of times per screen.
 */
const RENDITIONS = Object.freeze([
  { name: 'original', maxDim: 1600, quality: 80, suffix: '' },
  { name: 'medium', maxDim: 600, quality: 75, suffix: '_m' },
  { name: 'thumb', maxDim: 200, quality: 70, suffix: '_t' },
]);

// A guard against a decompression bomb — a 100MB PNG that is 200x200 of solid
// colour, or a crafted image whose declared dimensions would allocate gigabytes
// in sharp's pixel buffer. Multer's file cap does not protect against this
// because the danger is in the DECODED size.
const MAX_PIXELS = 50_000_000; // 50MP

const CONTENT_TYPE = 'image/webp';

/** Whether image processing can be attempted at all. */
function isAvailable() {
  return Boolean(sharp);
}

/** The 503 every caller owes the user when sharp is missing. */
function assertAvailable() {
  if (!sharp) {
    throw new AppError(
      'Image processing is unavailable on this server (sharp failed to load)',
      'সার্ভারে ছবি প্রসেসিং সুবিধা নেই — অ্যাডমিনের সাথে যোগাযোগ করুন',
      503
    );
  }
}

/**
 * Decode once, resize three times.
 *
 * `.rotate()` with no argument applies the EXIF orientation tag and then drops
 * it — which is both the "EXIF strip" half of the plan and the fix for photos
 * that appear sideways only on some devices. sharp writes no metadata unless
 * asked, so GPS coordinates in a photo do not reach a public bucket.
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array<{name, suffix, buffer, width, height}>>}
 */
async function renderAll(buffer) {
  assertAvailable();

  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    throw new AppError(
      `Unreadable image: ${err.message}`,
      'ছবিটি পড়া যায়নি — অন্য একটি ছবি চেষ্টা করুন',
      400
    );
  }

  if (!meta?.width || !meta?.height) {
    throw new AppError(
      'Unreadable image: no dimensions',
      'ছবিটি পড়া যায়নি — অন্য একটি ছবি চেষ্টা করুন',
      400
    );
  }

  if (meta.width * meta.height > MAX_PIXELS) {
    throw new AppError(
      `Image is ${meta.width}x${meta.height}, over the ${MAX_PIXELS / 1_000_000}MP limit`,
      'ছবিটি অনেক বড় — ছোট করে আবার চেষ্টা করুন',
      400
    );
  }

  const out = [];
  for (const spec of RENDITIONS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data, info } = await sharp(buffer)
        .rotate()
        .resize({
          width: spec.maxDim,
          height: spec.maxDim,
          fit: 'inside',
          // A 200px photo must not be blown up to 1600px: it would look worse
          // AND cost more bytes than the file we were given.
          withoutEnlargement: true,
        })
        .webp({ quality: spec.quality })
        .toBuffer({ resolveWithObject: true });

      out.push({
        name: spec.name,
        suffix: spec.suffix,
        buffer: data,
        width: info.width,
        height: info.height,
      });
    } catch (err) {
      throw new AppError(
        `Could not process image (${spec.name}): ${err.message}`,
        'ছবিটি প্রসেস করা যায়নি — অন্য একটি ছবি চেষ্টা করুন',
        400
      );
    }
  }

  return out;
}

module.exports = {
  RENDITIONS,
  MAX_PIXELS,
  CONTENT_TYPE,
  isAvailable,
  assertAvailable,
  renderAll,
};

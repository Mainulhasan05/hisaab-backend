const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { AppError } = require('../middleware/error.middleware');
const logger = require('../utils/logger.util');

// Safely attempt to load sharp if available
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  logger.warn('sharp library is not installed or failed to load. Image conversion will fallback to raw buffers.');
}

class ImageUploadService {
  constructor() {
    this.apiUrl = 'https://api.imgbb.com/1/upload';
  }

  /**
   * Check if ImgBB upload service is configured with API key
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(process.env.IMGBB_API_KEY);
  }

  /**
   * Convert image buffer to WebP format at quality: 80 using sharp.
   * Skips GIF (to preserve animation) and image/webp.
   * Fallback to original buffer if sharp fails or is missing.
   * @param {Buffer} buffer 
   * @param {string} filename 
   * @param {string} mimetype 
   * @returns {Promise<{ buffer: Buffer, filename: string, mimetype: string }>}
   */
  async convertToWebP(buffer, filename = 'image.png', mimetype = 'image/png') {
    // Skip GIF and WebP
    if (mimetype === 'image/gif' || mimetype === 'image/webp') {
      return { buffer, filename, mimetype };
    }

    if (!sharp) {
      return { buffer, filename, mimetype };
    }

    try {
      const webpBuffer = await sharp(buffer)
        .webp({ quality: 80 })
        .toBuffer();

      const newFilename = filename ? filename.replace(/\.[^/.]+$/, '') + '.webp' : 'image.webp';
      return {
        buffer: webpBuffer,
        filename: newFilename,
        mimetype: 'image/webp',
      };
    } catch (error) {
      logger.warn(`WebP conversion failed for ${filename}: ${error.message}. Using original buffer.`);
      return { buffer, filename, mimetype };
    }
  }

  /**
   * Normalize response payload from Official ImgBB API
   * @param {Object} data Raw API response data
   * @returns {Object} Standardized image payload
   */
  normalizeResponse(data) {
    const img = data.data || {};
    return {
      success: true,
      id: img.id || '',
      title: img.title || img.filename || '',
      url: img.url || img.display_url || '',
      displayUrl: img.display_url || img.url || '',
      thumbnail: img.thumb?.url || img.display_url || img.url || '',
      medium: img.medium?.url || img.display_url || img.url || '',
      deleteUrl: img.delete_url || '',
      width: img.width || 0,
      height: img.height || 0,
      size: img.size || 0,
      mime: img.image?.mime || 'image/png',
      extension: img.image?.extension || 'png',
    };
  }

  /**
   * Perform raw HTTP upload request to ImgBB API key endpoint with 3-minute default timeout handling
   * @param {string} payload base64 string or URL
   * @param {string} filename 
   * @param {string} type 'base64' | 'url'
   * @returns {Promise<Object>} Standardized response payload
   */
  async _dispatchUpload(payload, filename = '', type = 'base64') {
    if (!this.isConfigured()) {
      throw new AppError(
        'ImgBB image upload service is not configured. Please set IMGBB_API_KEY in environment variables.',
        'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
        503
      );
    }

    // Default timeout set to 180,000ms (3 minutes) to allow large image uploads and Sharp processing
    const timeout = parseInt(process.env.IMGBB_UPLOAD_TIMEOUT_MS, 10) || 180000;
    const apiKey = process.env.IMGBB_API_KEY;

    try {
      const formData = new FormData();
      formData.append('image', payload);
      if (filename) {
        formData.append('name', filename.replace(/\.[^/.]+$/, ''));
      }

      const response = await axios.post(
        `${this.apiUrl}?key=${apiKey}`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout,
        }
      );

      if (response.data && response.data.success) {
        return this.normalizeResponse(response.data);
      }
      throw new Error(response.data?.error?.message || 'ImgBB API upload failed');
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        const minutes = Math.round(timeout / 60000);
        throw new AppError(
          `ImgBB upload timed out after ${minutes} minute(s). Please try again.`,
          `ইমেজ আপলোড নির্দিষ্ট সময়ের (${minutes} মিনিট) মধ্যে শেষ হয়নি`,
          504
        );
      }

      const errorMessage =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Failed to upload image to ImgBB';

      logger.error(`ImgBB Upload Error: ${errorMessage}`);
      throw new AppError(
        `Image upload failed: ${errorMessage}`,
        `ইমেজ আপলোড ব্যর্থ হয়েছে: ${errorMessage}`,
        500
      );
    }
  }

  /**
   * Upload image from Buffer
   * @param {Buffer} buffer 
   * @param {string} filename 
   * @param {Object} options { mimetype, skipWebP }
   */
  async uploadFromBuffer(buffer, filename = 'image.png', options = {}) {
    const mimetype = options.mimetype || 'image/png';
    let targetBuffer = buffer;
    let targetFilename = filename;

    if (!options.skipWebP) {
      const converted = await this.convertToWebP(buffer, filename, mimetype);
      targetBuffer = converted.buffer;
      targetFilename = converted.filename;
    }

    const base64String = targetBuffer.toString('base64');
    return await this._dispatchUpload(base64String, targetFilename, 'base64');
  }

  /**
   * Upload image from Base64 string
   * @param {string} base64String 
   * @param {string} filename 
   * @param {Object} options 
   */
  async uploadFromBase64(base64String, filename = 'image.png', options = {}) {
    if (!base64String || typeof base64String !== 'string') {
      throw new AppError('Invalid Base64 string provided', 'অবৈধ বেস৬৪ ইমেজ ডাটা', 400);
    }

    // Extract mime type if header present
    let mimetype = options.mimetype || 'image/png';
    const mimeMatch = base64String.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
    if (mimeMatch) {
      mimetype = mimeMatch[1];
    }

    // Strip prefix
    const cleanBase64 = base64String.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').trim();
    const buffer = Buffer.from(cleanBase64, 'base64');

    return await this.uploadFromBuffer(buffer, filename, { ...options, mimetype });
  }

  /**
   * Upload image from remote URL
   * @param {string} imageUrl 
   * @param {Object} options 
   */
  async uploadFromUrl(imageUrl, options = {}) {
    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
      throw new AppError('Invalid image URL provided', 'অবৈধ ইমেজ ইউআরএল', 400);
    }

    return await this._dispatchUpload(imageUrl, options.filename || 'remote-image', 'url');
  }

  /**
   * Upload image from Multer file object (supports memory & disk storage)
   * @param {Object} file Express.Multer.File object
   * @param {Object} options { deleteAfterUpload: boolean }
   */
  async uploadFromMulter(file, options = {}) {
    if (!file) {
      throw new AppError('No file provided for upload', 'কোন ফাইল পাওয়া যায়নি', 400);
    }

    let buffer = file.buffer;
    const deleteAfterUpload = options.deleteAfterUpload !== false; // Default true for temp files

    try {
      // If disk storage was used, read file into buffer
      if (!buffer && file.path) {
        buffer = await fs.promises.readFile(file.path);
      }

      if (!buffer) {
        throw new AppError('Could not read file buffer', 'ফাইল ডাটা পড়া যায়নি', 400);
      }

      const result = await this.uploadFromBuffer(
        buffer,
        file.originalname || 'upload.png',
        { mimetype: file.mimetype, ...options }
      );

      return result;
    } finally {
      // Clean up temp file on disk if present
      if (file.path && deleteAfterUpload) {
        fs.promises.unlink(file.path).catch((err) => {
          logger.warn(`Failed to clean up temp file ${file.path}: ${err.message}`);
        });
      }
    }
  }
}

module.exports = new ImageUploadService();

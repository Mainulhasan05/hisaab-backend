const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const { AppError } = require('../middleware/error.middleware');

const IMGBB_JSON_URL = 'https://imgbb.com/json';
const IMGBB_OFFICIAL_API_URL = 'https://api.imgbb.com/1/upload';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SIZE = 32 * 1024 * 1024;
const DEFAULT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

class ImageService {
  getCredentials() {
    const apiKey = process.env.IMGBB_API_KEY;
    const authToken = process.env.IMGBB_AUTH_TOKEN;

    if (!apiKey && !authToken) {
      throw new AppError(
        'Image upload service is not configured',
        'ইমেজ আপলোড সার্ভিস কনফিগার করা হয়নি',
        503
      );
    }

    return { apiKey, authToken, useOfficialApi: Boolean(apiKey) };
  }

  isConfigured() {
    return Boolean(process.env.IMGBB_API_KEY || process.env.IMGBB_AUTH_TOKEN);
  }

  getUploadConfig() {
    return {
      provider: 'imgbb',
      configured: this.isConfigured(),
      maxSize: this.getMaxSize(),
      allowedTypes: this.getAllowedTypes(),
    };
  }

  getMaxSize() {
    const envSize = Number(process.env.IMAGE_UPLOAD_MAX_SIZE);
    return Number.isFinite(envSize) && envSize > 0 ? envSize : DEFAULT_MAX_SIZE;
  }

  getAllowedTypes() {
    return process.env.IMAGE_UPLOAD_ALLOWED_TYPES
      ? process.env.IMAGE_UPLOAD_ALLOWED_TYPES.split(',').map((type) => type.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_TYPES;
  }

  generateTimestamp() {
    return Math.floor(Date.now() / 1000).toString();
  }

  validateImage(file, options = {}) {
    const maxSize = options.maxSize || this.getMaxSize();
    const allowedTypes = options.allowedTypes || this.getAllowedTypes();

    if (!file) {
      throw new AppError('No image file provided', 'কোনো ইমেজ ফাইল দেওয়া হয়নি', 400);
    }

    const fileSize = file.size || (file.buffer ? file.buffer.length : 0);
    if (fileSize > maxSize) {
      throw new AppError(
        `File too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB`,
        `ফাইল খুব বড়। সর্বোচ্চ সাইজ ${Math.round(maxSize / 1024 / 1024)}MB`,
        413
      );
    }

    const mimeType = file.mimetype || file.type || options.mimeType;
    if (mimeType && !allowedTypes.includes(mimeType)) {
      throw new AppError(
        `Invalid file type. Allowed: ${allowedTypes.join(', ')}`,
        'অবৈধ ফাইল টাইপ',
        415
      );
    }

    return true;
  }

  async uploadFromPath(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new AppError(`File not found: ${filePath}`, 'ফাইল পাওয়া যায়নি', 404);
    }

    const result = await this.uploadWithClient(async (credentials) => {
      if (credentials.useOfficialApi) {
        const buffer = fs.readFileSync(filePath);
        return this.uploadOfficial(buffer.toString('base64'), path.parse(filePath).name, options, credentials.apiKey);
      }

      const formData = this.createLegacyForm(options);
      formData.append('source', fs.createReadStream(filePath));
      formData.append('type', 'file');
      return axios.post(IMGBB_JSON_URL, formData, this.getAxiosConfig(formData));
    });

    return this.parseResponse(result.data);
  }

  async uploadFromBuffer(buffer, filename = 'image.jpg', options = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new AppError('Invalid image buffer', 'অবৈধ ইমেজ ডেটা', 400);
    }

    this.validateImage({
      buffer,
      originalname: filename,
      mimetype: options.mimeType,
      size: buffer.length,
    }, options);

    const result = await this.uploadWithClient(async (credentials) => {
      if (credentials.useOfficialApi) {
        return this.uploadOfficial(buffer.toString('base64'), path.parse(filename).name, options, credentials.apiKey);
      }

      const formData = this.createLegacyForm(options);
      formData.append('source', buffer, {
        filename,
        contentType: options.mimeType || 'image/jpeg',
      });
      formData.append('type', 'file');
      return axios.post(IMGBB_JSON_URL, formData, this.getAxiosConfig(formData));
    });

    return this.parseResponse(result.data);
  }

  async uploadFromBase64(base64String, filename = 'image.jpg', options = {}) {
    if (!base64String || typeof base64String !== 'string') {
      throw new AppError('Base64 image is required', 'Base64 ইমেজ প্রয়োজন', 400);
    }

    const cleanBase64 = base64String.includes(',') ? base64String.split(',')[1] : base64String;
    return this.uploadFromBuffer(Buffer.from(cleanBase64, 'base64'), filename, options);
  }

  async uploadFromUrl(imageUrl, options = {}) {
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new AppError('Image URL is required', 'ইমেজ URL প্রয়োজন', 400);
    }

    const result = await this.uploadWithClient(async (credentials) => {
      if (credentials.useOfficialApi) {
        return this.uploadOfficial(imageUrl, null, options, credentials.apiKey);
      }

      const formData = this.createLegacyForm(options);
      formData.append('source', imageUrl);
      formData.append('type', 'url');
      return axios.post(IMGBB_JSON_URL, formData, this.getAxiosConfig(formData));
    });

    return this.parseResponse(result.data);
  }

  async uploadFromMulter(file, options = {}) {
    if (!file) {
      throw new AppError('No image file provided', 'কোনো ইমেজ ফাইল দেওয়া হয়নি', 400);
    }

    this.validateImage(file, options);

    if (file.buffer) {
      return this.uploadFromBuffer(file.buffer, file.originalname, {
        ...options,
        mimeType: file.mimetype,
      });
    }

    if (file.path) {
      try {
        return await this.uploadFromPath(file.path, options);
      } finally {
        if (options.deleteAfterUpload !== false) {
          fs.promises.unlink(file.path).catch(() => {});
        }
      }
    }

    throw new AppError('Invalid image file object', 'অবৈধ ইমেজ ফাইল', 400);
  }

  async uploadManyFromMulter(files = [], options = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new AppError('No image files provided', 'কোনো ইমেজ ফাইল দেওয়া হয়নি', 400);
    }

    return Promise.all(files.map((file) => this.uploadFromMulter(file, options)));
  }

  async uploadOfficial(image, name, options, apiKey) {
    const formData = new FormData();
    formData.append('image', image);
    if (name) formData.append('name', name);
    if (options.expiration) formData.append('expiration', options.expiration.toString());

    return axios.post(`${IMGBB_OFFICIAL_API_URL}?key=${apiKey}`, formData, this.getAxiosConfig(formData));
  }

  createLegacyForm(options) {
    const credentials = this.getCredentials();
    const formData = new FormData();

    formData.append('action', 'upload');
    formData.append('timestamp', this.generateTimestamp());
    formData.append('auth_token', credentials.authToken);
    if (options.expiration) formData.append('expiration', options.expiration.toString());

    return formData;
  }

  getAxiosConfig(formData) {
    return {
      headers: formData.getHeaders(),
      timeout: DEFAULT_TIMEOUT_MS,
    };
  }

  async uploadWithClient(callback) {
    try {
      return await callback(this.getCredentials());
    } catch (error) {
      throw this.handleError(error);
    }
  }

  parseResponse(data) {
    if (data.status_code === 200 || data.success) {
      const image = data.data || data.image || data;

      return {
        success: true,
        url: image.url || image.display_url,
        displayUrl: image.display_url || image.url,
        thumbnail: image.thumb?.url || image.thumbnail?.url,
        medium: image.medium?.url,
        deleteUrl: image.delete_url || data.delete_url,
        id: image.id || data.id,
        title: image.title || image.name,
        width: image.width,
        height: image.height,
        size: image.size,
        mime: image.mime || image.type,
        extension: image.extension,
        raw: data,
      };
    }

    throw new AppError(
      data.error?.message || data.message || 'Image upload failed',
      'ইমেজ আপলোড ব্যর্থ হয়েছে',
      502
    );
  }

  handleError(error) {
    if (error.isOperational) {
      return error;
    }

    if (error.response) {
      const data = error.response.data;
      const message = data?.error?.message || data?.message || 'Image upload failed';
      return new AppError(`Image upload failed: ${message}`, 'ইমেজ আপলোড ব্যর্থ হয়েছে', 502);
    }

    if (error.code === 'ECONNABORTED') {
      return new AppError('Image upload timed out. Please try again.', 'ইমেজ আপলোড টাইম আউট হয়েছে', 504);
    }

    return new AppError(error.message || 'Image upload failed', 'ইমেজ আপলোড ব্যর্থ হয়েছে', 500);
  }
}

module.exports = new ImageService();

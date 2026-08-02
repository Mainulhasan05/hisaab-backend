const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const { AppError } = require('../middleware/error.middleware');

const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;
const DEFAULT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

class ImageService {
  getApiKey() {
    const apiKey = process.env.IMGBB_API_KEY;

    if (!apiKey) {
      throw new AppError(
        'Image upload service is not configured',
        'Image upload service is not configured',
        503
      );
    }

    return apiKey;
  }

  isConfigured() {
    return Boolean(process.env.IMGBB_API_KEY);
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

  validateImage(file, options = {}) {
    const maxSize = options.maxSize || this.getMaxSize();
    const allowedTypes = options.allowedTypes || this.getAllowedTypes();

    if (!file) {
      throw new AppError('No image file provided', 'No image file provided', 400);
    }

    const fileSize = file.size || (file.buffer ? file.buffer.length : 0);
    if (fileSize > maxSize) {
      throw new AppError(
        `File too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB`,
        `File too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB`,
        413
      );
    }

    const mimeType = file.mimetype || file.type || options.mimeType;
    if (mimeType && !allowedTypes.includes(mimeType)) {
      throw new AppError(
        `Invalid file type. Allowed: ${allowedTypes.join(', ')}`,
        `Invalid file type. Allowed: ${allowedTypes.join(', ')}`,
        415
      );
    }

    return true;
  }

  async uploadFromPath(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new AppError(`File not found: ${filePath}`, `File not found: ${filePath}`, 404);
    }

    const buffer = fs.readFileSync(filePath);
    const result = await this.uploadWithClient(
      buffer.toString('base64'),
      path.parse(filePath).name,
      options
    );

    return this.parseResponse(result.data);
  }

  async uploadFromBuffer(buffer, filename = 'image.jpg', options = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new AppError('Invalid image buffer', 'Invalid image buffer', 400);
    }

    this.validateImage({
      buffer,
      originalname: filename,
      mimetype: options.mimeType,
      size: buffer.length,
    }, options);

    const result = await this.uploadWithClient(
      buffer.toString('base64'),
      path.parse(filename).name,
      options
    );

    return this.parseResponse(result.data);
  }

  async uploadFromBase64(base64String, filename = 'image.jpg', options = {}) {
    if (!base64String || typeof base64String !== 'string') {
      throw new AppError('Base64 image is required', 'Base64 image is required', 400);
    }

    const cleanBase64 = base64String.includes(',') ? base64String.split(',')[1] : base64String;
    return this.uploadFromBuffer(Buffer.from(cleanBase64, 'base64'), filename, options);
  }

  async uploadFromUrl(imageUrl, options = {}) {
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new AppError('Image URL is required', 'Image URL is required', 400);
    }

    const result = await this.uploadWithClient(imageUrl, null, options);
    return this.parseResponse(result.data);
  }

  async uploadFromMulter(file, options = {}) {
    if (!file) {
      throw new AppError('No image file provided', 'No image file provided', 400);
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

    throw new AppError('Invalid image file object', 'Invalid image file object', 400);
  }

  async uploadManyFromMulter(files = [], options = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new AppError('No image files provided', 'No image files provided', 400);
    }

    return Promise.all(files.map((file) => this.uploadFromMulter(file, options)));
  }

  async uploadWithClient(image, name, options = {}) {
    try {
      const formData = new FormData();
      formData.append('image', image);
      if (name) formData.append('name', name);

      return await axios.post(IMGBB_UPLOAD_URL, formData, {
        headers: formData.getHeaders(),
        params: {
          key: this.getApiKey(),
          ...(options.expiration ? { expiration: options.expiration } : {}),
        },
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.handleError(error);
    }
  }

  parseResponse(data) {
    if (data.status === 200 || data.status_code === 200 || data.success) {
      const image = data.data || data.image || data;
      const imageFile = image.image || image;

      return {
        success: true,
        id: image.id || data.id,
        title: image.title || image.name,
        url: image.url || image.display_url,
        urlViewer: image.url_viewer,
        displayUrl: image.display_url || image.url,
        thumbnail: image.thumb?.url || image.thumbnail?.url,
        medium: image.medium?.url,
        deleteUrl: image.delete_url || data.delete_url,
        width: image.width,
        height: image.height,
        size: image.size,
        mime: imageFile.mime || image.mime || image.type,
        extension: imageFile.extension || image.extension,
        filename: imageFile.filename,
        raw: data,
      };
    }

    throw new AppError(
      data.error?.message || data.message || 'Image upload failed',
      'Image upload failed',
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
      return new AppError(`Image upload failed: ${message}`, 'Image upload failed', 502);
    }

    if (error.code === 'ECONNABORTED') {
      return new AppError('Image upload timed out. Please try again.', 'Image upload timed out. Please try again.', 504);
    }

    return new AppError(error.message || 'Image upload failed', 'Image upload failed', 500);
  }
}

module.exports = new ImageService();

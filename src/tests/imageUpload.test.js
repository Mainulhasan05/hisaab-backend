/**
 * Unit Test Suite for ImgBB Upload System & Integrations
 */

const imageUploadService = require('../services/imageUpload.service');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

jest.mock('axios');

describe('ImgBB Upload System', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.IMGBB_API_KEY = 'test_official_api_key';
    process.env.IMGBB_UPLOAD_TIMEOUT_MS = '180000';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Configuration Utility (isConfigured)', () => {
    it('should return true when IMGBB_API_KEY is present', () => {
      process.env.IMGBB_API_KEY = 'test_key';
      expect(imageUploadService.isConfigured()).toBe(true);
    });

    it('should return false when API key is not configured', () => {
      delete process.env.IMGBB_API_KEY;
      expect(imageUploadService.isConfigured()).toBe(false);
    });
  });

  describe('WebP Optimization (convertToWebP)', () => {
    it('should skip conversion for image/gif and image/webp mimetypes', async () => {
      const buffer = Buffer.from('fake-gif');
      const resGif = await imageUploadService.convertToWebP(buffer, 'test.gif', 'image/gif');
      expect(resGif.mimetype).toBe('image/gif');
      expect(resGif.filename).toBe('test.gif');

      const resWebp = await imageUploadService.convertToWebP(buffer, 'test.webp', 'image/webp');
      expect(resWebp.mimetype).toBe('image/webp');
    });
  });

  describe('Response Normalization (normalizeResponse)', () => {
    it('should correctly normalize Official API response', () => {
      const officialPayload = {
        data: {
          id: 'img123',
          title: 'sample',
          url: 'https://i.ibb.co/sample.png',
          display_url: 'https://i.ibb.co/sample.png',
          thumb: { url: 'https://i.ibb.co/thumb.png' },
          medium: { url: 'https://i.ibb.co/medium.png' },
          delete_url: 'https://ibb.co/delete/123',
          width: 800,
          height: 600,
          size: 10240,
          image: { mime: 'image/png', extension: 'png' },
        },
      };

      const normalized = imageUploadService.normalizeResponse(officialPayload);
      expect(normalized.success).toBe(true);
      expect(normalized.id).toBe('img123');
      expect(normalized.url).toBe('https://i.ibb.co/sample.png');
      expect(normalized.thumbnail).toBe('https://i.ibb.co/thumb.png');
      expect(normalized.width).toBe(800);
    });
  });

  describe('Official API Upload (uploadFromBuffer & uploadFromBase64)', () => {
    it('should upload image buffer via Official API with 3-min timeout and return normalized response', async () => {
      const mockApiResponse = {
        data: {
          data: {
            id: 'official1',
            url: 'https://i.ibb.co/test.png',
            display_url: 'https://i.ibb.co/test.png',
            thumb: { url: 'https://i.ibb.co/test_thumb.png' },
            width: 500,
            height: 500,
            size: 5000,
            image: { mime: 'image/png', extension: 'png' },
          },
          success: true,
        },
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const buffer = Buffer.from('test-image-data');
      const result = await imageUploadService.uploadFromBuffer(buffer, 'test.png', { skipWebP: true });

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('https://api.imgbb.com/1/upload?key=test_official_api_key'),
        expect.any(Object),
        expect.objectContaining({ timeout: 180000 })
      );

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://i.ibb.co/test.png');
      expect(result.thumbnail).toBe('https://i.ibb.co/test_thumb.png');
    });

    it('should strip data:image prefix automatically when uploading from Base64 string', async () => {
      const mockApiResponse = {
        data: {
          data: {
            id: 'b64test',
            url: 'https://i.ibb.co/b64.png',
            display_url: 'https://i.ibb.co/b64.png',
            thumb: { url: 'https://i.ibb.co/b64_thumb.png' },
          },
          success: true,
        },
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const base64Data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const result = await imageUploadService.uploadFromBase64(base64Data, 'icon.png', { skipWebP: true });

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://i.ibb.co/b64.png');
    });
  });

  describe('Timeout and Network Error Handling', () => {
    it('should throw HTTP 504 user-friendly error when upload times out (ECONNABORTED)', async () => {
      const timeoutError = new Error('timeout of 180000ms exceeded');
      timeoutError.code = 'ECONNABORTED';

      axios.post.mockRejectedValue(timeoutError);

      const buffer = Buffer.from('slow-image');
      await expect(
        imageUploadService.uploadFromBuffer(buffer, 'slow.png', { skipWebP: true })
      ).rejects.toThrow('ImgBB upload timed out after 3 minute(s)');
    });
  });

  describe('Multer Integration & Temp File Cleanup', () => {
    it('should read file buffer and clean up temporary disk file when deleteAfterUpload is true', async () => {
      const tempPath = path.join(__dirname, 'temp_test_image.tmp');
      fs.writeFileSync(tempPath, 'temp-file-content');

      const mockApiResponse = {
        data: {
          data: {
            id: 'disk1',
            url: 'https://i.ibb.co/disk.png',
            display_url: 'https://i.ibb.co/disk.png',
            thumb: { url: 'https://i.ibb.co/disk_thumb.png' },
          },
          success: true,
        },
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const multerFile = {
        path: tempPath,
        originalname: 'sample.jpg',
        mimetype: 'image/jpeg',
      };

      const result = await imageUploadService.uploadFromMulter(multerFile, { deleteAfterUpload: true, skipWebP: true });

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://i.ibb.co/disk.png');

      // uploadFromMulter cleans up in a `finally` with an un-awaited
      // fs.promises.unlink (imageUpload.service.js:245) — deliberately, so the
      // caller is not made to wait on disk I/O. Asserting existsSync on the
      // very next line therefore races the unlink: this test failed roughly 1
      // run in 4 under full-suite parallelism. Poll instead of sleeping, so it
      // stays fast and still fails if cleanup never happens.
      const goneWithin = async (p, ms = 2000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (!fs.existsSync(p)) return true;
          await new Promise((r) => setTimeout(r, 10));
        }
        return !fs.existsSync(p);
      };
      expect(await goneWithin(tempPath)).toBe(true);
    });
  });
});

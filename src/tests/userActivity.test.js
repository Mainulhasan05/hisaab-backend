/**
 * Unit Test Suite for UserActivityService
 */

const userActivityService = require('../services/userActivity.service');
const cacheService = require('../services/cache.service');
const redisConfig = require('../config/redis.config');
const User = require('../models/User.model');
const mongoose = require('mongoose');

describe('UserActivityService', () => {
  const mockUserId1 = new mongoose.Types.ObjectId().toString();
  const mockUserId2 = new mongoose.Types.ObjectId().toString();
  const mockSessionId1 = 'mock-jti-session-123';

  beforeEach(() => {
    jest.clearAllMocks();
    // Default to Redis connected for tests
    jest.spyOn(redisConfig, 'isConnected').mockReturnValue(true);
  });

  describe('recordActivity', () => {
    it('should set timestamp, session, and dirty SET on first activity (rate limit pass)', async () => {
      const setNXSpy = jest.spyOn(cacheService, 'setNX').mockResolvedValue(true);
      const setSpy = jest.spyOn(cacheService, 'set').mockResolvedValue(true);
      const sAddSpy = jest.spyOn(cacheService, 'sAdd').mockResolvedValue(true);

      await userActivityService.recordActivity(mockUserId1, mockSessionId1);

      expect(setNXSpy).toHaveBeenCalledWith(`user:lastUpdate:${mockUserId1}`, 1, 60);
      expect(setSpy).toHaveBeenCalledWith(`user:lastActive:${mockUserId1}`, expect.any(String), 86400);
      expect(setSpy).toHaveBeenCalledWith(`session:lastActive:${mockSessionId1}`, expect.any(String), 86400);
      expect(sAddSpy).toHaveBeenCalledWith('user:lastActive:dirty', mockUserId1);
    });

    it('should exit early when request is throttled by 60s rate limit window', async () => {
      const setNXSpy = jest.spyOn(cacheService, 'setNX').mockResolvedValue(false);
      const setSpy = jest.spyOn(cacheService, 'set');
      const sAddSpy = jest.spyOn(cacheService, 'sAdd');

      await userActivityService.recordActivity(mockUserId1);

      expect(setNXSpy).toHaveBeenCalledWith(`user:lastUpdate:${mockUserId1}`, 1, 60);
      expect(setSpy).not.toHaveBeenCalled();
      expect(sAddSpy).not.toHaveBeenCalled();
    });

    it('should fallback to direct MongoDB update when Redis throws an error or is disconnected', async () => {
      jest.spyOn(redisConfig, 'isConnected').mockReturnValue(false);
      const dbUpdateSpy = jest.spyOn(User, 'updateOne').mockResolvedValue({ modifiedCount: 1 });

      await userActivityService.recordActivity(mockUserId1);

      expect(dbUpdateSpy).toHaveBeenCalledWith(
        { _id: mockUserId1 },
        { $set: { lastActiveAt: expect.any(Date) } }
      );
    });
  });

  describe('syncToDatabase (Write-Behind Batch Sync)', () => {
    it('should return early when dirty set is empty', async () => {
      jest.spyOn(cacheService, 'sMembers').mockResolvedValue([]);
      const bulkWriteSpy = jest.spyOn(User, 'bulkWrite');

      const result = await userActivityService.syncToDatabase();

      expect(result).toEqual({ syncedCount: 0, errorCount: 0 });
      expect(bulkWriteSpy).not.toHaveBeenCalled();
    });

    it('should batch-fetch timestamps, execute single bulkWrite, UNLINK keys and clear dirty set', async () => {
      const nowIso = new Date().toISOString();
      jest.spyOn(cacheService, 'sMembers').mockResolvedValue([mockUserId1, mockUserId2]);
      jest.spyOn(cacheService, 'mGet').mockResolvedValue([nowIso, nowIso]);
      const bulkWriteSpy = jest.spyOn(User, 'bulkWrite').mockResolvedValue({ modifiedCount: 2 });
      const unlinkSpy = jest.spyOn(cacheService, 'unlink').mockResolvedValue(true);
      const sRemSpy = jest.spyOn(cacheService, 'sRem').mockResolvedValue(true);

      const result = await userActivityService.syncToDatabase();

      expect(result).toEqual({ syncedCount: 2, errorCount: 0 });
      expect(bulkWriteSpy).toHaveBeenCalledWith(
        [
          { updateOne: { filter: { _id: mockUserId1 }, update: { $set: { lastActiveAt: new Date(nowIso) } } } },
          { updateOne: { filter: { _id: mockUserId2 }, update: { $set: { lastActiveAt: new Date(nowIso) } } } }
        ],
        { ordered: false }
      );
      expect(unlinkSpy).toHaveBeenCalledWith([
        `user:lastActive:${mockUserId1}`,
        `user:lastActive:${mockUserId2}`
      ]);
      expect(sRemSpy).toHaveBeenCalledWith('user:lastActive:dirty', [mockUserId1, mockUserId2]);
    });
  });

  describe('getMultipleLastActive', () => {
    it('should merge Redis cache hits and MongoDB fallback misses into a single map', async () => {
      const nowIso = new Date().toISOString();
      const dbDate = new Date('2026-08-01T10:00:00.000Z');

      // mockUserId1 is a Redis hit, mockUserId2 is a cache miss
      jest.spyOn(cacheService, 'mGet').mockResolvedValue([nowIso, null]);
      jest.spyOn(User, 'find').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ _id: mockUserId2, lastActiveAt: dbDate }])
      });
      const mSetSpy = jest.spyOn(cacheService, 'mSet').mockResolvedValue(true);

      const resultMap = await userActivityService.getMultipleLastActive([mockUserId1, mockUserId2]);

      expect(resultMap[mockUserId1]).toEqual(new Date(nowIso));
      expect(resultMap[mockUserId2]).toEqual(dbDate);
      expect(mSetSpy).toHaveBeenCalledWith(
        { [`user:lastActive:${mockUserId2}`]: dbDate.toISOString() },
        86400
      );
    });
  });
});

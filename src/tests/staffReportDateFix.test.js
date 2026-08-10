/**
 * Unit Test Suite for Report Service Date Matching & Staff Performance Tracking
 */

const reportService = require('../services/report.service');
const Sale = require('../models/Sale.model');
const SalesReturn = require('../models/SalesReturn.model');
const Payment = require('../models/Payment.model');
const User = require('../models/User.model');
const mongoose = require('mongoose');

describe('ReportService Date Range & Staff Performance Fixes', () => {
  const mockShopId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('_buildDateMatch', () => {
    it('should correctly expand YYYY-MM-DD endDate to 23:59:59.999', () => {
      const match = reportService._buildDateMatch('2026-08-05', '2026-08-05');
      expect(match).toBeDefined();
      expect(match.$gte).toBeInstanceOf(Date);
      expect(match.$lte).toBeInstanceOf(Date);
      // Ensure $lte includes the entire end day
      expect(match.$lte.toISOString()).toContain('2026-08-05T17:59:59.999Z');
    });

    it('should expand midnight ISO timestamp endDate to end of day', () => {
      const match = reportService._buildDateMatch(
        '2026-08-05T00:00:00.000Z',
        '2026-08-05T00:00:00.000Z'
      );
      expect(match.$lte.getTime()).toBe(new Date('2026-08-05T00:00:00.000Z').getTime() + 24 * 60 * 60 * 1000 - 1);
    });
  });

  describe('getStaffReport', () => {
    it('should filter sales using expanded dateMatch without excluding sales created during the day', async () => {
      const mockUserId = new mongoose.Types.ObjectId().toString();

      jest.spyOn(Sale, 'aggregate').mockImplementation((pipeline) => {
        const matchStage = pipeline.find(stage => stage.$match)?.$match;
        expect(matchStage.createdAt).toBeDefined();
        expect(matchStage.createdAt.$lte).toBeDefined();

        // The summary runs two Sale pipelines: per-staff totals, and the
        // day-by-day series behind the trend chart and heatmap. The second one
        // groups by a compound _id, which is how they are told apart here.
        const groupId = pipeline.find(stage => stage.$group)?.$group?._id;
        if (groupId && typeof groupId === 'object' && groupId.date) {
          return Promise.resolve([
            {
              _id: { staffId: mockUserId, date: '2026-08-05' },
              netSales: 1500,
              profit: 300,
              saleCount: 2
            }
          ]);
        }

        return Promise.resolve([
          {
            _id: mockUserId,
            totalSales: 1500,
            totalPaid: 1500,
            totalDue: 0,
            totalProfit: 300,
            saleCount: 2,
            avgSale: 750,
            lastSaleAt: new Date(),
            activeDays: ['2026-08-05']
          }
        ]);
      });

      jest.spyOn(SalesReturn, 'aggregate').mockResolvedValue([]);
      jest.spyOn(Payment, 'aggregate').mockResolvedValue([]);
      jest.spyOn(User, 'find').mockReturnValue({
        select: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([
              {
                _id: mockUserId,
                name: 'Cashier Staff',
                phone: '01757995016',
                isOwner: false,
                isActive: true,
                role: { name: 'Cashier' }
              }
            ])
          })
        })
      });

      const res = await reportService.getStaffReport(mockShopId, {
        startDate: '2026-08-05',
        endDate: '2026-08-05'
      });

      expect(res.staff).toHaveLength(1);
      expect(res.staff[0].name).toBe('Cashier Staff');
      expect(res.summary.totalSales).toBe(1500);

      // Share of takings, and the series the chart/heatmap read.
      expect(res.staff[0].salesShare).toBe(100);
      expect(res.trend).toEqual([
        { staffId: mockUserId, date: '2026-08-05', netSales: 1500, profit: 300, saleCount: 2 }
      ]);
      // The filter controls need the whole roster, not only those who sold.
      expect(res.roster).toHaveLength(1);
    });
  });
});

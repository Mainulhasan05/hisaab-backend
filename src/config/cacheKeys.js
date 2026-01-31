/**
 * Cache Key Patterns and TTLs
 * Centralized cache key management for Redis optimization
 */

// TTL values in seconds
const TTL = {
  VERY_SHORT: 30,      // 30 seconds - real-time data
  SHORT: 60,           // 1 minute - frequently changing data
  MEDIUM: 300,         // 5 minutes - dashboard stats
  LONG: 900,           // 15 minutes - categories, reports
  VERY_LONG: 3600,     // 1 hour - static data
};

// Cache key patterns
const KEYS = {
  // Shop-specific dashboard and reports
  DASHBOARD_STATS: (shopId) => `shop:${shopId}:dashboard`,
  DAILY_SUMMARY: (shopId, date) => `shop:${shopId}:daily:${date}`,
  PROFIT_LOSS: (shopId, start, end) => `shop:${shopId}:pnl:${start || 'all'}:${end || 'all'}`,
  SALES_REPORT: (shopId, start, end, groupBy) => `shop:${shopId}:sales:${start || 'all'}:${end || 'all'}:${groupBy || 'day'}`,
  PRODUCT_REPORT: (shopId, start, end) => `shop:${shopId}:products:${start || 'all'}:${end || 'all'}`,
  CUSTOMER_REPORT: (shopId, start, end) => `shop:${shopId}:customers:${start || 'all'}:${end || 'all'}`,

  // Categories (rarely change)
  CATEGORIES: (shopId) => `shop:${shopId}:categories`,

  // Low stock products (dashboard widget)
  LOW_STOCK: (shopId) => `shop:${shopId}:lowstock`,

  // Admin dashboard
  ADMIN_STATS: () => 'admin:stats',
  ADMIN_TOP_PERFORMERS: () => 'admin:top-performers',
  ADMIN_SYSTEM_METRICS: () => 'admin:system-metrics',

  // Pattern for invalidation
  SHOP_PATTERN: (shopId) => `shop:${shopId}:*`,
  ADMIN_PATTERN: () => 'admin:*',
};

// Helper to get TTL for specific cache types
const getTTL = {
  dashboardStats: TTL.MEDIUM,       // 5 min - refreshes frequently
  dailySummary: TTL.MEDIUM,         // 5 min - date-specific
  profitLoss: TTL.MEDIUM,           // 5 min
  salesReport: TTL.MEDIUM,          // 5 min
  productReport: TTL.MEDIUM,        // 5 min
  customerReport: TTL.MEDIUM,       // 5 min
  categories: TTL.LONG,             // 15 min - rarely changes
  lowStock: TTL.SHORT,              // 1 min - important for alerts
  adminStats: TTL.SHORT,            // 1 min - real-time feel
  adminTopPerformers: TTL.MEDIUM,   // 5 min
  adminSystemMetrics: TTL.SHORT,    // 1 min - system data
};

module.exports = {
  TTL,
  KEYS,
  getTTL,
};

# Hisaab Scalability Plan

## Current Optimization Summary

### Index Optimization (Completed)

**Before:** ~70 indexes across all collections
**After:** ~35 indexes (50% reduction)

| Collection | Before | After | Savings |
|------------|--------|-------|---------|
| Product | 10 | 6 | 40% |
| Sale | 6 | 4 | 33% |
| Customer | 5 | 3 | 40% |
| Payment | 7 | 4 | 43% |
| StockTransaction | 5 | 2 | 60% |
| AuditLog | 5 | 3 | 40% |
| Purchase | 5 | 3 | 40% |
| Expense | 3 | 2 | 33% |
| Supplier | 4 | 2 | 50% |
| User | 4 | 2 | 50% |
| SMSLog | 5 | 3 | 40% |

### TTL Indexes Added

| Collection | Retention | Reason |
|------------|-----------|--------|
| AuditLog | 90 days | Prevent unbounded growth |
| SMSLog | 60 days | SMS history rarely needed long-term |

---

## Phase 1: Current State (1-100 Shops)
*Status: Ready*

### Architecture
- Single MongoDB instance
- Single Node.js server
- Redis for caching & sessions

### Capacity
- ~100 shops
- ~1M total documents
- Index size: <100MB

### Recommendations
- Monitor index usage: `db.collection.aggregate([{$indexStats:{}}])`
- Remove unused indexes based on usage data

---

## Phase 2: Growth (100-500 Shops)
*Estimated Timeline: When reaching 100 shops*

### Architecture Changes

1. **MongoDB Replica Set**
   ```
   Primary (writes) -> Secondary (reads) -> Secondary (backup)
   ```
   - Read replicas for reporting queries
   - Automatic failover

2. **Read/Write Splitting**
   ```javascript
   // For analytics/reports - use secondary
   const readPreference = 'secondaryPreferred';

   // For transactions - use primary
   const readPreference = 'primary';
   ```

3. **Connection Pooling**
   ```javascript
   mongoose.connect(uri, {
     maxPoolSize: 100,
     minPoolSize: 10,
     maxIdleTimeMS: 30000
   });
   ```

### Data Archival Strategy

1. **Create Archive Collections**
   ```javascript
   // sales_archive - sales older than 2 years
   // stock_transactions_archive - transactions older than 1 year
   ```

2. **Archival Script (run monthly)**
   ```javascript
   // Archive sales older than 2 years
   const cutoffDate = new Date();
   cutoffDate.setFullYear(cutoffDate.getFullYear() - 2);

   const oldSales = await Sale.find({ createdAt: { $lt: cutoffDate } });
   await SalesArchive.insertMany(oldSales);
   await Sale.deleteMany({ createdAt: { $lt: cutoffDate } });
   ```

### Capacity
- ~500 shops
- ~10M total documents
- Index size: ~500MB

---

## Phase 3: Scale (500-2000 Shops)
*Estimated Timeline: When reaching 500 shops*

### Architecture Changes

1. **MongoDB Sharding**
   ```
   Shard Key: { shop: 1 }

   Benefits:
   - Data isolation per shop
   - Horizontal scaling
   - Query routing optimization
   ```

2. **Sharding Setup**
   ```javascript
   // Enable sharding on database
   sh.enableSharding("hisaab")

   // Shard collections by shop
   sh.shardCollection("hisaab.sales", { shop: 1 })
   sh.shardCollection("hisaab.products", { shop: 1 })
   sh.shardCollection("hisaab.customers", { shop: 1 })
   sh.shardCollection("hisaab.payments", { shop: 1 })
   ```

3. **Multiple Node.js Instances**
   ```
   Load Balancer
        |
   +---------+---------+
   |         |         |
   Node1   Node2    Node3
   ```

### Search Optimization

1. **Elasticsearch Integration**
   - Full-text search for products
   - Customer name search
   - Replace MongoDB text indexes

   ```javascript
   // Product search with Elasticsearch
   const results = await esClient.search({
     index: 'products',
     body: {
       query: {
         multi_match: {
           query: searchTerm,
           fields: ['name', 'nameBn', 'code', 'barcode']
         }
       },
       post_filter: { term: { shop: shopId } }
     }
   });
   ```

### Capacity
- ~2000 shops
- ~100M total documents
- Index size: ~5GB (distributed)

---

## Phase 4: Enterprise (2000+ Shops)
*Estimated Timeline: When reaching 2000 shops*

### Architecture Changes

1. **Multi-Region Deployment**
   ```
   Region 1 (Dhaka)     Region 2 (Chittagong)
        |                      |
   MongoDB Shard 1        MongoDB Shard 2
   ```

2. **Microservices Split**
   ```
   API Gateway
        |
   +----+----+----+----+
   |    |    |    |    |
   Auth Sales Products Reports
   ```

3. **Event-Driven Architecture**
   ```
   Sale Created -> Event Queue ->
     -> Update Stock
     -> Update Customer Due
     -> Send SMS
     -> Update Reports Cache
   ```

### Data Lake for Analytics
- Move historical data to data lake (S3 + Athena)
- Real-time analytics with Redis streams
- Dashboard queries from pre-aggregated collections

---

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Database**
   - Query execution time (p95 < 100ms)
   - Index hit ratio (> 95%)
   - Connection pool usage
   - Replication lag

2. **Application**
   - API response time
   - Error rate
   - Memory usage
   - CPU usage

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Query time p95 | > 100ms | > 500ms |
| Index size | > 1GB | > 5GB |
| Connection pool | > 70% | > 90% |
| Error rate | > 1% | > 5% |

---

## Immediate Actions Checklist

- [x] Optimize indexes (reduced by 50%)
- [x] Add TTL indexes for AuditLog and SMSLog
- [ ] Set up MongoDB monitoring (MongoDB Atlas or self-hosted)
- [ ] Implement query logging for slow queries
- [ ] Create data archival scripts
- [ ] Set up read replica for reports
- [ ] Document index usage patterns after 30 days

---

## Cost Considerations

### MongoDB Atlas Pricing (Estimated)

| Phase | Tier | Est. Monthly Cost |
|-------|------|-------------------|
| 1 | M10 (2GB RAM) | $57 |
| 2 | M20 + Replica | $200 |
| 3 | M30 + Sharding | $500+ |
| 4 | Dedicated | Custom |

### Self-Hosted (VPS)

| Phase | Specs | Est. Monthly Cost |
|-------|-------|-------------------|
| 1 | 4GB RAM, 2 vCPU | $20 |
| 2 | 8GB RAM, 4 vCPU x2 | $80 |
| 3 | 16GB RAM, 8 vCPU x3 | $300 |

---

## Notes

1. **Index Creation**: After deploying, drop existing indexes and let MongoDB create new ones:
   ```javascript
   // In production, create indexes in background
   db.collection.createIndex({ field: 1 }, { background: true })
   ```

2. **Migration Path**: Always test scaling changes on staging first

3. **Backup Strategy**: Daily backups with 30-day retention

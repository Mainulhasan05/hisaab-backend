/**
 * PM2 cluster configuration.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload hisaab-api          # zero-downtime restart
 *
 * ── Why clustering is safe here ─────────────────────────────────────────────
 *
 * Node runs JS on one thread, so a single process uses ONE core no matter what
 * the host has. Everything that costs CPU per request — Mongoose hydration in
 * the auth middleware, JSON serialisation, gzip — contends for that one thread.
 *
 * The usual blockers for clustering an Express app are already handled:
 *
 *   - Rate limits are Redis-backed and shared across processes
 *     (middleware/rateLimiter.middleware.js), so four workers still enforce one
 *     limit rather than four times the limit.
 *   - The auth cache, idempotency locks and presence sets all live in Redis
 *     (config/redis.config.js). The in-process Map is documented there as a
 *     degraded fallback, and it IS degraded under clustering — with Redis down,
 *     each worker has its own cache and idempotency stops being global. That is
 *     the same trade-off the fallback already documents, one step worse.
 *   - Sessions are stateless JWTs in cookies, so no sticky routing is needed.
 *
 * ── The two things that had to change ───────────────────────────────────────
 *
 *   1. The interval jobs must run in ONE worker, not all of them. src/index.js
 *      gates them on NODE_APP_INSTANCE, which PM2 sets per worker.
 *   2. The Mongo pool is per process. config/database.js defaults to 50, so
 *      four workers would open 200 connections. Set MONGO_MAX_POOL_SIZE in the
 *      environment to (target total / instances) — see below.
 */
module.exports = {
  apps: [
    {
      name: 'hisaab-api',
      script: 'src/index.js',
      exec_mode: 'cluster',

      // One worker per core. Pin to a number if the host is shared, or if
      // memory is the binding constraint — each worker carries its own heap.
      instances: process.env.WEB_CONCURRENCY || 'max',

      // Total pool across the cluster stays near the previous single-process
      // figure rather than multiplying by instance count. Raise deliberately
      // after watching db.serverStatus().connections, not by default.
      env_production: {
        NODE_ENV: 'production',
        MONGO_MAX_POOL_SIZE: process.env.MONGO_MAX_POOL_SIZE || '15',
        MONGO_MIN_POOL_SIZE: process.env.MONGO_MIN_POOL_SIZE || '2',
      },

      // A worker that dies is replaced; a worker that thrashes is not, so the
      // restart is bounded rather than an infinite crash loop.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 2000,

      // The process already drains the HTTP server, stops both jobs and closes
      // Redis/Mongo on SIGTERM (src/index.js shutdown()), with its own 10s
      // force-exit backstop. This gives it room to finish.
      kill_timeout: 12000,

      // Wait for the app to signal readiness rather than assuming the port is
      // live the instant the process spawns.
      listen_timeout: 15000,

      // Logs go to PM2; the app's own winston File transports are unchanged.
      merge_logs: true,
      time: true,
    },
  ],
};

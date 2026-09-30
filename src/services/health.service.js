const mongoose = require('mongoose');
const { isRedisEnabled, getClient } = require('../config/redis.config');
const { version } = require('../../package.json');

/**
 * Deep health check for an external uptime monitor.
 *
 * `/health` (app.js) only reads `readyState`, which is a cached flag: it keeps
 * saying "connected" while Atlas is unreachable, until the driver's heartbeat
 * finally notices. This one round-trips a `ping` to each dependency, so a green
 * answer means the database actually answered just now.
 *
 * Severity follows what the app does without each dependency:
 *   MongoDB down → nothing works              → 'down'     (503)
 *   Redis down   → cache/limits fall back to
 *                  per-process memory          → 'degraded' (200)
 *   Redis never configured                     → 'disabled', not a failure
 *
 * Deliberately reports no hostnames, connection strings or error stacks — the
 * route is unauthenticated.
 */

const CHECK_TIMEOUT_MS = 2000;

// readyState numbers are opaque in a monitor's log; name them.
const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/** Reject after `ms` so a hung dependency cannot hang the probe. */
const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const timed = async (fn) => {
  const start = process.hrtime.bigint();
  await withTimeout(fn(), CHECK_TIMEOUT_MS);
  return Number((process.hrtime.bigint() - start) / 1000000n);
};

async function checkMongo() {
  const readyState = mongoose.connection.readyState;
  const state = MONGO_STATES[readyState] || 'unknown';
  // Pinging a connection that is not open would just queue behind the
  // driver's reconnect and eat the whole timeout.
  if (readyState !== 1 || !mongoose.connection.db) {
    return { status: 'down', state };
  }
  try {
    const latencyMs = await timed(() => mongoose.connection.db.admin().ping());
    return { status: 'up', state, latencyMs };
  } catch (err) {
    return { status: 'down', state, error: err.message };
  }
}

async function checkRedis() {
  if (!isRedisEnabled()) return { status: 'disabled' };
  const client = getClient();
  if (!client) return { status: 'down', error: 'not connected' };
  try {
    const latencyMs = await timed(() => client.ping());
    return { status: 'up', latencyMs };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
}

async function getHealthStatus() {
  const [database, redis] = await Promise.all([checkMongo(), checkRedis()]);

  let status = 'ok';
  if (redis.status === 'down') status = 'degraded';
  if (database.status !== 'up') status = 'down';

  const mem = process.memoryUsage();
  const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

  return {
    status,
    timestamp: new Date().toISOString(),
    version,
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, redis },
    memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
  };
}

module.exports = { getHealthStatus, CHECK_TIMEOUT_MS };

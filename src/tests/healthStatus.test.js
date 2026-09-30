/**
 * Deep health check — the verdict a monitor alerts on.
 *
 * The rule under test: only MongoDB can make the app 'down'. Redis failing is
 * 'degraded' (the app falls back to memory), Redis never configured is not a
 * failure at all, and a hung dependency must time out rather than hang.
 */

const mockPing = jest.fn();
const mockConnection = { readyState: 1, db: { admin: () => ({ ping: mockPing }) } };
jest.mock('mongoose', () => ({ connection: mockConnection }));

const mockRedis = { enabled: true, client: { ping: jest.fn() } };
jest.mock('../config/redis.config', () => ({
  isRedisEnabled: () => mockRedis.enabled,
  getClient: () => mockRedis.client,
}));

const { getHealthStatus, CHECK_TIMEOUT_MS } = require('../services/health.service');

beforeEach(() => {
  mockConnection.readyState = 1;
  mockPing.mockReset().mockResolvedValue({ ok: 1 });
  mockRedis.enabled = true;
  mockRedis.client = { ping: jest.fn().mockResolvedValue('PONG') };
});

test('everything answering → ok, with latencies', async () => {
  const r = await getHealthStatus();
  expect(r.status).toBe('ok');
  expect(r.checks.database).toMatchObject({ status: 'up', state: 'connected' });
  expect(typeof r.checks.database.latencyMs).toBe('number');
  expect(r.checks.redis.status).toBe('up');
  expect(r.uptimeSeconds).toBeGreaterThanOrEqual(0);
});

test('readyState says connected but the ping fails → down', async () => {
  mockPing.mockRejectedValue(new Error('server selection timed out'));
  const r = await getHealthStatus();
  expect(r.status).toBe('down');
  expect(r.checks.database.status).toBe('down');
});

test('database not connected → down, without pinging', async () => {
  mockConnection.readyState = 2;
  const r = await getHealthStatus();
  expect(r.status).toBe('down');
  expect(r.checks.database.state).toBe('connecting');
  expect(mockPing).not.toHaveBeenCalled();
});

test('Redis lost → degraded, not down', async () => {
  mockRedis.client = null;
  const r = await getHealthStatus();
  expect(r.status).toBe('degraded');
  expect(r.checks.redis.status).toBe('down');
});

test('Redis never configured → ok', async () => {
  mockRedis.enabled = false;
  const r = await getHealthStatus();
  expect(r.status).toBe('ok');
  expect(r.checks.redis.status).toBe('disabled');
});

test('a hung database ping times out instead of hanging the probe', async () => {
  jest.useFakeTimers();
  mockPing.mockReturnValue(new Promise(() => {}));
  const pending = getHealthStatus();
  await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 1);
  const r = await pending;
  jest.useRealTimers();
  expect(r.status).toBe('down');
  expect(r.checks.database.error).toMatch(/timed out/);
});

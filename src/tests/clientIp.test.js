/**
 * Where a request came from.
 *
 * This was wrong everywhere at once, in the same way, and silently: the founder
 * alerts and the audit trail each wrote `req.ip || req.headers[...]` as a
 * safety net, and `req.ip` is never falsy on a real Express request — so both
 * nets were unreachable and both recorded `::ffff:127.0.0.1` for every request
 * in production. What makes it worth a suite of its own is that nothing fails
 * when it breaks. The alert still sends, the audit row still saves; they are
 * just blind, and blind in a way that looks like data.
 *
 * Three properties are pinned here:
 *
 *   1. `req.ip` wins when it names a real client, because it is the ONLY
 *      candidate a client cannot forge.
 *   2. The proxy headers are reached when it does not — including `X-Real-IP`,
 *      which Express's own `trust proxy` never reads.
 *   3. An internal address is skipped while looking, and returned only if
 *      nothing better exists. It is the honest answer on a laptop and a
 *      misconfiguration in production, and the two callers render it
 *      differently on purpose.
 */

const { resolveClientIp, isInternalAddress } = require('../utils/clientIp.util');
const AuditLog = require('../models/AuditLog.model');

describe('resolveClientIp', () => {
  it('takes req.ip when trust proxy resolved a real client', () => {
    expect(resolveClientIp({ ip: '203.0.113.9', headers: {} })).toBe('203.0.113.9');
  });

  it('prefers req.ip over a forged x-forwarded-for entry', () => {
    // nginx APPENDS to x-forwarded-for, so a request that arrives already
    // carrying the header keeps its own value at the front — which is exactly
    // what the old implementation read first. `trust proxy` pushes it left and
    // ignores it, and that is the value this must return.
    const ip = resolveClientIp({
      ip: '203.0.113.9',
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('reads x-real-ip when req.ip is the loopback socket', () => {
    // The production shape this bug was actually made of: nginx sets X-Real-IP
    // and not X-Forwarded-For, so Express — which reads only the latter —
    // resolves nothing and falls back to the socket.
    const ip = resolveClientIp({
      ip: '::ffff:127.0.0.1',
      headers: { 'x-real-ip': '103.106.72.14' },
    });
    expect(ip).toBe('103.106.72.14');
  });

  it('skips a private proxy hop the same way it skips loopback', () => {
    const ip = resolveClientIp({
      ip: '10.0.0.5',
      headers: { 'x-real-ip': '198.51.100.22' },
    });
    expect(ip).toBe('198.51.100.22');
  });

  it('strips the IPv4-mapped prefix a dual-stack socket adds', () => {
    expect(resolveClientIp({ ip: '::ffff:203.0.113.42', headers: {} })).toBe('203.0.113.42');
  });

  it('returns the internal address when it is genuinely all there is', () => {
    // A developer's laptop has no proxy, and 127.0.0.1 is the true client
    // address rather than a gap. Callers ask `isInternalAddress` if they need
    // to tell that apart from a misconfigured proxy.
    expect(resolveClientIp({ ip: '127.0.0.1', headers: {} })).toBe('127.0.0.1');
  });

  it('returns null for a request carrying no address at all', () => {
    expect(resolveClientIp({ headers: {} })).toBeNull();
    expect(resolveClientIp(null)).toBeNull();
  });

  it('treats the literal string "unknown" as no address', () => {
    // The old `getClientIP` returned it as a sentinel, and it was stored.
    expect(resolveClientIp({ ip: 'unknown', headers: {} })).toBeNull();
  });

  it('takes only the first entry of x-forwarded-for, never the proxy chain', () => {
    const ip = resolveClientIp({
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1, 10.0.0.2' },
    });
    expect(ip).toBe('198.51.100.7');
  });
});

describe('isInternalAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.5', '192.168.1.9', '172.16.0.1', '172.31.255.254',
    '169.254.1.1', '::1', 'fd00::1', 'fe80::1',
  ])('treats %s as our own wire', (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each([
    '203.0.113.9', '103.106.72.14', '172.15.0.1', '172.32.0.1', '8.8.8.8',
  ])('treats %s as a client', (ip) => {
    // 172.15 and 172.32 sit either side of the private block — a range written
    // as `172.` or `172.1[6-9]` without the upper bound swallows real clients.
    expect(isInternalAddress(ip)).toBe(false);
  });
});

describe('audit trail origin', () => {
  /** Build the row `AuditLog.log()` would create, without touching a database. */
  const rowFor = (req) => {
    const create = jest.spyOn(AuditLog, 'create').mockResolvedValue({});
    AuditLog.log({ shop: null, action: 'test', description: 'test', req });
    const [row] = create.mock.calls[0];
    create.mockRestore();
    return row;
  };

  it('records the address the proxy forwarded, not the socket', () => {
    const row = rowFor({
      ip: '::ffff:127.0.0.1',
      headers: { 'x-real-ip': '103.106.72.14', 'user-agent': 'Mozilla/5.0' },
    });
    expect(row.metadata.ip).toBe('103.106.72.14');
  });

  it('leaves the address unset rather than defaulting to 127.0.0.1', () => {
    // The old chain ended in a literal '127.0.0.1', which made "no address was
    // forwarded" indistinguishable from a genuine local request. Undefined lets
    // the pre('validate') hook fill it from the ambient context instead.
    const row = rowFor({ headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(row.metadata.ip).toBeUndefined();
    expect(row.metadata.userAgent).toBe('Mozilla/5.0');
  });
});

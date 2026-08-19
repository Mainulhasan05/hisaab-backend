/**
 * Request Context Middleware
 * Enriches request with IP, user agent, and device information
 * Used for audit logging and analytics
 */

const { runWithContext } = require('../utils/requestStore.util');
const { resolveClientIp } = require('../utils/clientIp.util');

/**
 * Extract real client IP considering proxies.
 *
 * The resolution itself lives in `utils/clientIp.util.js` — the audit trail,
 * the SMS origin log and the founder alerts all need the same answer, and three
 * hand-rolled header chains is how they came to disagree. This walked
 * `x-forwarded-for` FIRST, taking the entry a client can put there itself, and
 * never consulted `req.ip` unless no header was present at all; see the long
 * note in the util for why the order is now the other way round.
 *
 * `'unknown'` rather than null on the way out: `req.context.ip` has always been
 * a string and several readers store it directly.
 */
function getClientIP(req) {
  return resolveClientIp(req) || 'unknown';
}

/**
 * Parse user agent string
 */
function parseUserAgent(userAgent) {
  if (!userAgent) {
    return {
      browser: 'Unknown',
      browserVersion: null,
      os: 'Unknown',
      osVersion: null,
      device: 'Unknown',
      isMobile: false,
      isTablet: false,
      isDesktop: true,
      isBot: false
    };
  }

  const ua = userAgent.toLowerCase();

  // Detect bots
  const isBot = /bot|crawler|spider|crawling|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebot|ia_archiver/i.test(userAgent);

  // Detect device type
  const isMobile = /mobile|android|iphone|ipod|blackberry|windows phone|opera mini|iemobile/i.test(userAgent);
  const isTablet = /tablet|ipad|playbook|silk/i.test(userAgent) || (ua.includes('android') && !ua.includes('mobile'));
  const isDesktop = !isMobile && !isTablet;

  // Detect browser
  let browser = 'Unknown';
  let browserVersion = null;

  if (ua.includes('edg/')) {
    browser = 'Edge';
    const match = userAgent.match(/Edg\/(\d+)/);
    browserVersion = match ? match[1] : null;
  } else if (ua.includes('opr/') || ua.includes('opera')) {
    browser = 'Opera';
    const match = userAgent.match(/OPR\/(\d+)/);
    browserVersion = match ? match[1] : null;
  } else if (ua.includes('chrome') && !ua.includes('chromium')) {
    browser = 'Chrome';
    const match = userAgent.match(/Chrome\/(\d+)/);
    browserVersion = match ? match[1] : null;
  } else if (ua.includes('firefox')) {
    browser = 'Firefox';
    const match = userAgent.match(/Firefox\/(\d+)/);
    browserVersion = match ? match[1] : null;
  } else if (ua.includes('safari') && !ua.includes('chrome')) {
    browser = 'Safari';
    const match = userAgent.match(/Version\/(\d+)/);
    browserVersion = match ? match[1] : null;
  } else if (ua.includes('msie') || ua.includes('trident')) {
    browser = 'Internet Explorer';
    const match = userAgent.match(/(?:MSIE |rv:)(\d+)/);
    browserVersion = match ? match[1] : null;
  }

  // Detect OS
  let os = 'Unknown';
  let osVersion = null;

  if (ua.includes('windows')) {
    os = 'Windows';
    if (ua.includes('windows nt 10')) osVersion = '10';
    else if (ua.includes('windows nt 11')) osVersion = '11';
    else if (ua.includes('windows nt 6.3')) osVersion = '8.1';
    else if (ua.includes('windows nt 6.2')) osVersion = '8';
    else if (ua.includes('windows nt 6.1')) osVersion = '7';
  } else if (ua.includes('mac os x')) {
    os = 'macOS';
    const match = userAgent.match(/Mac OS X (\d+[._]\d+)/);
    osVersion = match ? match[1].replace('_', '.') : null;
  } else if (ua.includes('android')) {
    os = 'Android';
    const match = userAgent.match(/Android (\d+\.?\d*)/);
    osVersion = match ? match[1] : null;
  } else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) {
    os = 'iOS';
    const match = userAgent.match(/OS (\d+[._]\d+)/);
    osVersion = match ? match[1].replace('_', '.') : null;
  } else if (ua.includes('linux')) {
    os = 'Linux';
  }

  // Detect specific device
  let device = isDesktop ? 'Desktop' : (isTablet ? 'Tablet' : 'Mobile');

  if (ua.includes('iphone')) device = 'iPhone';
  else if (ua.includes('ipad')) device = 'iPad';
  else if (ua.includes('samsung')) device = 'Samsung';
  else if (ua.includes('pixel')) device = 'Pixel';

  return {
    browser,
    browserVersion,
    os,
    osVersion,
    device,
    isMobile,
    isTablet,
    isDesktop,
    isBot
  };
}

/**
 * Get geolocation info from IP (placeholder - requires external service)
 * Can be implemented with services like MaxMind, IPInfo, etc.
 */
function getGeoFromIP(ip) {
  // For now, return empty - can be implemented with external services
  return {
    country: null,
    region: null,
    city: null
  };
}

/**
 * Request context middleware
 * Attaches context information to req.context
 */
const requestContext = (req, res, next) => {
  const userAgent = req.get('User-Agent') || '';
  const clientIP = getClientIP(req);
  const parsedUA = parseUserAgent(userAgent);

  // Attach context to request
  req.context = {
    ip: clientIP,
    userAgent: userAgent,
    ...parsedUA,
    geo: getGeoFromIP(clientIP),
    timestamp: new Date(),
    requestId: generateRequestId()
  };

  // Also make it available in a more convenient format for audit logging
  req.clientInfo = {
    ip: clientIP,
    userAgent: userAgent,
    browser: parsedUA.browser,
    os: parsedUA.os,
    device: parsedUA.device,
    isMobile: parsedUA.isMobile
  };

  // Run the rest of the request inside an AsyncLocalStorage scope holding this
  // request, so `AuditLog` can read the origin without every service being
  // handed a `req`. 33 audit call sites used `AuditLog.create()` directly and
  // wrote no metadata at all; this fixes all of them at once and makes the
  // next one impossible to get wrong. See utils/requestStore.util.js.
  //
  // `req` itself is the store rather than a copy: auth middleware runs AFTER
  // this one and assigns `req.user`, `req.shop`, `req.branchId`. Storing a
  // snapshot here would freeze all three as undefined.
  runWithContext(req, next);
};

/**
 * Generate unique request ID for tracking
 */
function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Utility function to extract context for audit log
 */
function getAuditContext(req) {
  return {
    ip: req.context?.ip || req.ip,
    userAgent: req.context?.userAgent || req.get('User-Agent'),
    browser: req.context?.browser || 'Unknown',
    os: req.context?.os || 'Unknown',
    device: req.context?.device || 'Unknown'
  };
}

module.exports = {
  requestContext,
  getClientIP,
  parseUserAgent,
  getAuditContext
};

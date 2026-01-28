/**
 * Request Context Middleware
 * Enriches request with IP, user agent, and device information
 * Used for audit logging and analytics
 */

/**
 * Extract real client IP considering proxies
 */
function getClientIP(req) {
  // Check various headers for real IP (behind proxies/load balancers)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    // x-forwarded-for can contain multiple IPs, first one is the client
    return forwardedFor.split(',')[0].trim();
  }

  const realIP = req.headers['x-real-ip'];
  if (realIP) {
    return realIP;
  }

  // Cloudflare
  const cfConnectingIP = req.headers['cf-connecting-ip'];
  if (cfConnectingIP) {
    return cfConnectingIP;
  }

  // Default to connection remote address
  return req.ip || req.connection?.remoteAddress || 'unknown';
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

  next();
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

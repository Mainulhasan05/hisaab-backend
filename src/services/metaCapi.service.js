/**
 * Meta Conversions API (CAPI)
 *
 * Server-side twin of the browser Pixel in hisaab-frontend. Browser-only
 * tracking loses 20-40% of events to ad blockers and iOS ITP; sending the same
 * conversion from here recovers them.
 *
 * Every event carries an `event_id` that the browser also sends, so Meta
 * deduplicates the pair instead of double-counting.
 * https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger.util');
const { formatPhone } = require('../utils/phone.util');

const PIXEL_ID = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
// Set while validating in Events Manager > Test Events; leave unset in production
// or the events land in the test stream instead of the real dataset.
const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE;

// Meta is a non-critical side channel — a slow graph endpoint must never hold
// a user's registration open, so the timeout is deliberately tight.
const capiHttp = axios.create({ timeout: Number(process.env.META_CAPI_TIMEOUT_MS) || 5000 });

const isEnabled = () => Boolean(PIXEL_ID && ACCESS_TOKEN);

/**
 * Meta requires every PII field lowercased, trimmed and SHA-256 hexed.
 * Anything already hashed (64 hex chars) is passed through untouched.
 */
const hash = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^[a-f0-9]{64}$/.test(normalized)) return normalized;
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

// Phone must be digits only with country code and no leading '+'.
const hashPhone = (phone) => {
  const formatted = formatPhone(phone);
  return formatted ? hash(formatted) : undefined;
};

/** Strip undefined keys — Meta rejects null/empty values in user_data. */
const compact = (obj) => {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
};

/**
 * The frontend and the API live on different domains, so the _fbp / _fbc
 * cookies the Pixel sets are never sent to us automatically. The client
 * forwards them in the request body instead; they are the single biggest
 * lever on match quality, so use them whenever present.
 */
const buildUserData = ({ phone, email, firstName, lastName, externalId, fbp, fbc }, req) => {
  const userData = compact({
    ph: hashPhone(phone),
    em: hash(email),
    fn: hash(firstName),
    ln: hash(lastName),
    external_id: hash(externalId),
    fbp,
    fbc,
    client_ip_address: req?.ip,
    client_user_agent: req?.get?.('user-agent')
  });

  // Meta accepts these identifiers as arrays for multi-value matching
  for (const key of ['ph', 'em', 'fn', 'ln', 'external_id']) {
    if (userData[key]) userData[key] = [userData[key]];
  }

  return userData;
};

/** Random, collision-safe id shared between the browser and server event. */
const newEventId = () => crypto.randomUUID();

/**
 * Send one event. Never throws and never blocks the caller — failures are
 * logged and swallowed so a Meta outage cannot break registration.
 *
 * @returns {Promise<{sent: boolean, eventId: string, reason?: string}>}
 */
const sendEvent = async ({
  eventName,
  eventId = newEventId(),
  eventTime = Math.floor(Date.now() / 1000),
  actionSource = 'website',
  eventSourceUrl,
  userData = {},
  customData,
  req
}) => {
  if (!isEnabled()) {
    logger.debug?.(`Meta CAPI disabled — skipped ${eventName}`);
    return { sent: false, eventId, reason: 'disabled' };
  }

  const payload = {
    data: [
      compact({
        event_name: eventName,
        event_time: eventTime,
        event_id: eventId,
        action_source: actionSource,
        event_source_url: eventSourceUrl || process.env.FRONTEND_URL || undefined,
        user_data: buildUserData(userData, req),
        custom_data: customData
      })
    ]
  };

  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;

  try {
    const { data } = await capiHttp.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events`,
      payload,
      { params: { access_token: ACCESS_TOKEN } }
    );

    // events_received === 0 means Meta accepted the HTTP call but dropped the
    // event — worth surfacing, it's silent data loss otherwise.
    if (!data?.events_received) {
      logger.warn(`Meta CAPI ${eventName} accepted but events_received=0: ${JSON.stringify(data)}`);
    } else {
      logger.info(`Meta CAPI ${eventName} sent (event_id=${eventId})`);
    }

    return { sent: true, eventId, response: data };
  } catch (error) {
    const detail = error.response?.data?.error || error.message;
    logger.error(`Meta CAPI ${eventName} failed: ${JSON.stringify(detail)}`);
    return { sent: false, eventId, reason: 'error' };
  }
};

/**
 * Fire-and-forget wrapper. Use this from request handlers: it returns the
 * event_id synchronously so the response can carry it to the browser, while
 * the HTTP call to Meta completes in the background.
 */
const trackAsync = (options) => {
  const eventId = options.eventId || newEventId();
  // Detached on purpose — sendEvent never rejects, the catch is belt-and-braces
  // against a programming error inside it.
  Promise.resolve()
    .then(() => sendEvent({ ...options, eventId }))
    .catch((err) => logger.error(`Meta CAPI dispatch error: ${err.message}`));
  return eventId;
};

// --- Business events -------------------------------------------------------
// Mirrors hisaab-frontend/lib/fbpixel.js. Keep the two in step.

/** Account created, phone not yet verified — a lead, not a completed signup. */
const trackSignupLead = ({ user, shop, tracking = {}, req }) =>
  trackAsync({
    eventName: 'Lead',
    eventId: tracking.eventId,
    eventSourceUrl: tracking.eventSourceUrl,
    req,
    userData: {
      phone: user?.phone,
      firstName: user?.name,
      externalId: user?._id?.toString(),
      fbp: tracking.fbp,
      fbc: tracking.fbc
    },
    customData: {
      content_name: 'shop_signup',
      shop_type: shop?.shopType || 'other'
    }
  });

/** Phone verified — the account is genuinely usable. Optimise ad spend on this. */
const trackRegistrationCompleted = ({ user, tracking = {}, req }) =>
  trackAsync({
    eventName: 'CompleteRegistration',
    eventId: tracking.eventId,
    eventSourceUrl: tracking.eventSourceUrl,
    req,
    userData: {
      phone: user?.phone,
      firstName: user?.name,
      externalId: user?._id?.toString(),
      fbp: tracking.fbp,
      fbc: tracking.fbc
    },
    customData: {
      content_name: 'shop_signup_verified',
      status: 'verified'
    }
  });

module.exports = {
  isEnabled,
  hash,
  hashPhone,
  newEventId,
  sendEvent,
  trackAsync,
  trackSignupLead,
  trackRegistrationCompleted
};

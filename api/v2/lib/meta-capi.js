/**
 * Meta Conversions API (CAPI) utility for server-side event tracking.
 * Fire-and-forget pattern: callers invoke sendCapiEvent(...).catch(() => {})
 */
import crypto from 'crypto';

const PIXEL_ID = '1854308178620853';
const GRAPH_API_VERSION = 'v21.0';
const CAPI_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events`;

let _warnedNoToken = false;

/**
 * SHA-256 hash a value for Meta CAPI user_data fields.
 * Returns empty string if value is falsy.
 */
function hashValue(value) {
  if (!value) return '';
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return '';
  // Skip if already hashed (64-char hex string)
  if (/^[a-f0-9]{64}$/.test(normalized)) return normalized;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Normalize a US phone number to digits only with country code 1.
 * E.g. "+1 (555) 123-4567" -> "15551234567"
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits;
}

/**
 * Split a display name into first and last name.
 */
function splitName(name) {
  if (!name) return { firstName: '', lastName: '' };
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || ''
  };
}

/**
 * Extract client IP and user agent from a Vercel request.
 */
function extractRequestInfo(req) {
  if (!req) return {};
  const ip = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers?.['x-real-ip']
    || req.socket?.remoteAddress
    || '';
  const ua = req.headers?.['user-agent'] || '';
  return { clientIpAddress: ip, clientUserAgent: ua };
}

/**
 * Send an event to Meta Conversions API.
 *
 * @param {object} options
 * @param {string} options.eventName - Meta standard or custom event name
 * @param {string} [options.eventId] - Event ID for dedup with pixel (should match client eventID)
 * @param {string} [options.eventSourceUrl] - Page URL where event occurred
 * @param {object} [options.userData] - User PII (will be hashed): { email, phone, firstName, lastName, name, fbp, fbc }
 * @param {object} [options.customData] - Event-specific data: { value, currency, content_name, content_category, content_ids }
 * @param {object} [options.req] - Express/Vercel request object (for IP + UA extraction)
 * @param {string} [options.actionSource] - Default 'website'
 * @returns {Promise<{success: boolean, response?: any}>}
 */
export async function sendCapiEvent({ eventName, eventId, eventSourceUrl, userData = {}, customData = {}, req, actionSource = 'website' }) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    if (!_warnedNoToken) {
      console.warn('[Meta CAPI] META_ACCESS_TOKEN not set — skipping server events');
      _warnedNoToken = true;
    }
    return { success: false };
  }

  try {
    const { clientIpAddress, clientUserAgent } = extractRequestInfo(req);

    // Handle name splitting
    let firstName = userData.firstName || '';
    let lastName = userData.lastName || '';
    if (!firstName && userData.name) {
      const split = splitName(userData.name);
      firstName = split.firstName;
      lastName = split.lastName;
    }

    // Build user_data with hashed PII
    const user_data = {};

    const hashedEmail = hashValue(userData.email);
    if (hashedEmail) user_data.em = [hashedEmail];

    const hashedPhone = hashValue(normalizePhone(userData.phone));
    if (hashedPhone) user_data.ph = [hashedPhone];

    const hashedFn = hashValue(firstName);
    if (hashedFn) user_data.fn = [hashedFn];

    const hashedLn = hashValue(lastName);
    if (hashedLn) user_data.ln = [hashedLn];

    if (clientIpAddress) user_data.client_ip_address = clientIpAddress;
    if (clientUserAgent) user_data.client_user_agent = clientUserAgent;
    if (userData.fbp) user_data.fbp = userData.fbp;
    if (userData.fbc) user_data.fbc = userData.fbc;

    // Build event payload
    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: actionSource,
      user_data
    };

    if (eventId) eventData.event_id = eventId;
    if (eventSourceUrl) eventData.event_source_url = eventSourceUrl;

    // Add custom_data if any non-empty fields
    const cd = {};
    if (customData.value !== undefined) cd.value = customData.value;
    if (customData.currency) cd.currency = customData.currency;
    if (customData.content_name) cd.content_name = customData.content_name;
    if (customData.content_category) cd.content_category = customData.content_category;
    if (customData.content_ids) cd.content_ids = customData.content_ids;
    if (customData.content_type) cd.content_type = customData.content_type;
    if (customData.status) cd.status = customData.status;
    if (Object.keys(cd).length > 0) eventData.custom_data = cd;

    const payload = {
      data: [eventData],
      access_token: accessToken
    };

    const response = await fetch(CAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[Meta CAPI] Error:', response.status, text);
      return { success: false };
    }

    const result = await response.json();
    return { success: true, response: result };
  } catch (err) {
    console.error('[Meta CAPI] Exception:', err.message);
    return { success: false };
  }
}

/**
 * Helper to extract Meta context from request body.
 * Clients send metaEventId, fbp, fbc in API request bodies.
 */
export function extractMetaContext(body) {
  return {
    eventId: body?.metaEventId || '',
    fbp: body?.fbp || '',
    fbc: body?.fbc || ''
  };
}

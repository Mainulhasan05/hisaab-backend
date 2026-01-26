/**
 * SMS Character Counter & Segment Calculator
 * Server-side validation for Bangladesh SMS system (MimSMS compatible)
 *
 * GSM-7:  160 chars/single segment, 153 chars/multipart segment
 * Unicode (UCS-2): 70 chars/single segment, 67 chars/multipart segment
 *
 * Extended GSM characters (@, ^, {, }, [, ], ~, |, €, \) count as 2 GSM chars.
 * Any character outside the GSM-7 + extended set forces Unicode encoding.
 */

// Standard GSM 7-bit character set (single-byte)
const GSM_7_BASIC = new Set([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r',
  'Å', 'å', 'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ',
  'Æ', 'æ', 'ß', 'É', ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')',
  '*', '+', ',', '-', '.', '/', '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', ':', ';', '<', '=', '>', '?', '¡', 'A', 'B', 'C', 'D', 'E',
  'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
  'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§', '¿',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n',
  'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö',
  'ñ', 'ü', 'à',
]);

// GSM 7-bit extended characters (each costs 2 GSM chars — escape + char)
const GSM_7_EXTENDED = new Set([
  '^', '{', '}', '\\', '[', ']', '~', '|', '€',
]);

/**
 * Detect whether a message requires Unicode (UCS-2) encoding.
 */
function isUnicode(message) {
  for (const char of message) {
    if (!GSM_7_BASIC.has(char) && !GSM_7_EXTENDED.has(char)) {
      return true;
    }
  }
  return false;
}

/**
 * Count the effective character length for GSM-7 encoding.
 * Extended GSM characters count as 2 characters each.
 */
function countGsmChars(message) {
  let count = 0;
  for (const char of message) {
    if (GSM_7_EXTENDED.has(char)) {
      count += 2;
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Calculate SMS encoding, character count, segments, and remaining characters.
 *
 * @param {string} message - The SMS message text
 * @returns {{
 *   encoding: 'GSM-7' | 'Unicode',
 *   characterCount: number,
 *   segments: number,
 *   charsPerSegment: number,
 *   remainingChars: number
 * }}
 */
function countSms(message) {
  if (!message || message.length === 0) {
    return {
      encoding: 'GSM-7',
      characterCount: 0,
      segments: 0,
      charsPerSegment: 160,
      remainingChars: 160,
    };
  }

  const unicode = isUnicode(message);
  const encoding = unicode ? 'Unicode' : 'GSM-7';

  const characterCount = unicode ? message.length : countGsmChars(message);

  const singleLimit = unicode ? 70 : 160;
  const multipartLimit = unicode ? 67 : 153;

  let segments;
  let charsPerSegment;
  let remainingChars;

  if (characterCount <= singleLimit) {
    segments = characterCount === 0 ? 0 : 1;
    charsPerSegment = singleLimit;
    remainingChars = singleLimit - characterCount;
  } else {
    segments = Math.ceil(characterCount / multipartLimit);
    charsPerSegment = multipartLimit;
    remainingChars = (segments * multipartLimit) - characterCount;
  }

  return {
    encoding,
    characterCount,
    segments,
    charsPerSegment,
    remainingChars,
  };
}

/**
 * Validate SMS message against segment limits.
 *
 * @param {string} message - The SMS message text
 * @param {number} [maxSegments=10] - Maximum allowed segments
 * @returns {{ valid: boolean, info: object, reason?: string }}
 */
function validateSms(message, maxSegments = 10) {
  const info = countSms(message);

  if (info.segments > maxSegments) {
    return {
      valid: false,
      info,
      reason: `মেসেজটি ${info.segments}টি সেগমেন্ট নিচ্ছে, সর্বোচ্চ ${maxSegments}টি অনুমোদিত`,
    };
  }

  return { valid: true, info };
}

module.exports = { countSms, validateSms, isUnicode };

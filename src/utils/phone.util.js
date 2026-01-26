/**
 * Phone Number Utility
 * Handles Bangladesh phone number formatting and validation
 */

/**
 * Format phone number to Bangladesh format (8801XXXXXXXXX)
 * MimSMS requires this format without + sign
 */
const formatPhone = (phone) => {
  if (!phone) return null;

  // Remove all non-digit characters
  let cleaned = phone.toString().replace(/\D/g, '');

  // Handle different input formats
  if (cleaned.startsWith('0')) {
    // Local format: 01712345678 -> 8801712345678
    cleaned = '88' + cleaned;
  } else if (cleaned.startsWith('88')) {
    // Already in correct format
  } else if (cleaned.startsWith('+88')) {
    // Remove + sign
    cleaned = cleaned.substring(1);
  } else if (cleaned.length === 10) {
    // Missing leading 0: 1712345678 -> 8801712345678
    cleaned = '880' + cleaned;
  } else if (cleaned.length === 11 && !cleaned.startsWith('0')) {
    // 11 digits without leading 0
    cleaned = '88' + cleaned;
  }

  return cleaned;
};

/**
 * Format phone for display (01712-345678)
 */
const formatPhoneDisplay = (phone) => {
  if (!phone) return '';

  let cleaned = phone.toString().replace(/\D/g, '');

  // Convert to local format first
  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  // Format as 01712-345678
  if (cleaned.length === 11) {
    return `${cleaned.substring(0, 5)}-${cleaned.substring(5)}`;
  }

  return cleaned;
};

/**
 * Validate Bangladesh phone number
 */
const isValidPhone = (phone) => {
  if (!phone) return false;

  const cleaned = phone.toString().replace(/\D/g, '');

  // Valid Bangladesh mobile prefixes
  const validPrefixes = [
    '013', '014', '015', '016', '017', '018', '019', // Local
    '8801', // International without +
  ];

  // Check length
  if (cleaned.length !== 11 && cleaned.length !== 13) {
    return false;
  }

  // Check prefix
  const hasValidPrefix = validPrefixes.some(prefix => {
    if (cleaned.length === 11) {
      return cleaned.startsWith(prefix.replace('880', '0'));
    }
    return cleaned.startsWith(prefix);
  });

  return hasValidPrefix;
};

/**
 * Extract local phone number (without country code)
 */
const getLocalPhone = (phone) => {
  if (!phone) return null;

  let cleaned = phone.toString().replace(/\D/g, '');

  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  if (!cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

/**
 * Normalize phone for database storage (consistent format)
 */
const normalizePhone = (phone) => {
  if (!phone) return null;

  let cleaned = phone.toString().replace(/\D/g, '');

  // Store in local format without country code (01712345678)
  if (cleaned.startsWith('88')) {
    cleaned = cleaned.substring(2);
  }

  if (!cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

module.exports = {
  formatPhone,
  formatPhoneDisplay,
  isValidPhone,
  getLocalPhone,
  normalizePhone
};

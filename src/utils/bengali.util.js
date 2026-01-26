/**
 * Bengali Utility
 * Handles Bengali number conversion and date formatting
 */

// Bengali digits
const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

// Bengali months
const BENGALI_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'
];

// Bengali days
const BENGALI_DAYS = [
  'রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'
];

/**
 * Convert English number to Bengali
 */
const toBengaliNumber = (num) => {
  if (num === null || num === undefined) return '';

  return num.toString().replace(/[0-9]/g, (digit) => BENGALI_DIGITS[parseInt(digit)]);
};

/**
 * Convert Bengali number to English
 */
const toEnglishNumber = (bengaliNum) => {
  if (!bengaliNum) return '';

  return bengaliNum.toString().replace(/[০-৯]/g, (digit) => {
    return BENGALI_DIGITS.indexOf(digit).toString();
  });
};

/**
 * Format currency in Bengali (৳১,২৩,৪৫৬)
 */
const formatCurrencyBn = (amount, showSymbol = true) => {
  if (amount === null || amount === undefined) return showSymbol ? '৳০' : '০';

  // Format with Indian/Bangladeshi comma system (xx,xx,xxx)
  const formatted = Math.abs(amount).toLocaleString('en-IN');
  const bengaliFormatted = toBengaliNumber(formatted);

  if (showSymbol) {
    return amount < 0 ? `-৳${bengaliFormatted}` : `৳${bengaliFormatted}`;
  }
  return amount < 0 ? `-${bengaliFormatted}` : bengaliFormatted;
};

/**
 * Format date in Bengali (২৫ জানুয়ারি ২০২৬)
 */
const formatDateBn = (date) => {
  if (!date) return '';

  const d = new Date(date);
  const day = toBengaliNumber(d.getDate());
  const month = BENGALI_MONTHS[d.getMonth()];
  const year = toBengaliNumber(d.getFullYear());

  return `${day} ${month} ${year}`;
};

/**
 * Format date with day name (শনিবার, ২৫ জানুয়ারি ২০২৬)
 */
const formatDateFullBn = (date) => {
  if (!date) return '';

  const d = new Date(date);
  const dayName = BENGALI_DAYS[d.getDay()];
  const dateStr = formatDateBn(date);

  return `${dayName}, ${dateStr}`;
};

/**
 * Format time in Bengali (১০:৩০)
 */
const formatTimeBn = (date) => {
  if (!date) return '';

  const d = new Date(date);
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');

  const period = hours >= 12 ? 'অপরাহ্ন' : 'পূর্বাহ্ন';
  const hour12 = hours % 12 || 12;

  return `${toBengaliNumber(hour12)}:${toBengaliNumber(minutes)} ${period}`;
};

/**
 * Format datetime in Bengali
 */
const formatDateTimeBn = (date) => {
  if (!date) return '';
  return `${formatDateBn(date)} ${formatTimeBn(date)}`;
};

/**
 * Get relative time in Bengali (২ ঘণ্টা আগে, ৩ দিন আগে)
 */
const getRelativeTimeBn = (date) => {
  if (!date) return '';

  const now = new Date();
  const d = new Date(date);
  const diffMs = now - d;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSeconds < 60) {
    return 'এইমাত্র';
  } else if (diffMinutes < 60) {
    return `${toBengaliNumber(diffMinutes)} মিনিট আগে`;
  } else if (diffHours < 24) {
    return `${toBengaliNumber(diffHours)} ঘণ্টা আগে`;
  } else if (diffDays < 30) {
    return `${toBengaliNumber(diffDays)} দিন আগে`;
  } else if (diffMonths < 12) {
    return `${toBengaliNumber(diffMonths)} মাস আগে`;
  } else {
    return `${toBengaliNumber(diffYears)} বছর আগে`;
  }
};

/**
 * Format quantity with unit in Bengali
 */
const formatQuantityBn = (quantity, unit = 'টি') => {
  if (quantity === null || quantity === undefined) return `০ ${unit}`;
  return `${toBengaliNumber(quantity)} ${unit}`;
};

module.exports = {
  BENGALI_DIGITS,
  BENGALI_MONTHS,
  BENGALI_DAYS,
  toBengaliNumber,
  toEnglishNumber,
  formatCurrencyBn,
  formatDateBn,
  formatDateFullBn,
  formatTimeBn,
  formatDateTimeBn,
  getRelativeTimeBn,
  formatQuantityBn
};

/**
 * Product codes, kept to ASCII because they are barcode payloads.
 *
 * THIS IS THE SECOND COPY. The first is `hisaab-frontend/lib/productCode.js`,
 * and the two must agree — same as `quantity.util.js` and `lib/quantity.js`,
 * for the same reason and with the same kind of guard
 * (`hisaab-frontend/scripts/check-code-parity.mjs`).
 *
 * They are duplicated rather than shared because the two packages have no build
 * relationship: the frontend is ESM bundled by webpack, this is CJS loaded by
 * Node, and a migration script has to run on a server where the frontend
 * directory may not be deployed at all.
 *
 * WHY ASCII — the short version. Every category in this app is named in
 * Bengali, and the product form used to build a code as
 * `category.name.slice(0, 3)`, producing `কলম0042`. CODE128 encodes ASCII
 * 0–127 and nothing else, so the label sheet printed the code as text and drew
 * no bars. Nobody checks a label for bars; they find out at the counter.
 *
 * The long version, and the reason the alphabet is narrower than CODE128
 * allows, is in the frontend copy.
 */

/** Bengali and Arabic-Indic digits, which a phone keypad set to Bangla emits. */
const DIGITS = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** Longest match first — conjuncts before their parts. See the frontend copy. */
const BENGALI_TO_LATIN = [
  ['ক্ষ', 'KH'], ['জ্ঞ', 'GG'], ['ঞ্চ', 'NC'], ['ঞ্জ', 'NJ'], ['ন্ত', 'NT'],
  ['ন্দ', 'ND'], ['ম্প', 'MP'], ['ষ্ট', 'ST'], ['স্ট', 'ST'], ['স্ক', 'SK'],
  ['শ্র', 'SR'], ['ত্র', 'TR'], ['প্র', 'PR'], ['ক্র', 'KR'], ['গ্র', 'GR'],
  ['ব্র', 'BR'], ['দ্র', 'DR'], ['ফ্র', 'FR'],
  ['ভ', 'BH'], ['ধ', 'DH'], ['ঝ', 'JH'], ['ঠ', 'TH'], ['থ', 'TH'],
  ['ছ', 'CH'], ['খ', 'KH'], ['ঘ', 'GH'], ['ফ', 'PH'], ['ঢ', 'DH'],
  ['ক', 'K'], ['গ', 'G'], ['ঙ', 'NG'], ['চ', 'C'], ['জ', 'J'], ['ঞ', 'N'],
  ['ট', 'T'], ['ড', 'D'], ['ণ', 'N'], ['ত', 'T'], ['দ', 'D'], ['ন', 'N'],
  ['প', 'P'], ['ব', 'B'], ['ম', 'M'], ['য', 'J'], ['র', 'R'], ['ল', 'L'],
  ['শ', 'S'], ['ষ', 'S'], ['স', 'S'], ['হ', 'H'], ['ড়', 'R'], ['ঢ়', 'R'],
  ['য়', 'Y'], ['ৎ', 'T'],
  ['আ', 'A'], ['অ', 'A'], ['ই', 'I'], ['ঈ', 'I'], ['উ', 'U'], ['ঊ', 'U'],
  ['ঋ', 'RI'], ['এ', 'E'], ['ঐ', 'OI'], ['ও', 'O'], ['ঔ', 'OU'],
  ['া', 'A'], ['ি', 'I'], ['ী', 'I'], ['ু', 'U'], ['ূ', 'U'], ['ৃ', 'RI'],
  ['ে', 'E'], ['ৈ', 'OI'], ['ো', 'O'], ['ৌ', 'OU'],
  ['ং', 'NG'], ['ঃ', 'H'], ['ঁ', ''], ['্', ''],
];

const DEFAULT_CODE_PREFIX = 'PRD';
const CODE_PATTERN = /^[A-Z0-9-]+$/;

const toAsciiDigits = (input) =>
  String(input === undefined || input === null ? '' : input)
    .replace(/[০-৯٠-٩]/g, (d) => (DIGITS[d] === undefined ? d : DIGITS[d]));

const romanise = (text) => {
  let s = toAsciiDigits(text).trim();
  for (const [bn, latin] of BENGALI_TO_LATIN) s = s.split(bn).join(latin);
  return s;
};

const toAsciiPrefix = (name, length = 3) => {
  const cleaned = romanise(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, length) || DEFAULT_CODE_PREFIX;
};

const sanitizeProductCode = (raw) =>
  toAsciiDigits(raw).toUpperCase().replace(/[^A-Z0-9-]/g, '');

const isValidProductCode = (code) =>
  typeof code === 'string' && CODE_PATTERN.test(code);

/**
 * Romanise an existing code in place, keeping as much of it as survives.
 *
 * Used by the migration rather than by any write path: `কলম0042` becomes
 * `KLM0042`, so the digits a shopkeeper may already have written on a shelf
 * label still match. Returns '' when nothing usable is left, and the caller
 * decides what to do about that — this function never invents a code.
 */
const romaniseExistingCode = (raw) =>
  romanise(raw).toUpperCase().replace(/[^A-Z0-9-]/g, '');

module.exports = {
  BENGALI_TO_LATIN,
  DIGITS,
  DEFAULT_CODE_PREFIX,
  CODE_PATTERN,
  toAsciiDigits,
  toAsciiPrefix,
  sanitizeProductCode,
  isValidProductCode,
  romaniseExistingCode,
};

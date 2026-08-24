/**
 * The extra numbers a shop or a branch prints on its invoices.
 *
 * This normaliser is the ONLY thing standing between a text box and a document
 * a customer keeps. It is shared by the shop route (`auth.controller`) and the
 * branch route (`branch.service`) precisely so the two cannot drift, and the
 * cases below are the ones where drifting would show up on paper rather than
 * in an error: a blank row printed as an empty line, the same number printed
 * twice because one copy had a dash in it, or a header long enough to push the
 * invoice title off a 127mm pad.
 *
 * The single most important assertion here is the LAST one — that this does not
 * put a number through `normalizePhone`. Doing so would look like tidying up
 * and would silently corrupt every landline a shop entered.
 */
const {
  normalizeInvoicePhones,
  MAX_INVOICE_PHONES,
  normalizePhone,
} = require('../utils/phone.util');

describe('normalizeInvoicePhones', () => {
  it('keeps a plain list in the order it was given', () => {
    // Order is the shop's decision — these print left to right as entered.
    expect(normalizeInvoicePhones(['01711111111', '01822222222']))
      .toEqual(['01711111111', '01822222222']);
  });

  it('drops blanks and whitespace-only rows', () => {
    // The editor adds an empty row on "+ আরেকটি"; an owner who changes their
    // mind and saves must not get a blank line under their shop name.
    expect(normalizeInvoicePhones(['01711111111', '', '   ', '01822222222']))
      .toEqual(['01711111111', '01822222222']);
  });

  it('de-duplicates on digits, so punctuation cannot smuggle a copy through', () => {
    expect(normalizeInvoicePhones(['01711-111111', '01711111111']))
      .toEqual(['01711-111111']);
  });

  it('drops an entry with no digits in it at all', () => {
    // Not a phone number, and it would print as one.
    expect(normalizeInvoicePhones(['01711111111', 'ফোন', '--'])).toEqual(['01711111111']);
  });

  it('caps the list, because the header has finite room', () => {
    const many = ['01711111111', '01822222222', '01933333333', '01644444444', '01555555555'];
    const out = normalizeInvoicePhones(many);

    expect(out).toHaveLength(MAX_INVOICE_PHONES);
    expect(out).toEqual(many.slice(0, MAX_INVOICE_PHONES));
  });

  it('caps the length of any one entry', () => {
    const out = normalizeInvoicePhones(['0'.repeat(80)]);
    expect(out[0]).toHaveLength(32);
  });

  it('accepts a bare string as a one-entry list', () => {
    expect(normalizeInvoicePhones('01711111111')).toEqual(['01711111111']);
  });

  it('treats absent, null and empty as "no extra numbers"', () => {
    // `[]` is a real instruction — it is how the last extra number is removed —
    // so it has to come back as `[]` and not as anything else.
    expect(normalizeInvoicePhones(undefined)).toEqual([]);
    expect(normalizeInvoicePhones(null)).toEqual([]);
    expect(normalizeInvoicePhones('')).toEqual([]);
    expect(normalizeInvoicePhones([])).toEqual([]);
  });

  it('ignores objects and other junk rather than stringifying them', () => {
    expect(normalizeInvoicePhones([{ n: 1 }, ['x'], true, '01711111111']))
      .toEqual(['01711111111']);
  });

  it('does NOT reformat a landline the way a mobile number would be', () => {
    // The whole reason this function exists instead of reusing `normalizePhone`.
    // A 9-digit landline put through the mobile rules comes out as a number the
    // shop does not recognise as its own, printed on their own stationery.
    const landline = '0781-52345';

    expect(normalizeInvoicePhones([landline])).toEqual([landline]);
    expect(normalizePhone(landline)).not.toEqual(landline);
  });
});

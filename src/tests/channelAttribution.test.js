/**
 * Channel attribution — the online/offline split, over the pure pieces of it.
 *
 * ── WHAT WENT WRONG BEFORE, AND MUST NOT AGAIN ──────────────────────────────
 *
 * Three separate silences added up to a shop being unable to answer "how much
 * of my business is online":
 *
 *   1. `confirmOrder` hardcoded `channel: 'other'` for every manual order.
 *      Manual is how most shops here actually sell, so the one enum a report
 *      could group by was accurate only for the storefront.
 *   2. Nothing in `report.service` grouped by it at all.
 *   3. The till could book `isOnline` sales with no `Order` behind them, so
 *      even a correct grouping would have run over a dirty population.
 *
 * Each has a section here. No database: these are the deterministic halves —
 * the mapping, the schema shape and the lifecycle — which is where a
 * "simplification" would land.
 */

const { channelFromNote, channelForOrder, SALE_CHANNELS } = require('../utils/channel.util');

describe('channel.util — free text to a reporting key', () => {
  test('the exported enum matches Sale.channel exactly', () => {
    // A value this file invents that the schema lacks fails validation at write
    // time — which on the confirm path means a shopkeeper cannot confirm an
    // order because of a typo in a util.
    const Sale = require('../models/Sale.model');
    const schemaEnum = Sale.schema.path('channel').enumValues;
    expect([...SALE_CHANNELS].sort()).toEqual([...schemaEnum].sort());
  });

  describe('the spellings shops actually type', () => {
    const cases = [
      ['Facebook', 'facebook'],
      ['facebook page', 'facebook'],
      ['FB', 'facebook'],
      ['fb', 'facebook'],
      ['ফেসবুক', 'facebook'],
      ['ফেইসবুক', 'facebook'],
      ['messenger', 'facebook'],
      ['ইনবক্স', 'facebook'],
      ['WhatsApp', 'whatsapp'],
      ['হোয়াটসঅ্যাপ', 'whatsapp'],
      ['ওয়াটসঅ্যাপ', 'whatsapp'],
      ['Instagram', 'instagram'],
      ['insta', 'instagram'],
      ['ইনস্টাগ্রাম', 'instagram'],
      ['website', 'website'],
      ['ওয়েবসাইট', 'website'],
    ];
    test.each(cases)('%s maps to %s', (note, expected) => {
      expect(channelFromNote(note)).toBe(expected);
    });
  });

  describe('unrecognised input is `other`, never a guess', () => {
    // The shop's own words survive on `sourceNote`. A wrong guess written into
    // the enum cannot later be told apart from a right one.
    test.each([
      ['ফোন'],
      ['walk in'],
      [''],
      [null],
      [undefined],
      ['   '],
    ])('%s maps to other', (note) => {
      expect(channelFromNote(note)).toBe('other');
    });

    test('a short alias does not match inside an unrelated word', () => {
      // "wa" is WhatsApp as a TOKEN and nothing as a substring. The bug this
      // guards is a naive `raw.includes('wa')` hitting "wardrobe"/"walk-in".
      expect(channelFromNote('wardrobe')).toBe('other');
      expect(channelFromNote('walk-in customer')).toBe('other');
      expect(channelFromNote('wa')).toBe('whatsapp');
    });
  });

  describe('channelForOrder', () => {
    test('a storefront order is website whatever the note says', () => {
      expect(channelForOrder({ source: 'storefront', sourceNote: 'Facebook' })).toBe('website');
    });

    test('a manual order reads its note — NOT a hardcoded other', () => {
      // The regression that made the field useless: every manual order, which
      // is most of them, used to land on 'other'.
      expect(channelForOrder({ source: 'manual', sourceNote: 'ফেসবুক' })).toBe('facebook');
      expect(channelForOrder({ source: 'manual', sourceNote: 'WhatsApp' })).toBe('whatsapp');
    });

    test('a manual order with no note is other', () => {
      expect(channelForOrder({ source: 'manual' })).toBe('other');
    });

    test('every result is a legal Sale.channel value', () => {
      const notes = ['Facebook', 'ফোন', '', 'insta', 'zzz', 'হোয়াটসঅ্যাপ', null];
      for (const source of ['manual', 'storefront']) {
        for (const note of notes) {
          expect(SALE_CHANNELS).toContain(channelForOrder({ source, sourceNote: note }));
        }
      }
    });
  });
});

describe('Sale.order — the reverse link that separates the two populations', () => {
  const Sale = require('../models/Sale.model');

  test('is a nullable ref, so nothing that predates it needs migrating', () => {
    const path = Sale.schema.path('order');
    expect(path).toBeDefined();
    expect(path.options.ref).toBe('Order');
    expect(path.options.default).toBeNull();
  });

  test('its index is PARTIAL, not sparse', () => {
    /**
     * `shop` leads the key and is always present, so a sparse index would index
     * every sale in the collection and the word "sparse" would be decoration —
     * the trap `Payment.receiptNo` hit. Only a partialFilterExpression skips
     * the nulls.
     */
    const entry = Sale.schema.indexes().find(
      ([keys]) => keys.shop === 1 && keys.order === 1
    );
    expect(entry).toBeDefined();
    const [, options] = entry;
    expect(options.partialFilterExpression).toEqual({ order: { $type: 'objectId' } });
    expect(options.sparse).toBeUndefined();
  });
});

describe('Order lifecycle — RTO is its own state', () => {
  const Order = require('../models/Order.model');

  test('returned exists and is distinct from cancelled', () => {
    // Folding RTO into `cancelled` puts "refused a parcel we paid a courier to
    // carry both ways" in the same bucket as "changed their mind before we
    // packed it". The resulting number cannot be used for anything.
    expect(Order.ORDER_STATUSES).toContain('returned');
    expect(Order.ORDER_STATUSES).toContain('cancelled');
  });

  test('returned is NOT a pre-confirm status', () => {
    // An order only reaches it by having been confirmed, shipped and unwound,
    // so a Sale certainly existed.
    expect(Order.PRE_CONFIRM_STATUSES).not.toContain('returned');
  });

  test('the status enum on the document matches the exported list', () => {
    const enumValues = Order.schema.path('status').enumValues;
    expect([...enumValues].sort()).toEqual([...Order.ORDER_STATUSES].sort());
  });

  test('RTO carries its own trio, separate from the cancel one', () => {
    // So "how many parcels came back, and why" does not also sweep in every
    // order called off before it shipped.
    for (const field of ['returnedAt', 'returnedBy', 'returnReason']) {
      expect(Order.schema.path(field)).toBeDefined();
    }
  });
});

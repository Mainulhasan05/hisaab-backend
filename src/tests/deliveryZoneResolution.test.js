/**
 * The delivery charge is derived from WHERE the customer is — not from what
 * the customer's browser asked to pay.
 *
 * THE HOLE THIS CLOSES: `resolveDelivery` used to take a `zoneKey` off the
 * public checkout body, check the key existed in the shop's zone table, and
 * charge it. Nothing tied that key to the customer's actual location, so a
 * customer in Rangpur could post `zoneKey: 'inside-dhaka'` and be charged ৳৬০
 * for a ৳১২০ parcel — the client choosing a price, which is the exact thing
 * I-10 forbids for product prices.
 *
 * Now the body carries a district and an area, and the zone is resolved
 * server-side. These tests are the guard on that: the money rule, at the layer
 * that owns it.
 *
 * Real model and real dataset, no database — `resolveDelivery` is pure.
 */

const mongoose = require('mongoose');
const Storefront = require('../models/Storefront.model');
const orderService = require('../services/order.service');
const { findDistrict, resolveAddress } = require('../utils/bdGeo.util');

const storefront = (over = {}) => {
  const sf = new Storefront({ shop: new mongoose.Types.ObjectId(), ...over });
  return sf;
};

describe('bdGeo — the place list is the authority', () => {
  it('resolves a district by English name, Bangla name, and sloppy casing', () => {
    expect(findDistrict('Dhaka').name).toBe('Dhaka');
    expect(findDistrict('ঢাকা').name).toBe('Dhaka');
    expect(findDistrict('  DHAKA ').name).toBe('Dhaka');
  });

  it("survives the apostrophe in Cox's Bazar however it arrives", () => {
    for (const spelling of ["Cox's Bazar", 'Coxs Bazar', "COX'S  BAZAR", 'কক্সবাজার']) {
      expect(findDistrict(spelling)?.name).toBe("Cox's Bazar");
    }
  });

  it('refuses a district that does not exist', () => {
    expect(findDistrict('Atlantis')).toBeNull();
    expect(resolveAddress({ district: 'Atlantis' }).ok).toBe(false);
  });

  /**
   * The ambiguity that a global sub-district index would have introduced:
   * Savar is a real upazila, but it is not in Cumilla. Accepting it there
   * would let a customer name any cheap area from any district.
   */
  it('scopes sub-districts to their own district', () => {
    expect(resolveAddress({ district: 'Dhaka', subdistrict: 'Savar' }).ok).toBe(true);
    expect(resolveAddress({ district: 'Cumilla', subdistrict: 'Savar' }).ok).toBe(false);
  });

  it('requires a sub-district by default and lets manual entry opt out', () => {
    expect(resolveAddress({ district: 'Dhaka' }).ok).toBe(false);
    expect(resolveAddress({ district: 'Dhaka' }, { requireSubdistrict: false }).ok).toBe(true);
  });
});

describe('resolveDelivery — zone derived from the address', () => {
  it('charges the inside-Dhaka rate for a Dhaka CITY area', () => {
    const d = orderService.resolveDelivery(storefront(), {
      district: 'Dhaka', subdistrict: 'Dhanmondi',
    });
    expect(d.zoneKey).toBe('inside-dhaka');
    expect(d.charge).toBe(60);
  });

  /**
   * The case that district-level mapping alone cannot express, and the reason
   * `zones[].areas` exists. Savar is in Dhaka DISTRICT but not Dhaka CITY, and
   * essentially every shop prices it as outside.
   */
  it('charges the outside rate for a rural upazila of Dhaka district', () => {
    const d = orderService.resolveDelivery(storefront(), {
      district: 'Dhaka', subdistrict: 'Savar',
    });
    expect(d.zoneKey).toBe('outside-dhaka');
    expect(d.charge).toBe(120);
  });

  it('is language-blind — Bangla input resolves to the same zone', () => {
    const bn = orderService.resolveDelivery(storefront(), {
      district: 'ঢাকা', subdistrict: 'ধানমন্ডি',
    });
    const en = orderService.resolveDelivery(storefront(), {
      district: 'Dhaka', subdistrict: 'Dhanmondi',
    });
    expect(bn.charge).toBe(en.charge);
    expect(bn.district).toBe('Dhaka');
  });

  it('falls back to the named default zone for an unmapped district', () => {
    const d = orderService.resolveDelivery(storefront(), {
      district: 'Rangpur', subdistrict: 'Pirganj',
    });
    expect(d.zoneKey).toBe('outside-dhaka');
  });

  /**
   * Never charge zero by omission. A shop whose configuration does not cover
   * an address and which has cleared its fallback is refusing that order — and
   * must say so, rather than delivering it free.
   */
  it('refuses rather than free-delivers when nothing covers the address', () => {
    const sf = storefront();
    sf.delivery.defaultZoneKey = undefined;
    sf.delivery.zones = sf.delivery.zones.filter((z) => z.key === 'inside-dhaka');
    expect(() =>
      orderService.resolveDelivery(sf, { district: 'Rangpur', subdistrict: 'Pirganj' })
    ).toThrow();
  });

  it('refuses an address the geography does not contain', () => {
    expect(() =>
      orderService.resolveDelivery(storefront(), { district: 'Atlantis', subdistrict: 'X' })
    ).toThrow();
  });

  /** A zone switched off must not price anything, default or otherwise. */
  it('ignores an inactive zone', () => {
    const sf = storefront();
    sf.delivery.zones.find((z) => z.key === 'inside-dhaka').isActive = false;
    const d = orderService.resolveDelivery(sf, { district: 'Dhaka', subdistrict: 'Dhanmondi' });
    expect(d.zoneKey).toBe('outside-dhaka');
  });

  it('honours pickup only when the shop offers it', () => {
    const sf = storefront();
    expect(() => orderService.resolveDelivery(sf, {}, { pickup: true })).toThrow();
    sf.delivery.pickupEnabled = true;
    const d = orderService.resolveDelivery(sf, {}, { pickup: true });
    expect(d.isPickup).toBe(true);
    expect(d.charge).toBe(0);
  });

  /** The snapshot the packing slip prints and a courier API will consume. */
  it('snapshots canonical place names in both languages', () => {
    const d = orderService.resolveDelivery(storefront(), {
      district: 'ঢাকা', subdistrict: 'ধানমন্ডি',
    });
    expect(d.district).toBe('Dhaka');
    expect(d.districtBn).toBe('ঢাকা');
    expect(d.subdistrict).toBe('Dhanmondi');
    expect(d.subdistrictBn).toBe('ধানমন্ডি');
  });

  /**
   * Free delivery is applied after the subtotal is known, and it must not
   * resurrect a charge the threshold cleared.
   */
  it('applies the per-zone free-delivery threshold', () => {
    const sf = storefront();
    sf.delivery.zones.find((z) => z.key === 'inside-dhaka').freeAbove = 1000;
    const base = orderService.resolveDelivery(sf, { district: 'Dhaka', subdistrict: 'Dhanmondi' });
    expect(orderService.applyFreeDelivery(sf, base, 999).charge).toBe(60);
    expect(orderService.applyFreeDelivery(sf, base, 1000).charge).toBe(0);
  });
});

describe('the seeded shop is correct out of the box', () => {
  /**
   * A shop that configures nothing must still price Dhaka correctly, because
   * most never open the settings screen. If this fails, every new shop
   * overcharges its busiest route.
   */
  it('seeds inside-Dhaka with the city areas and a fallback', () => {
    const sf = storefront();
    const inside = sf.delivery.zones.find((z) => z.key === 'inside-dhaka');
    expect(inside.areas.length).toBeGreaterThan(100);
    expect(inside.areas).toContain('Dhanmondi');
    // The trap: rural Dhaka must NOT be in the ৳৬০ zone.
    expect(inside.areas).not.toContain('Savar');
    expect(sf.delivery.defaultZoneKey).toBe('outside-dhaka');
  });
});

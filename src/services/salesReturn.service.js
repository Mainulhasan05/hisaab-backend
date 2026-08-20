const SalesReturn = require('../models/SalesReturn.model');
const Sale = require('../models/Sale.model');
const Product = require('../models/Product.model');
const Customer = require('../models/Customer.model');
const CustomerBalance = require('../models/CustomerBalance.model');
const Payment = require('../models/Payment.model');
const paymentAccountService = require('./paymentAccount.service');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS } = require('../config/constants');
const { branchFilter, requireBranch } = require('../utils/branchScope.util');
const saleService = require('./sale.service');
const dueSettlementService = require('./dueSettlement.service');
const mongoose = require('mongoose');
const { runInTransaction } = require('../utils/transaction.util');
const {
  parseQuantity,
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
  buildStockUpdate,
  buildVariantStockRollupUpdate,
} = require('../utils/quantity.util');
const { restoreBatches, batchWriteOp } = require('../utils/batch.util');
const { findComponentVariant } = require('../utils/combo.util');
const { discountAmountFor, toMoney, taxAmountFor } = require('../utils/invoiceMath.util');

// The invoice-level discount in taka, from the same bounded definition the sale
// itself was totalled with. This used to repeat the arithmetic unbounded: a
// fixed discount larger than the subtotal, or a percentage above 100, allocated
// MORE discount across the returned lines than the invoice ever gave — so the
// refund came out below zero while `Sale` had clamped the discount to the
// subtotal. See invoiceMath.util.js.
const getInvoiceDiscountAmount = (sale) =>
  discountAmountFor(sale.subtotal, sale.discount, sale.discountType);

const getInvoiceDiscountShareForItem = (sale, saleItem) => {
  const subtotal = Number(sale.subtotal) || 0;
  if (subtotal <= 0) return 0;

  const itemTotal = Number.isFinite(Number(saleItem.total))
    ? Number(saleItem.total)
    : ((Number(saleItem.unitPrice) || 0) * (Number(saleItem.quantity) || 0)) - (Number(saleItem.discount) || 0);

  return (getInvoiceDiscountAmount(sale) * Math.max(0, itemTotal)) / subtotal;
};

class SalesReturnService {
  /**
   * Create a sales return
   */
  async createReturn(shopId, userId, returnData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const { saleId, items, refundMethod, paymentMethod, reason, notes } = returnData;

    // 1. Fetch the sale — scoped, so a sale from another branch is not even
    // visible here. Previously this was shop-only: a cashier could open a
    // return against another branch's sale, and step 2 below would then book
    // the refund into that branch (FEATURE_AUDIT.md H-4).
    const sale = await Sale.findOne(branchFilter(req, { _id: saleId, shop: shopId }))
      .session(session || null);
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    // Returns happen at the branch that made the sale (product decision #10).
    // For an owner in "All Branches" the filter above is a no-op, so the sale's
    // own branch is enforced here instead of silently accepting the mismatch.
    const branchId = sale.branch || null;
    if (req?.shop?.multiBranchEnabled && req.branchId && String(req.branchId) !== String(branchId || '')) {
      throw new AppError(
        'This sale belongs to another branch. Switch to that branch to process the return.',
        'এই বিক্রয়টি অন্য শাখার। ফেরত নিতে ওই শাখায় যান।',
        403
      );
    }

    // 2. Validate sale status
    if (sale.status === 'cancelled') {
      throw new AppError(
        'বাতিল বিক্রয় থেকে মাল ফেরত নেওয়া যাবে না',
        'Cannot return from cancelled sale',
        400
      );
    }

    // 3. Validate refundMethod='adjustment' requires customer
    if (refundMethod === 'adjustment' && !sale.customer) {
      throw new AppError(
        'Walk-in কাস্টমারের জন্য বাকি সমন্বয় করা যাবে না',
        'Cannot adjust due for walk-in customer',
        400
      );
    }

    // 3b. A reason is mandatory on every NEW return.
    //
    // Enforced here rather than in the schema on purpose: returns written before
    // this rule have no reason, and a schema-level `required` would make each of
    // them fail validation on any future save. The service only ever sees new
    // ones, so this is the boundary where the rule can be absolute without
    // stranding existing data.
    if (!reason || !String(reason).trim()) {
      throw new AppError(
        'A return reason is required',
        'ফেরতের কারণ লিখুন',
        400
      );
    }

    // 4. Build already-returned map from existing returns
    const existingReturns = await SalesReturn.find({ shop: shopId, sale: saleId }).session(session || null);
    const alreadyReturnedMap = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        const key = ri.saleItemId.toString();
        alreadyReturnedMap[key] = (alreadyReturnedMap[key] || 0) + ri.quantity;
      }
    }

    // Products for the sale items being returned. Fetched once, up front, so
    // the per-item loop can resolve each unit's precision without an N+1 —
    // step 8 below re-fetches them for the stock write inside the transaction.
    // Not branch-filtered: the sale has already been branch-checked above, and
    // a product moved or deleted since must not block a legitimate refund.
    const returnProductIds = [...new Set(
      (items || [])
        .map((ri) => {
          const si = (sale.items && typeof sale.items.id === 'function')
            ? sale.items.id(ri.saleItemId)
            : sale.items?.find(i => (i._id || i.id)?.toString() === ri.saleItemId?.toString());
          return si ? String(si.product) : null;
        })
        .filter(Boolean)
    )];
    const returnProducts = returnProductIds.length
      ? await Product.find({ shop: shopId, _id: { $in: returnProductIds } })
        .select('_id unit')
        .session(session || null)
        .lean()
      : [];
    const returnProductMap = new Map(returnProducts.map(p => [String(p._id), p]));

    // 5. Process and validate each return item
    const processedItems = [];
    let totalRefundAmount = 0;
    let totalProfitReduction = 0;

    for (const returnItem of items) {
      const saleItem = (sale.items && typeof sale.items.id === 'function')
        ? sale.items.id(returnItem.saleItemId)
        : sale.items?.find(i => (i._id || i.id)?.toString() === returnItem.saleItemId?.toString());
      if (!saleItem) {
        throw new AppError(
          'বিক্রিত আইটেম পাওয়া যায়নি',
          `Sale item not found: ${returnItem.saleItemId}`,
          404
        );
      }

      const alreadyReturned = alreadyReturnedMap[returnItem.saleItemId.toString()] || 0;
      const maxReturnable = saleItem.quantity - alreadyReturned;

      // A return must be expressible in the same unit the sale was, so this
      // resolves the unit from the PRODUCT and not from a client-supplied
      // field. A 0.5 kg return against a 2 kg sale is valid; a 0.5 piece return
      // is refused by `parseQuantity` because 'piece' is `decimals: 0`.
      //
      // `returnProduct` may be null for a product deleted since the sale — the
      // sale item itself is the source of truth for what may be returned, so a
      // missing product falls back to the flag-off precision rather than
      // blocking the refund.
      const returnProduct = returnProductMap.get(String(saleItem.product));
      returnItem.quantity = parseQuantity(
        returnItem.quantity,
        quantityUnit(req, returnProduct),
        { label: saleItem.productName }
      );

      if (returnItem.quantity > maxReturnable) {
        throw new AppError(
          `"${saleItem.productName}" এর সর্বোচ্চ ${maxReturnable}টি ফেরত দেওয়া যাবে`,
          `Cannot return more than ${maxReturnable} of ${saleItem.productName}`,
          400
        );
      }

      // Calculate proportional item-level and invoice-level discounts.
      const perUnitItemDiscount = saleItem.quantity > 0 ? (saleItem.discount || 0) / saleItem.quantity : 0;
      const itemReturnItemDiscount = perUnitItemDiscount * returnItem.quantity;
      const invoiceDiscountShare = getInvoiceDiscountShareForItem(sale, saleItem);
      const perUnitInvoiceDiscount = saleItem.quantity > 0 ? invoiceDiscountShare / saleItem.quantity : 0;
      const itemReturnInvoiceDiscount = perUnitInvoiceDiscount * returnItem.quantity;
      // Rounded to paisa. Every term above is a division by `saleItem.quantity`,
      // which may now be fractional — 1000/3 is 333.33333333333337, and an
      // unrounded refund total lands on the invoice and in the cash register.
      const itemReturnDiscount = quantizeMoney(itemReturnItemDiscount + itemReturnInvoiceDiscount);
      const itemReturnTotal = quantizeMoney((saleItem.unitPrice * returnItem.quantity) - itemReturnDiscount);
      const itemProfitLoss = quantizeMoney(((saleItem.unitPrice - (saleItem.buyingPrice || 0)) * returnItem.quantity) - itemReturnDiscount);

      const processedItem = {
        saleItemId: saleItem._id,
        product: saleItem.product,
        productName: saleItem.productName,
        productCode: saleItem.productCode,
        variantId: saleItem.variantId,
        variantSku: saleItem.variantSku,
        variantAttributes: saleItem.variantAttributes,
        quantity: returnItem.quantity,
        unitPrice: saleItem.unitPrice,
        buyingPrice: saleItem.buyingPrice || 0,
        discount: itemReturnDiscount,
        total: itemReturnTotal,
        profitLoss: itemProfitLoss,
        reason: returnItem.reason || reason || '',
      };

      // ── Combo lines return WHOLE ─────────────────────────────────────────
      //
      // A combo is one priced thing; "kept the shampoo, returned the soap"
      // has no per-component price to refund against, so it is not offered.
      // `parseQuantity` above already forced the quantity to whole combos
      // (a combo's unit is integer). Scale the sale's frozen component
      // snapshot to this return, and the stock loop below restores from it.
      if (saleItem.itemType === 'combo' && Array.isArray(saleItem.comboComponents)) {
        processedItem.itemType = 'combo';
        processedItem.comboComponents = saleItem.comboComponents.map((c) => ({
          product: c.product,
          productName: c.productName,
          productCode: c.productCode,
          variantId: c.variantId || null,
          variantSku: c.variantSku,
          variantAttributes: c.variantAttributes,
          unit: c.unit,
          quantityPerCombo: c.quantityPerCombo,
          // Rounded at write time in the stock loop, where the component's
          // unit precision is known; this keeps float noise out of the record.
          totalQuantity: Math.round(c.quantityPerCombo * returnItem.quantity * 1e6) / 1e6,
          unitCost: c.unitCost || 0,
        }));
      }

      processedItems.push(processedItem);

      totalRefundAmount = quantizeMoney(totalRefundAmount + itemReturnTotal);
      totalProfitReduction = quantizeMoney(totalProfitReduction + itemProfitLoss);
    }

    /**
     * The VAT coming back with the goods, and the two figures that follow.
     *
     * `taxRefund` is the invoice's OWN rate applied to the merchandise being
     * returned — `sale.taxRate`, snapshotted at checkout, not the rate the shop
     * happens to be configured at today. A shop that moved from 5% to 15% last
     * month must refund the 5% it actually charged.
     *
     * `refundTotal` is what the customer is owed: goods plus the tax on them.
     * It is what every MONEY path below moves — the refund `Payment`, the fund
     * account debit, `Customer.totalPurchases` (which accumulates `sale.total`,
     * VAT included, so it has to come off the same way) and the due write-down.
     *
     * `totalRefundAmount` stays merchandise-only and keeps its one job: feeding
     * `Sale.returnedAmount`, which is compared against the invoice's
     * merchandise base to decide whether everything has come back. See the note
     * on that comparison, and on `SalesReturn.totalAmount`.
     */
    const taxRefund = taxAmountFor(totalRefundAmount, 0, sale.taxRate);
    const refundTotal = quantizeMoney(totalRefundAmount + taxRefund);

    // 6. Generate return number
    const returnNo = await SalesReturn.generateReturnNo(shopId);

    // 7. Create SalesReturn document
    /**
     * Which fund account this refund will come out of.
     *
     * Resolved BEFORE the document is written so it can be stored on it in one
     * pass — a post-hoc assignment would need a second `save()` inside the
     * transaction for a field that was knowable all along.
     *
     * Only a CASH refund moves money. An `adjustment` writes down the
     * customer's due, and an unsettled `store_credit` moves nothing at all
     * until `settleRefund` pays it — which is the entire reason `refundStatus`
     * exists. So the other two methods leave this null and debit nothing.
     */
    const refundAccount = refundMethod === 'cash'
      ? (returnData.account
          ? (await paymentAccountService.assertUsableAccount(shopId, returnData.account, req))._id
          : await paymentAccountService.resolveAccountForMethod(
              req?.shop || { _id: shopId }, paymentMethod || 'cash', req
            ))
      : null;

    const [salesReturn] = await SalesReturn.create([{
      shop: shopId,
      branch: branchId,
      account: refundAccount,
      returnNo,
      sale: sale._id,
      invoiceNo: sale.invoiceNo,
      customer: sale.customer,
      customerName: sale.customerName,
      customerPhone: sale.customerPhone,
      items: processedItems,
      totalAmount: totalRefundAmount,
      taxRefund,
      profitReduction: totalProfitReduction,
      refundMethod,
      paymentMethod: refundMethod === 'cash' ? (paymentMethod || 'cash') : undefined,
      // `store_credit` is the shop promising to pay later, so it is the only
      // method that leaves the return open. Cash moves now; adjustment settles
      // against the customer's due now. See the field's note on the model.
      refundStatus: refundMethod === 'store_credit' ? 'pending' : 'settled',
      reason,
      notes,
      createdBy: userId,
    }], sessionOpt);

    // 8. Restore stock for each returned item.
    //
    // Batched: one read for every returned product, one bulkWrite, one ledger
    // insert — replacing a findById + save + create per line
    // (PERFORMANCE_AUDIT.md H-3).
    //
    // The arithmetic is deliberately untouched, including the variant ROLLUP:
    // a variant return rewrites `variants[n].stock` AND recomputes
    // `product.stock` as the quantized sum across all variants. Both have to
    // ride in the same update, which is why the variant op below sets two
    // paths. Dropping the rollup would leave the product-level total stale on
    // every variant return.
    //
    // Two lines returning different variants of the SAME product each push
    // their own op; each recomputes the rollup from the in-memory document,
    // which has already absorbed the earlier line. bulkWrite is ordered, so the
    // last op for that product carries the correct final total.
    // Distinct from `returnProductMap` above, which is a `.lean()` projection of
    // just `_id` and `unit` used for precision resolution — it carries no
    // `stock` or `variants` and so cannot back a stock write. These are the
    // full documents.
    // Combo lines restore onto their COMPONENT products, not the combo doc.
    const stockProductIds = [...new Set(processedItems.flatMap(i => {
      if (i.itemType === 'combo' && Array.isArray(i.comboComponents)) {
        return i.comboComponents.map(c => String(c.product));
      }
      return [String(i.product)];
    }))];
    const stockProducts = await Product.find({
      _id: { $in: stockProductIds }, shop: shopId,
    }).session(session || null);
    const stockProductMap = new Map(stockProducts.map(p => [String(p._id), p]));

    const returnStockOps = [];
    const returnTxns = [];

    for (const item of processedItems) {
      // ── Combo line: restore each component from the return's snapshot ─────
      if (item.itemType === 'combo' && Array.isArray(item.comboComponents)) {
        for (const c of item.comboComponents) {
          const comp = stockProductMap.get(String(c.product));
          if (!comp) continue;

          const compStkUnit = storageUnit(comp);
          const restoreQty = quantize(c.totalQuantity, compStkUnit);
          let compPrev;
          let compNew;

          if (c.variantId && comp.hasVariants) {
            const variant = findComponentVariant(comp, c.variantId);
            if (variant) {
              compPrev = variant.stock;
              variant.stock = quantize(variant.stock + restoreQty, compStkUnit);
              compNew = variant.stock;
            }
            // Same rollup rule as the standard branch below.
            comp.stock = quantize(
              comp.variants.reduce((sum, v) => quantize(sum + v.stock, compStkUnit), 0),
              compStkUnit
            );
            if (variant) {
              // Delta, applied server-side — see `buildVariantStockRollupUpdate`
              // for why the previous absolute `$set` was a lost-update race.
              returnStockOps.push({
                updateOne: {
                  filter: { _id: comp._id },
                  update: buildVariantStockRollupUpdate(c.variantId, restoreQty, compStkUnit),
                },
              });
            }
          } else {
            compPrev = comp.stock;
            comp.stock = quantize(comp.stock + restoreQty, compStkUnit);
            compNew = comp.stock;
            returnStockOps.push({
              updateOne: {
                filter: { _id: comp._id },
                update: buildStockUpdate(restoreQty, compStkUnit),
              },
            });
          }

          if (restoreBatches(comp, c.variantId || null, restoreQty)) {
            returnStockOps.push(batchWriteOp(comp));
          }

          returnTxns.push({
            shop: shopId,
            branch: branchId,
            product: c.product,
            productName: c.productName,
            productCode: c.productCode,
            variantId: c.variantId || null,
            variantSku: c.variantSku,
            variantAttributes: c.variantAttributes,
            type: 'return',
            quantity: restoreQty,
            previousStock: compPrev || 0,
            newStock: compNew || 0,
            reference: {
              type: 'return',
              id: salesReturn._id,
              invoiceNo: returnNo,
            },
            notes: `মাল ফেরত: ${returnNo} (কম্বো: ${item.productName}, বিক্রয়: ${sale.invoiceNo})`,
            viaCombo: {
              product: item.product,
              name: item.productName,
              code: item.productCode,
              comboQuantity: item.quantity,
            },
            createdBy: userId,
          });
        }
        continue;
      }

      const product = stockProductMap.get(String(item.product));
      if (!product) continue;

      let previousStock, newStock;
      const stkUnit = storageUnit(product);

      if (item.variantId && product.hasVariants) {
        const variant = (product.variants && typeof product.variants.id === 'function')
          ? product.variants.id(item.variantId)
          : product.variants?.find(v => (v._id || v.id)?.toString() === item.variantId?.toString());
        if (variant) {
          previousStock = variant.stock;
          variant.stock = quantize(variant.stock + item.quantity, stkUnit);
          newStock = variant.stock;
        }
        // Rolled-up total across variants — also quantized, or summing a
        // dozen 3-decimal variant stocks reintroduces the drift the
        // individual writes just eliminated.
        product.stock = quantize(
          product.variants.reduce((sum, v) => quantize(sum + v.stock, stkUnit), 0),
          stkUnit
        );

        if (variant) {
          // The variant delta AND the rollup, both derived server-side from the
          // document at write time. This was an absolute `$set` of two numbers
          // computed in JS from an unguarded read — see
          // `buildVariantStockRollupUpdate` for the race that lost returned
          // stock when two returns for one product overlapped.
          returnStockOps.push({
            updateOne: {
              filter: { _id: product._id },
              update: buildVariantStockRollupUpdate(item.variantId, item.quantity, stkUnit),
            },
          });
        }
      } else {
        previousStock = product.stock;
        product.stock = quantize(product.stock + item.quantity, stkUnit);
        newStock = product.stock;
        returnStockOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: buildStockUpdate(item.quantity, stkUnit),
          },
        });
      }

      // ── Put the goods back into a batch ──────────────────────────────────
      //
      // A return adds stock, and until now it added stock ONLY — `batches` was
      // not mentioned anywhere in this file. So every return widened the gap
      // between `stock` and `sum(batches.quantity)`, and a shop with a busy
      // returns counter drifted fastest. The expiry screen then under-reports:
      // it warns about less stock than is actually on the shelf, which is the
      // quiet direction and therefore the dangerous one.
      //
      // Restored to the LONGEST-dated batch, because FEFO sold the shortest
      // first — crediting a return to an about-to-expire batch would invent an
      // expiry warning for goods that are not short-dated. See batch.util.
      //
      // A product whose batches were all sold through has nothing to restore
      // into; the stock still returns and shows up as `untracked` on the batch
      // panel rather than being silently invented with a made-up date.
      if (restoreBatches(product, item.variantId || null, item.quantity)) {
        returnStockOps.push(batchWriteOp(product));
      }

      // Create stock transaction
      returnTxns.push({
        shop: shopId,
        branch: branchId,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        variantId: item.variantId || null,
        variantSku: item.variantSku,
        variantAttributes: item.variantAttributes,
        type: 'return',
        quantity: item.quantity,
        previousStock: previousStock || 0,
        newStock: newStock || 0,
        reference: {
          type: 'return',
          id: salesReturn._id,
          invoiceNo: returnNo,
        },
        notes: `মাল ফেরত: ${returnNo} (বিক্রয়: ${sale.invoiceNo})`,
        createdBy: userId,
      });
    }

    if (returnStockOps.length > 0) {
      await Product.bulkWrite(returnStockOps, sessionOpt);
    }
    if (returnTxns.length > 0) {
      await StockTransaction.insertMany(returnTxns, sessionOpt);
    }

    // 9. Update the Sale.
    //
    // ── Written through the ACCUMULATORS, not as computed end-values ─────────
    //
    // `returnedAmount` / `returnedAdjustment` / `returnedProfit` are the three
    // inputs `Sale.pre('save')` needs to derive `due` and `profit` (see the
    // block comment on those fields). Setting the derived values directly is
    // what made this fragile before: it was done with `updateOne` precisely to
    // dodge the hook, and then any other save of the document — recordPayment,
    // cancelSale — recomputed `due` and `profit` from `items` alone and threw
    // the return away. Collecting the rest of a due on a partly-returned
    // invoice put back the money the return had just taken off it.
    //
    // Now the hook owns the derivation and the derivation is idempotent, so the
    // same values are still written here (an `updateOne` skips the hook) and
    // any later `save()` arrives at exactly the same answer instead of a
    // different one.
    //
    // ── Where a refund lands ────────────────────────────────────────────────
    //
    // Only an `adjustment` refund settles against the due — that is what
    // "সমন্বয়" means. A CASH refund hands money back and leaves the obligation
    // untouched; `store_credit` does nothing until `settleRefund` pays it out.
    //
    // This used to force `due = 0` on any full return regardless of method,
    // which wrote off debt with no counterpart anywhere. A ৳1000 invoice with
    // ৳300 paid, fully refunded in cash, paid out ৳1000, showed as settled, and
    // left the customer owing ৳700 on `Customer.totalDue` with nothing on the
    // invoice to account for it.
    const newReturnedAmount = quantizeMoney((sale.returnedAmount || 0) + totalRefundAmount);
    const newReturnedProfit = quantizeMoney((sale.returnedProfit || 0) + totalProfitReduction);
    const newReturnedAdjustment = quantizeMoney(
      // VAT-inclusive: the due this writes down was billed with the tax on it,
      // so settling a return against the খাতা has to clear the tax as well or
      // the customer keeps owing the VAT on goods they handed back.
      (sale.returnedAdjustment || 0) + (refundMethod === 'adjustment' ? refundTotal : 0)
    );

    // `ledgerSettled` is the third due-reducing term (see `invoiceMath.util`):
    // khata money already allocated onto this invoice. Omitting it here would
    // re-open a due the shop has collected the moment anything is returned —
    // the same class of bug this term was added to fix, arriving through the
    // returns door instead.
    //
    // It is capped rather than trusted, because a return SHRINKS what this
    // invoice can absorb: an invoice carrying ৳4,200 of allocation that is then
    // adjusted down to a ৳3,000 obligation is holding ৳1,200 that belongs on
    // some other invoice. Capping it here keeps the document self-consistent;
    // `reallocateCustomerInvoices` below moves the freed ৳1,200 where it goes.
    const newLedgerSettled = Math.min(
      sale.ledgerSettled || 0,
      Math.max(0, quantizeMoney((sale.total || 0) - (sale.paid || 0) - newReturnedAdjustment))
    );
    const newDue = Math.max(
      0,
      quantizeMoney(
        (sale.total || 0) - (sale.paid || 0) - newReturnedAdjustment - newLedgerSettled
      )
    );
    const newProfit = quantizeMoney(
      (sale.profit || 0) + (sale.returnedProfit || 0) - newReturnedProfit
    );

    // ── "Fully returned" is measured against the GOODS, not the invoice ──────
    //
    // `returnedAmount` only ever accumulates line refunds, i.e. the merchandise
    // net of the invoice discount. `sale.total` additionally carries `tax` and
    // `deliveryCharge`, and a return refunds neither — the courier was still
    // paid, the tax was still collected.
    //
    // Comparing the two therefore made a full return IMPOSSIBLE to detect on any
    // sale with a delivery charge or tax: every item could come back through the
    // door and the invoice would stay open, never get its `cancelReason`, and
    // keep sitting on the dues list. Online orders, which always carry delivery,
    // could never be closed out at all.
    //
    // `merchandise` is `subtotal - discountAmount` — the exact base the refunds
    // are drawn from — so the comparison is now like for like.
    const returnableBase = toMoney(
      Math.max(0, (sale.subtotal || 0) - getInvoiceDiscountAmount(sale))
    );

    // Fully returned AND nothing left owing is the only case that closes the
    // invoice out. A fully-returned sale that still carries a due is not
    // 'cancelled' — marking it so would hide it from the dues list (which
    // excludes cancelled) while `Customer.totalDue` kept counting it, which is
    // the same divergence in a different place.
    const isFullyReturned = returnableBase > 0 && newReturnedAmount >= returnableBase - 0.01;
    let newStatus = sale.status;
    if (sale.status !== 'cancelled') {
      if (isFullyReturned && newDue === 0) {
        newStatus = 'cancelled';
      } else if (newDue === 0) {
        newStatus = 'completed';
      } else if ((sale.paid || 0) > 0 || newLedgerSettled > 0) {
        // Khata money allocated here counts towards 'partial' for the same
        // reason tendered money does — see `statusFor`. Without it an invoice
        // the customer has paid ৳2,000 against through বাকি আদায় goes back to
        // reading 'unpaid' the moment anything is returned.
        newStatus = 'partial';
      } else {
        newStatus = 'unpaid';
      }
    }

    const saleUpdate = {
      returnedAmount: newReturnedAmount,
      returnedAdjustment: newReturnedAdjustment,
      returnedProfit: newReturnedProfit,
      ledgerSettled: newLedgerSettled,
      profit: newProfit,
      due: newDue,
      status: newStatus,
    };

    if (isFullyReturned) {
      saleUpdate.cancelledAt = new Date();
      saleUpdate.cancelledBy = userId;
      saleUpdate.cancelReason = `Fully returned via ${returnNo}`;
      saleUpdate.notes = `${sale.notes || ''}\nFully returned: ${returnNo}`;
    }

    await Sale.updateOne(
      { _id: sale._id },
      { $set: saleUpdate },
      sessionOpt
    );

    // 10. Handle refund by method
    if (refundMethod === 'cash') {
      // Create refund payment
      await Payment.create([{
        shop: shopId,
        branch: branchId,
        sale: sale._id,
        customer: sale.customer,
        // Goods plus their VAT — what actually crosses the counter. The
        // merchandise-only figure would hand back less than the customer paid.
        amount: refundTotal,
        method: paymentMethod || 'cash',
        account: refundAccount,
        type: 'refund',
        reference: returnNo,
        notes: `মাল ফেরত: ${returnNo}`,
        receivedBy: userId,
      }], sessionOpt);

      // Money out — the shop has handed cash back across the counter.
      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: refundAccount,
        amount: -(Number(refundTotal) || 0),
        session: session || null,
      });

      // Adjust customer totals for cash refund
      if (sale.customer) {
        await Customer.findByIdAndUpdate(sale.customer, {
          $inc: {
            // `totalPurchases` accumulates `sale.total`, which carries the VAT,
            // so the reversal has to carry it too — otherwise the tax on
            // returned goods stays on the customer's ledger as a purchase they
            // made and money they paid, forever.
            totalPurchases: -refundTotal,
            totalPaid: -refundTotal,
          },
        }, sessionOpt);
        // Recalculate due
        const customer = await Customer.findById(sale.customer).session(session || null);
        if (customer) {
          // `deriveDue`, not the arithmetic inline: it carries the `openingDue`
          // term, and a return must not wipe debt the customer brought with
          // them from the shop's paper খাতা. See DueAdjustment.model.js.
          customer.totalDue = Customer.deriveDue(customer);
          await customer.save(sessionOpt);
        }

        // Same two steps, per branch. `recomputeDue` mirrors the Math.max clamp
        // above rather than $inc-ing totalDue: an over-refunded customer clamps
        // on one side, and clamping on only one of them is exactly how the two
        // books silently drift apart. Returns are only allowed at the branch
        // that made the sale (decision #10), so sale.branch is this branch.
        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
          purchases: -refundTotal,
          paid: -refundTotal,
        }, session);
        await CustomerBalance.recomputeDue({
          shop: shopId,
          customer: sale.customer,
          branch: sale.branch,
        }, session);
      }
    } else if (refundMethod === 'adjustment' && sale.customer) {
      // Reduce customer's totalPurchases → recalc due
      const customer = await Customer.findById(sale.customer).session(session || null);
      if (customer) {
        customer.totalPurchases = quantizeMoney(customer.totalPurchases - refundTotal);
        // Shared formula — carries the `openingDue` term, and quantizes. See the
        // note at the cash-refund branch above.
        customer.totalDue = Customer.deriveDue(customer);
        await customer.save(sessionOpt);
      }

      await CustomerBalance.applyDelta({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
        // Mirrors `customer.totalPurchases` above to the paisa. The two books
        // must move by the SAME arithmetic — I-4 — and a VAT term applied to
        // one and not the other is precisely how they drift.
        purchases: -refundTotal,
      }, session);
      await CustomerBalance.recomputeDue({
        shop: shopId,
        customer: sale.customer,
        branch: sale.branch,
      }, session);
    }
    // store_credit: no financial changes, just recorded

    // ── Re-spread the khata pool over what the invoices can now hold ─────────
    //
    // A return changes BOTH sides of the allocation: an `adjustment` refund eats
    // into this invoice's obligation directly, and a cash refund reduces the
    // customer's purchases and therefore their due. Either way the ceiling
    // `newLedgerSettled` was capped against has moved, and any amount squeezed
    // off this invoice belongs on the next open one rather than nowhere.
    //
    // Runs for every refund method, including `store_credit`: that one moves no
    // money today, but it is the pass that costs nothing and the recompute is
    // idempotent, so a no-op here is genuinely a no-op.
    if (sale.customer) {
      await dueSettlementService.reallocateCustomerInvoices({
        shopId,
        customerId: sale.customer,
      }, session);
    }

    // 11. Audit log
    await AuditLog.create({
      shop: shopId,
      branch: branchId,
      user: userId,
      action: AUDIT_ACTIONS.SALES_RETURN_CREATE.en,
      actionBn: AUDIT_ACTIONS.SALES_RETURN_CREATE.bn,
      description: `Sales return ${returnNo} for invoice ${sale.invoiceNo}. Amount: ৳${refundTotal}. Method: ${refundMethod}`,
      descriptionBn: `মাল ফেরত ${returnNo}, ইনভয়েস ${sale.invoiceNo}। পরিমাণ: ৳${refundTotal}`,
      entity: {
        type: 'sales_return',
        id: salesReturn._id,
        name: returnNo,
      },
      changes: {
        after: {
          returnNo,
          saleInvoice: sale.invoiceNo,
          totalAmount: totalRefundAmount,
          taxRefund,
          refundTotal,
          refundMethod,
          items: processedItems.map(i => `${i.productName} x${i.quantity}`).join(', '),
        },
      },
    });

    saleService.invalidateCache(shopId).catch(() => {});

    return salesReturn;
    });
  }

  /**
   * Get all returns (paginated, filtered)
   */
  async getReturns(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      saleId,
      customerId,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    // Branch scoping
    if (options.branchId) {
      query.branch = options.branchId;
    }

    if (search) {
      // Escaped, exactly as saleService._buildQuery does. Raw user input in
      // `$regex` is a ReDoS vector, and this was the one list search that still
      // passed it through untouched.
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { returnNo: { $regex: escaped, $options: 'i' } },
        { invoiceNo: { $regex: escaped, $options: 'i' } },
        { customerName: { $regex: escaped, $options: 'i' } },
        { customerPhone: { $regex: escaped, $options: 'i' } },
      ];
    }

    if (saleId) query.sale = saleId;
    if (customerId) query.customer = customerId;

    // "Which refunds do I still owe?" — the filter the pending status exists to
    // serve. Anything other than 'pending' is ignored rather than passed
    // through, so a stray query string cannot slice the list in a way the UI
    // has no way to display or clear.
    if (options.refundStatus === 'pending') {
      query.refundStatus = 'pending';
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    // `totalAmount`, not `total` — the whitelist named a field this model does
    // not have, so "sort by amount" silently fell through to no sort at all and
    // Mongo returned natural order. `total` is still accepted as an alias
    // because that is what the client sends.
    const SORT_FIELDS = { createdAt: 'createdAt', returnNo: 'returnNo', total: 'totalAmount', totalAmount: 'totalAmount' };
    const sortField = SORT_FIELDS[sortBy] || 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [returns, total] = await Promise.all([
      SalesReturn.find(query)
        .populate('customer', 'name phone')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SalesReturn.countDocuments(query),
    ]);

    return {
      data: returns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single return by ID
   */
  async getReturnById(shopId, returnId, req = null) {
    const salesReturn = await SalesReturn.findOne(branchFilter(req, { _id: returnId, shop: shopId }))
      .populate('sale', 'invoiceNo total paid due status')
      .populate('customer', 'name phone address')
      .populate('createdBy', 'name phone');

    if (!salesReturn) {
      throw new AppError('Sales return not found', 'ফেরত পাওয়া যায়নি', 404);
    }

    return salesReturn;
  }

  /**
   * Get all returns for a specific sale
   */
  async getReturnsBySale(shopId, saleId, req = null) {
    return SalesReturn.find(branchFilter(req, { shop: shopId, sale: saleId }))
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Get returnable items for a sale (powers the return modal)
   */
  async getReturnableItems(shopId, saleId, req = null) {
    const sale = await Sale.findOne(branchFilter(req, { _id: saleId, shop: shopId }));
    if (!sale) {
      throw new AppError('Sale not found', 'বিক্রয় পাওয়া যায়নি', 404);
    }

    if (sale.status === 'cancelled') {
      throw new AppError(
        'Cannot return from cancelled sale',
        'বাতিল বিক্রয় থেকে মাল ফেরত নেওয়া যাবে না',
        400
      );
    }

    // Get existing returns
    const existingReturns = await SalesReturn.find({ shop: shopId, sale: saleId });
    const returnedMap = {};
    for (const ret of existingReturns) {
      for (const ri of ret.items) {
        const key = ri.saleItemId.toString();
        returnedMap[key] = (returnedMap[key] || 0) + ri.quantity;
      }
    }

    // Build returnable items
    const returnableItems = sale.items
      .map(item => {
        const returned = returnedMap[item._id.toString()] || 0;
        const maxReturnable = item.quantity - returned;
        const invoiceDiscount = getInvoiceDiscountShareForItem(sale, item);
        const totalDiscount = (item.discount || 0) + invoiceDiscount;
        return {
          saleItemId: item._id,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId,
          variantSku: item.variantSku,
          variantAttributes: item.variantAttributes,
          originalQuantity: item.quantity,
          alreadyReturned: returned,
          maxReturnable,
          unitPrice: item.unitPrice,
          buyingPrice: item.buyingPrice,
          discount: totalDiscount,
          itemDiscount: item.discount || 0,
          invoiceDiscount,
        };
      })
      .filter(item => item.maxReturnable > 0);

    return {
      sale: {
        _id: sale._id,
        invoiceNo: sale.invoiceNo,
        customerName: sale.customerName,
        customer: sale.customer,
        total: sale.total,
        due: sale.due,
        status: sale.status,
      },
      returnableItems,
    };
  }

  /**
   * Pay out a return that was recorded as "পরে দিবেন".
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THIS IS THE SECOND HALF OF A CASH REFUND, RUN LATE
   * ───────────────────────────────────────────────────────────────────────────
   *
   * A `store_credit` return moved the goods and nothing else. Settling it does
   * exactly what `createReturn` does for `refundMethod: 'cash'` — writes the
   * refund `Payment`, and walks the customer's totals and per-branch balance
   * back down — only now, when the money actually leaves the drawer.
   *
   * The stock, the sale's `returnedAmount`, the profit reduction and the
   * customer's `totalPurchases` were all handled when the return was created.
   * Touching them again here would double-count them. The ONLY thing that
   * happens now is the money.
   *
   * Idempotent by guard: a return already `settled` is refused rather than
   * paid twice. That guard is the whole reason this is a status flip and not a
   * free-standing "record a refund" action.
   *
   * @param {string} shopId
   * @param {string} userId
   * @param {string} returnId
   * @param {Object} data           `{ settlementMethod }`
   * @param {Object} req
   */
  async settleRefund(shopId, userId, returnId, data = {}, req = null) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const salesReturn = await SalesReturn.findOne(
        branchFilter(req, { _id: returnId, shop: shopId })
      ).session(session || null);

      if (!salesReturn) {
        throw new AppError('Sales return not found', 'ফেরত পাওয়া যায়নি', 404);
      }
      if (salesReturn.refundStatus !== 'pending') {
        throw new AppError(
          'This refund has already been settled',
          'এই ফেরতের টাকা ইতিমধ্যে দেওয়া হয়েছে',
          400
        );
      }

      const method = data.settlementMethod || 'cash';
      // Goods plus their VAT — the same figure the cash branch of
      // `createReturn` hands over. Paying out `totalAmount` alone would settle
      // a store credit for less than the customer was credited.
      const amount = Number(salesReturn.refundTotal) || 0;

      // The store credit is being paid out now, so this is the moment an
      // account is debited — not when the return was recorded, which moved no
      // money. `refundStatus` is what separates the two, and it is why that
      // field exists.
      const settleAccount = data.account
        ? (await paymentAccountService.assertUsableAccount(shopId, data.account, req))._id
        : await paymentAccountService.resolveAccountForMethod(req?.shop || { _id: shopId }, method, req);

      await Payment.create([{
        shop: shopId,
        branch: salesReturn.branch,
        sale: salesReturn.sale,
        customer: salesReturn.customer,
        amount,
        method,
        account: settleAccount,
        type: 'refund',
        reference: salesReturn.returnNo,
        notes: `বকেয়া ফেরত পরিশোধ: ${salesReturn.returnNo}`,
        receivedBy: userId,
      }], sessionOpt);

      await paymentAccountService.applyAccountDelta({
        shop: shopId,
        account: settleAccount,
        amount: -amount,
        session: session || null,
      });
      salesReturn.account = settleAccount;
      // Saved by the `refundStatus = 'settled'` write further down — this
      // document is already being persisted, so the field rides along.

      // Mirrors the cash branch of `createReturn` exactly. `totalPurchases` was
      // NOT reduced when the store-credit return was created — only a cash or
      // adjustment refund did that — so both sides move here, and the two books
      // (Customer and CustomerBalance) are clamped the same way. Clamping only
      // one of them is precisely how they drift apart.
      if (salesReturn.customer) {
        await Customer.findByIdAndUpdate(salesReturn.customer, {
          $inc: { totalPurchases: -amount, totalPaid: -amount },
        }, sessionOpt);

        const customer = await Customer.findById(salesReturn.customer).session(session || null);
        if (customer) {
          // `deriveDue`, not the arithmetic inline: it carries the `openingDue`
          // term, and a return must not wipe debt the customer brought with
          // them from the shop's paper খাতা. See DueAdjustment.model.js.
          customer.totalDue = Customer.deriveDue(customer);
          await customer.save(sessionOpt);
        }

        await CustomerBalance.applyDelta({
          shop: shopId,
          customer: salesReturn.customer,
          branch: salesReturn.branch,
          purchases: -amount,
          paid: -amount,
        }, session);
        await CustomerBalance.recomputeDue({
          shop: shopId,
          customer: salesReturn.customer,
          branch: salesReturn.branch,
        }, session);
      }

      salesReturn.refundStatus = 'settled';
      salesReturn.settledAt = new Date();
      salesReturn.settledBy = userId;
      salesReturn.settlementMethod = method;
      await salesReturn.save(sessionOpt);

      await AuditLog.create([{
        shop: shopId,
        branch: salesReturn.branch,
        user: userId,
        action: AUDIT_ACTIONS.SALE_RETURN || 'sale_return',
        actionBn: 'বকেয়া ফেরত পরিশোধ',
        description: `Settled pending refund ${salesReturn.returnNo}. Amount: ${amount}, method: ${method}`,
        descriptionBn: `${salesReturn.returnNo} এর বকেয়া ৳${amount} ফেরত দেওয়া হয়েছে`,
        entity: {
          type: 'sales_return',
          id: salesReturn._id,
          name: salesReturn.returnNo,
        },
      }], sessionOpt);

      return salesReturn;
    });
  }

  /**
   * Get returns summary for stats
   */
  async getReturnsSummary(shopId, options = {}) {
    const { startDate, endDate, branchId = null } = options;

    /* The window is built exactly the way `getReturns` builds its own, and for
       the same reason the branch scope is shared: these totals are printed on
       top of that list and have to count the same rows.

       In particular an ABSENT bound means unbounded, not "this month". This
       defaulted to the current calendar month while the list defaulted to all
       time, so the shop's "সব সময়" filter — the one the page opens on — put a
       month's totals above every return ever recorded. A shopkeeper reading
       "৫টি ফেরত" over a table of thirty had no way to tell which number was
       lying.

       No `setHours` on the end bound either. The list applies the timestamp it
       is given; adding a day's grace here made the summary's window wider than
       the list's, which is the same class of disagreement in miniature. The
       client sends a full ISO instant for both bounds. */
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    // Branch-scoped for the same reason `getReturns` above is: the cards sit
    // directly on top of that list and have to count the same rows. An owner in
    // "All Branches" passes null here and correctly gets the shop-wide rollup.
    return SalesReturn.getReturnsSummary(shopId, start, end, branchId);
  }
}

module.exports = new SalesReturnService();

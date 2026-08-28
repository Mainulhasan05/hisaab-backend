const PurchaseReturn = require('../models/PurchaseReturn.model');
const Purchase = require('../models/Purchase.model');
const Product = require('../models/Product.model');
const Supplier = require('../models/Supplier.model');
const SupplierBalance = require('../models/SupplierBalance.model');
const Payment = require('../models/Payment.model');
const StockTransaction = require('../models/StockTransaction.model');
const AuditLog = require('../models/AuditLog.model');
const paymentAccountService = require('./paymentAccount.service');
const { AppError } = require('../middleware/error.middleware');
const { AUDIT_ACTIONS, PAYMENT_TYPES, STOCK_TRANSACTION_TYPES } = require('../config/constants');
const { branchFilter } = require('../utils/branchScope.util');
const { runInTransaction } = require('../utils/transaction.util');
const {
  parseQuantity,
  quantityUnit,
  storageUnit,
  quantize,
  quantizeMoney,
  buildStockUpdate,
  buildVariantStockUpdate,
} = require('../utils/quantity.util');
const { deductBatches, batchWriteOp, sameOwner } = require('../utils/batch.util');
const { _prorate } = require('../utils/purchaseMath.util');

/**
 * কেনা ফেরত — RTV to the supplier. The mirror of `salesReturn.service`, with
 * the goods and the money both pointed the other way.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS THAT ARE EASY TO GET BACKWARDS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **BILLED refunds, LANDED leaves the shelf (D-1).** The supplier credits
 *    what they charged — `unitPrice`, less this return's proportional slice of
 *    the line and invoice discounts. The stock ledger records what the shelf
 *    lost — `landedUnitPrice`, which carries the ভাড়া. The freight on returned
 *    goods is sunk: the truck really did drive. Never substitute one for the
 *    other.
 *
 * 2. **`Product.buyingPrice` is NOT touched (D-2).** A moving average has no
 *    inverse (stated at length in `purchase.service.cancelPurchase`), and a
 *    partial line carries no ownership snapshot to restore from. Sales returns
 *    do not move the average either. One rule beats two: **a return never moves
 *    the average.**
 *
 * 3. **You cannot return what is not on the shelf (D-5).** Two independent
 *    caps, and both are needed. `purchased − Σ prior returns` stops a shop
 *    returning fifty sacks against a forty-sack delivery; the guarded `$gte`
 *    stock filter stops it returning goods it has already sold to customers.
 *    The first is a paper fact, the second is a physical one.
 */

/**
 * One return's proportional slice of a line-level charge.
 *
 * Split with `purchaseMath._prorate` rather than a plain `charge * r / Q`, and
 * the difference is not cosmetic. `_prorate` settles the rounding remainder
 * onto the larger weight, which makes two identities hold exactly:
 *
 *   · returning the WHOLE line gives back exactly `charge` — weights `[Q, 0]`
 *     round-trip to `[charge, 0]`, not to `charge ± a paisa`;
 *   · the returned and retained slices always sum to `charge`.
 *
 * The residue matters because it lands in the supplier's খাতা through
 * `Purchase.returnedAmount`, and a খাতা that is a paisa out from the supplier's
 * own paper is a খাতা the shopkeeper stops trusting. Same argument
 * `purchaseMath` makes about the landed cost.
 *
 * @param {number} charge     the line's own figure (lineDiscount / discountShare)
 * @param {number} returnQty  how much is coming back
 * @param {number} lineQty    what the line originally carried
 */
function shareOfLine(charge, returnQty, lineQty) {
  const amount = Number(charge) || 0;
  if (amount <= 0) return 0;
  const retained = Math.max(0, (Number(lineQty) || 0) - (Number(returnQty) || 0));
  const shares = _prorate([returnQty, retained], quantizeMoney(amount));
  return shares ? (shares[0] || 0) : 0;
}

/** Find a variant subdocument whether the array is hydrated or lean. */
function findVariant(product, variantId) {
  if (!product?.variants || !variantId) return null;
  return typeof product.variants.id === 'function'
    ? product.variants.id(variantId)
    : product.variants.find(v => String(v._id || v.id) === String(variantId)) || null;
}

/** Stock currently available for a purchase line's product-or-variant. */
function availableStock(product, variantId) {
  if (!product) return 0;
  if (variantId && product.hasVariants) {
    return findVariant(product, variantId)?.stock || 0;
  }
  return product.stock || 0;
}

/** Find a purchase line by id, whether `items` is a DocumentArray or plain. */
function findPurchaseItem(purchase, itemId) {
  if (!purchase?.items) return null;
  if (typeof purchase.items.id === 'function') return purchase.items.id(itemId);
  return purchase.items.find(i => String(i._id || i.id) === String(itemId)) || null;
}

class PurchaseReturnService {
  /**
   * Record goods going back to the supplier.
   *
   * @param {string} shopId
   * @param {string} userId
   * @param {Object} returnData `{purchaseId, items:[{purchaseItemId, quantity,
   *                            reason?}], refundMethod, paymentMethod?,
   *                            account?, reason, notes?}`
   * @param {Object} req
   * @returns {{purchaseReturn, purchase, allocations}}
   */
  async createReturn(shopId, userId, returnData, req) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};
      const {
        purchaseId, items, refundMethod, paymentMethod, reason, notes,
      } = returnData;

      if (!Array.isArray(items) || items.length === 0) {
        throw new AppError(
          'At least one item is required',
          'অন্তত একটি পণ্য ফেরত দিতে হবে',
          400
        );
      }

      // 1. The purchase, branch-scoped. A bill from another branch is not even
      // visible here — the same rule `createReturn` on the sale side enforces
      // (H-4), for the same reason: step 6 would otherwise book the credit into
      // a branch the caller is not looking at.
      const purchase = await Purchase.findOne(
        branchFilter(req, { _id: purchaseId, shop: shopId })
      ).session(session || null);

      if (!purchase) {
        throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
      }

      // Returns happen at the branch that bought the goods. For an owner in
      // "All Branches" the filter above is a no-op, so the purchase's own
      // branch is enforced here rather than silently accepting a mismatch.
      const branchId = purchase.branch || null;
      if (req?.shop?.multiBranchEnabled && req.branchId
          && String(req.branchId) !== String(branchId || '')) {
        throw new AppError(
          'This purchase belongs to another branch. Switch to that branch to return goods.',
          'এই ক্রয়টি অন্য শাখার। মাল ফেরত দিতে ওই শাখায় যান।',
          403
        );
      }

      // A cancelled bill has already had its stock reversed and its supplier
      // books unwound. Returning against it would reverse the same goods twice.
      if (purchase.status === 'cancelled') {
        throw new AppError(
          'Cannot return goods from a cancelled purchase',
          'বাতিল ক্রয় থেকে মাল ফেরত দেওয়া যাবে না',
          400
        );
      }

      // The mirror of the walk-in rule: `সরাসরি কেনা` has no supplier ledger,
      // so there is no বাকি for the credit to be cut from. The shop must take
      // it as cash, or record it as pending.
      if (refundMethod === 'adjustment' && !purchase.supplier) {
        throw new AppError(
          'Cannot adjust a supplier balance on a direct purchase',
          'সরাসরি কেনায় বাকি থেকে কাটা যাবে না — টাকা ফেরত নিন বা "পরে নেবো" দিন',
          400
        );
      }

      // A reason is mandatory on every NEW return. Enforced here rather than in
      // the schema for the reason written on the field: an existing row without
      // one must stay saveable.
      if (!reason || !String(reason).trim()) {
        throw new AppError('A return reason is required', 'ফেরতের কারণ লিখুন', 400);
      }

      // 2. What has already gone back, per line.
      const priorReturns = await PurchaseReturn.find({
        shop: shopId, purchase: purchase._id,
      }).session(session || null);

      const alreadyReturned = {};
      for (const ret of priorReturns) {
        for (const ri of ret.items) {
          const key = String(ri.purchaseItemId);
          alreadyReturned[key] = (alreadyReturned[key] || 0) + ri.quantity;
        }
      }

      // The products, once, up front — both for unit precision and for the
      // stock guard below. Not branch-filtered: the purchase has already been
      // branch-checked, and a product moved since must not block a legitimate
      // return.
      const productIds = [...new Set(
        items
          .map((ri) => findPurchaseItem(purchase, ri.purchaseItemId))
          .filter(Boolean)
          .map((pi) => String(pi.product))
      )];
      const products = await Product.find({
        _id: { $in: productIds }, shop: shopId,
      }).session(session || null);
      const productMap = new Map(products.map(p => [String(p._id), p]));

      // 3. Value each line: billed net, proportional shares (D-1).
      const processedItems = [];
      let totalCredit = 0;

      // Stock claimed by EARLIER lines of this same return, so two lines
      // against one product cannot each pass a guard the pair would fail.
      const claimed = new Map();
      const claimKey = (productId, variantId) => `${productId}::${variantId || ''}`;

      for (const raw of items) {
        const line = findPurchaseItem(purchase, raw.purchaseItemId);
        if (!line) {
          throw new AppError(
            `Purchase item not found: ${raw.purchaseItemId}`,
            'ক্রয়ের আইটেম পাওয়া যায়নি',
            404
          );
        }

        const product = productMap.get(String(line.product));

        // A return must be expressible in the same unit the purchase was, so
        // the precision comes from the PRODUCT and not from the request. A
        // 0.5 kg return against a 20 kg line is valid; half a piece is not.
        const quantity = parseQuantity(
          raw.quantity,
          quantityUnit(req, product),
          { label: line.productName }
        );

        // Cap 1 (paper): what the delivery brought, less what has gone back.
        const maxReturnable = quantize(
          Math.max(0, line.quantity - (alreadyReturned[String(line._id)] || 0)),
          storageUnit(product)
        );

        if (quantity > maxReturnable) {
          throw new AppError(
            `Cannot return more than ${maxReturnable} of ${line.productName}`,
            `"${line.productName}" এর সর্বোচ্চ ${maxReturnable} ফেরত দেওয়া যাবে`,
            400
          );
        }

        // Cap 2 (physical): the goods must still be on the shelf (D-5). Checked
        // here so the refusal can NAME the product and its stock — the guarded
        // `$gte` filter on the write below is the concurrency backstop, and a
        // bulkWrite that matched nothing cannot say which line failed or why.
        const key = claimKey(String(line.product), line.variantId);
        const alreadyClaimed = claimed.get(key) || 0;
        const onShelf = quantize(
          availableStock(product, line.variantId) - alreadyClaimed,
          storageUnit(product)
        );

        if (!product || quantity > onShelf) {
          throw new AppError(
            `Insufficient stock to return ${line.productName} (available: ${Math.max(0, onShelf)})`,
            `"${line.productName}" এর স্টকে আছে ${Math.max(0, onShelf)} — এর বেশি ফেরত দেওয়া যাবে না`,
            400
          );
        }
        claimed.set(key, alreadyClaimed + quantity);

        // The billed net credit. Both concessions are prorated against the
        // WHOLE line so a full return gives back exactly what the bill knocked
        // off — see `shareOfLine`.
        const lineDiscountShare = shareOfLine(line.lineDiscount, quantity, line.quantity);
        const discountShare = shareOfLine(line.discountShare, quantity, line.quantity);
        const lineTotal = quantizeMoney(
          (line.unitPrice * quantity) - lineDiscountShare - discountShare
        );

        processedItems.push({
          purchaseItemId: line._id,
          product: line.product,
          productName: line.productName,
          productCode: line.productCode,
          variantId: line.variantId || undefined,
          variantLabel: line.variantLabel || undefined,
          quantity,
          unit: line.unit || undefined,
          packSize: line.packSize || undefined,
          unitPrice: line.unitPrice,
          lineDiscountShare,
          discountShare,
          // Snapshotted, and NEVER refunded — it is what the stock ledger
          // loses. Falls back to `unitPrice` for a purchase written before
          // landed cost existed, which is what it would have equalled anyway.
          landedUnitPrice: line.landedUnitPrice ?? line.unitPrice,
          total: Math.max(0, lineTotal),
          batchNumber: line.batchNumber || undefined,
          expiryDate: line.expiryDate || undefined,
          reason: raw.reason || reason,
        });

        totalCredit = quantizeMoney(totalCredit + Math.max(0, lineTotal));
      }

      // 4. Which account receives the money, resolved BEFORE the document is
      // written so it can be stored in one pass. Only a `cash` return moves
      // money today — an `adjustment` cuts the খাতা and a `pending` one moves
      // nothing at all until `settleRefund` runs.
      const refundAccount = refundMethod === 'cash'
        ? (returnData.account
            ? (await paymentAccountService.assertUsableAccount(shopId, returnData.account, req, 'cash'))._id
            : await paymentAccountService.resolveAccountForMethod(
                req?.shop || { _id: shopId }, paymentMethod || 'cash', req
              ))
        : null;

      // 5. The adjustment walk (D-3), computed BEFORE anything is written so a
      // refusal costs nothing.
      //
      // This bill absorbs up to its own due; the remainder walks the same
      // shop+supplier+BRANCH's other open bills oldest first — the identical
      // sort and identical caps `recordPayment`'s F-4 allocation uses, because
      // a credit and a payment settle the same debt in the same order.
      //
      // Same branch deliberately: the goods left this branch's shelf and the
      // credit reduces this branch's payable. Settling another branch's bill
      // from here is the cross-branch write-down `settleCustomerDue` refuses.
      //
      // Anything left after every open bill is settled would be a supplier
      // ADVANCE, which is deliberately still not tracked anywhere in this
      // codebase. Refuse it and say what to do instead — the same policy line
      // F-4 takes, rather than inventing a balance nothing can read.
      const allocations = [];
      if (refundMethod === 'adjustment') {
        let remaining = totalCredit;

        const primaryTake = quantizeMoney(Math.min(remaining, purchase.due || 0));
        if (primaryTake > 0) {
          allocations.push({ doc: purchase, amount: primaryTake });
          remaining = quantizeMoney(remaining - primaryTake);
        }

        if (remaining > 0) {
          const olderBills = await Purchase.find({
            shop: shopId,
            supplier: purchase.supplier,
            branch: purchase.branch || null,
            _id: { $ne: purchase._id },
            status: { $ne: 'cancelled' },
            due: { $gt: 0 },
          })
            .sort({ date: 1, createdAt: 1 })
            .session(session || null);

          for (const bill of olderBills) {
            if (remaining <= 0) break;
            const take = quantizeMoney(Math.min(remaining, bill.due));
            if (take <= 0) continue;
            allocations.push({ doc: bill, amount: take });
            remaining = quantizeMoney(remaining - take);
          }
        }

        if (remaining > 0) {
          const absorbable = quantizeMoney(totalCredit - remaining);
          throw new AppError(
            `The supplier's outstanding bills can only absorb ৳${absorbable} of this credit`,
            `সরবরাহকারীর বাকি ৳${absorbable} — বাকি ৳${remaining} বাকি থেকে কাটা যাবে না।`
              + ' ওই অংশ টাকায় নিন বা "পরে নেবো" দিন।',
            400
          );
        }
      }

      // 6. The number, then the document.
      const returnNo = await PurchaseReturn.generateReturnNo(shopId);

      const [purchaseReturn] = await PurchaseReturn.create([{
        shop: shopId,
        branch: branchId,
        returnNo,
        purchase: purchase._id,
        invoiceNo: purchase.invoiceNo,
        supplier: purchase.supplier,
        supplierName: purchase.supplierName,
        items: processedItems,
        totalAmount: totalCredit,
        refundMethod,
        paymentMethod: refundMethod === 'cash' ? (paymentMethod || 'cash') : undefined,
        account: refundAccount,
        // `pending` is the shop waiting to be paid, and it is the only method
        // that leaves the return open. See the field note on the model.
        refundStatus: refundMethod === 'pending' ? 'pending' : 'settled',
        allocations: allocations.map((a) => ({ purchase: a.doc._id, amount: a.amount })),
        reason,
        notes,
        createdBy: userId,
      }], sessionOpt);

      // 7. Stock OUT — guarded, variant-aware (D-5).
      //
      // The `$gte` filter is what makes this safe against a sale completing
      // between the read above and this write: the op simply does not match,
      // `modifiedCount` falls short, and the whole transaction aborts with a
      // 409 rather than driving the shelf negative. Same construction the sale
      // path uses, and for the same reason.
      const stockOps = [];
      const batchOps = [];
      const txns = [];
      let expectedStockOps = 0;

      for (const item of processedItems) {
        const product = productMap.get(String(item.product));
        if (!product) continue;

        // Flag-independent, like every other reversal path: what was received
        // must be removable at the same precision even if packaging was later
        // switched off for this shop (AGENT_WORKFLOW.md §13.4).
        const stkUnit = storageUnit(product);
        const isVariantLine = Boolean(item.variantId && product.hasVariants);

        const previousStock = isVariantLine
          ? (findVariant(product, item.variantId)?.stock || 0)
          : product.stock;

        if (isVariantLine) {
          const variant = findVariant(product, item.variantId);
          if (variant) {
            variant.stock = quantize(variant.stock - item.quantity, stkUnit);
          }
          // The rollup is rebuilt from the array the pipeline just wrote, so
          // the product-level total cannot go stale on a variant return.
          product.stock = quantize(
            product.variants.reduce((sum, v) => quantize(sum + v.stock, stkUnit), 0),
            stkUnit
          );
          stockOps.push({
            updateOne: {
              // `$elemMatch` and not two sibling predicates: `{'variants._id':
              // x, 'variants.stock': {$gte: q}}` is satisfied by ONE variant
              // matching the id and a DIFFERENT one holding the stock.
              filter: {
                _id: product._id,
                shop: shopId,
                variants: { $elemMatch: { _id: item.variantId, stock: { $gte: item.quantity } } },
              },
              update: buildVariantStockUpdate(item.variantId, -item.quantity, stkUnit),
            },
          });
        } else {
          product.stock = quantize(product.stock - item.quantity, stkUnit);
          stockOps.push({
            updateOne: {
              filter: { _id: product._id, shop: shopId, stock: { $gte: item.quantity } },
              update: buildStockUpdate(-item.quantity, stkUnit),
            },
          });
        }
        expectedStockOps += 1;

        // ── Take the goods out of the batch they arrived in ─────────────────
        //
        // Preferred by `purchaseRef` — the exact rows THIS delivery created —
        // so a return cannot eat a batch that came in on a different purchase
        // and happens to expire sooner. Whatever is left over falls back to a
        // plain FEFO deduction, which is the honest approximation: the shop
        // cannot send back a specific parcel it has already sold through.
        //
        // The partial-quantity version of `cancelPurchase`'s walk, and the
        // reason it is written out rather than shared: that one removes the
        // WHOLE line and can filter emptied rows once at the end; this one
        // takes a slice and has to leave the rest of the batch standing.
        if (product.trackBatches && Array.isArray(product.batches) && product.batches.length) {
          const owner = item.variantId || null;
          let toRemove = item.quantity;

          for (const b of product.batches) {
            if (toRemove <= 0) break;
            if (!sameOwner(b.variantId, owner)) continue;
            if (String(b.purchaseRef || '') !== String(purchase._id)) continue;
            const take = Math.min(toRemove, b.quantity);
            b.quantity = quantize(b.quantity - take, stkUnit);
            toRemove = quantize(toRemove - take, stkUnit);
          }
          product.batches = product.batches.filter(b => b.quantity > 0);
          if (toRemove > 0) deductBatches(product, owner, toRemove);

          batchOps.push(batchWriteOp(product));
        }

        const unitCost = item.landedUnitPrice ?? item.unitPrice;
        txns.push({
          shop: shopId,
          // SET. `cancelPurchase` omitted this for years and its reversal rows
          // were invisible to every branch's stock history — fixed there too,
          // in the same change.
          branch: branchId,
          product: item.product,
          productName: item.productName,
          productCode: item.productCode,
          variantId: item.variantId || null,
          type: STOCK_TRANSACTION_TYPES.PURCHASE_RETURN,
          quantity: -item.quantity,
          previousStock: previousStock || 0,
          newStock: isVariantLine
            ? (findVariant(product, item.variantId)?.stock || 0)
            : product.stock,
          // LANDED, not billed. This ledger is what an inventory value is
          // rebuilt from, and it has to agree with the cost basis it explains
          // (D-1). `totalCost` carries a `min: 0`, so it is the magnitude —
          // the sign lives on `quantity`, exactly as `cancelPurchase` does it.
          unitCost,
          totalCost: quantizeMoney(item.quantity * unitCost),
          reference: {
            type: 'purchase_return',
            id: purchaseReturn._id,
            invoiceNo: returnNo,
          },
          supplier: purchase.supplierName,
          notes: `কেনা ফেরত: ${returnNo} (ক্রয়: ${purchase.invoiceNo})`,
          createdBy: userId,
        });
      }

      if (stockOps.length > 0) {
        const result = await Product.bulkWrite(stockOps, sessionOpt);
        if (result.modifiedCount < expectedStockOps) {
          throw new AppError(
            'Insufficient stock — a sale may have just reduced inventory. Please retry.',
            'পর্যাপ্ত স্টক নেই — এর মধ্যে বিক্রয় হয়ে স্টক কমে গেছে। আবার চেষ্টা করুন।',
            409
          );
        }
      }
      // Its OWN bulkWrite, deliberately AFTER the guard: `modifiedCount` above
      // is the oversell check, and mixing unrelated ops into the batch it
      // counts would let a lost stock race hide behind a successful batch
      // write. Same construction as `createSale`.
      if (batchOps.length > 0) {
        await Product.bulkWrite(batchOps, sessionOpt);
      }
      if (txns.length > 0) {
        await StockTransaction.insertMany(txns, sessionOpt);
      }

      // 8. The money.
      const appliedAllocations = [];

      if (refundMethod === 'adjustment') {
        // Each touched bill's `paid` is UNTOUCHED — the shop handed over
        // nothing. `returnedAmount` is the third term in `Purchase.pre('save')`
        // and reducing `due` through it is what makes the reduction survive
        // every later save of the document. See the field's note on the model
        // for why neither a bare `due` write nor an `updateOne` would.
        for (const alloc of allocations) {
          alloc.doc.returnedAmount = quantizeMoney(
            (alloc.doc.returnedAmount || 0) + alloc.amount
          );
          await alloc.doc.save(sessionOpt);
          appliedAllocations.push({
            purchase: alloc.doc._id,
            invoiceNo: alloc.doc.invoiceNo,
            amount: alloc.amount,
          });
        }

        // Both supplier books move ONCE, by the same total, with the SAME
        // arithmetic, in this transaction — that is the whole of the
        // Σ SupplierBalance.totalDue === Supplier.totalDue invariant (§8).
        //
        // `totalAmount` comes down with `totalDue` and not only the latter,
        // because `SupplierBalance.recomputeDue` re-derives
        // `totalDue = totalAmount + openingDue − totalPaid`. Moving the due
        // alone would hold until the next time ANY purchase from this supplier
        // and branch was cancelled — that path calls `recomputeDue`, which
        // would recompute the credit straight back out of existence.
        if (purchase.supplier) {
          await Supplier.findByIdAndUpdate(purchase.supplier, {
            $inc: { totalAmount: -totalCredit, totalDue: -totalCredit },
          }, sessionOpt);

          await SupplierBalance.applyDelta({
            shop: shopId,
            supplier: purchase.supplier,
            branch: purchase.branch,
            amount: -totalCredit,
            due: -totalCredit,
          }, session);
        }
      } else if (refundMethod === 'cash' && totalCredit > 0) {
        // Money IN. `purchase_refund`, never `refund` — see the type's note in
        // constants.js for what reusing the customer type would have poisoned.
        //
        // The supplier books are deliberately untouched: the debt never
        // changed. The shop was handed cash for goods it had already paid for,
        // or is still going to pay for; either way what it owes is what it
        // owed.
        //
        // Guarded on a positive figure because `Payment.amount` carries a
        // `min: 0.01`: a fully-discounted line can come back worth ৳0, and the
        // GOODS still have to move even when no money does. A zero-value cash
        // return writes the stock legs and no payment row, rather than failing
        // validation on a return that is otherwise perfectly legitimate.
        await Payment.create([{
          shop: shopId,
          branch: branchId,
          purchase: purchase._id,
          amount: totalCredit,
          method: paymentMethod || 'cash',
          account: refundAccount,
          type: PAYMENT_TYPES.PURCHASE_REFUND,
          reference: returnNo,
          notes: `কেনা ফেরত: ${returnNo}`,
          receivedBy: userId,
        }], sessionOpt);

        await paymentAccountService.applyAccountDelta({
          shop: shopId,
          account: refundAccount,
          amount: Number(totalCredit) || 0,
          session: session || null,
        });
      }
      // `pending`: the goods went back and nothing else moved. `settleRefund`
      // writes the cash-in leg when the supplier finally pays.

      // 9. Audit.
      await AuditLog.create([{
        shop: shopId,
        branch: branchId,
        user: userId,
        action: AUDIT_ACTIONS.PURCHASE_RETURN_CREATE.en,
        actionBn: AUDIT_ACTIONS.PURCHASE_RETURN_CREATE.bn,
        description: `Purchase return ${returnNo} against ${purchase.invoiceNo}.`
          + ` Amount: ৳${totalCredit}. Method: ${refundMethod}`
          + (appliedAllocations.length > 1 ? ` (${appliedAllocations.length} bills)` : ''),
        descriptionBn: `কেনা ফেরত ${returnNo}, ক্রয় ${purchase.invoiceNo}। পরিমাণ: ৳${totalCredit}`,
        entity: {
          type: 'purchase_return',
          id: purchaseReturn._id,
          name: returnNo,
        },
        changes: {
          after: {
            returnNo,
            purchaseInvoice: purchase.invoiceNo,
            totalAmount: totalCredit,
            refundMethod,
            items: processedItems.map(i => `${i.productName} x${i.quantity}`).join(', '),
          },
        },
      }], sessionOpt);

      return {
        purchaseReturn,
        purchase,
        // Every bill the credit touched, this one first, invoice numbers
        // included so the UI can say "পুরোনো বিল PUR… এ ৳X বসেছে" without a
        // second fetch. The exact shape `recordPayment` returns.
        allocations: appliedAllocations,
      };
    });
  }

  /**
   * Record that the supplier finally handed the money over on a "পরে নেবো".
   *
   * The second half of a cash refund, run late. The stock, the batches and the
   * return document itself were all handled when the return was created;
   * touching any of them again here would double-count. The ONLY thing that
   * happens now is the money.
   *
   * Idempotent by guard: a return already `settled` is refused rather than paid
   * twice. That guard is the entire reason this is a status flip and not a
   * free-standing "record a receipt" action.
   *
   * @param {Object} data `{method, account}` — the frontend's own names; the
   *        sale side spells the first one `settlementMethod`, so both are
   *        accepted rather than making one caller wrong.
   */
  async settleRefund(shopId, userId, returnId, data = {}, req = null) {
    return await runInTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      const purchaseReturn = await PurchaseReturn.findOne(
        branchFilter(req, { _id: returnId, shop: shopId })
      ).session(session || null);

      if (!purchaseReturn) {
        throw new AppError('Purchase return not found', 'ফেরত পাওয়া যায়নি', 404);
      }
      if (purchaseReturn.refundStatus !== 'pending') {
        throw new AppError(
          'This refund has already been settled',
          'এই ফেরতের টাকা ইতিমধ্যে পাওয়া গেছে',
          400
        );
      }

      const method = data.method || data.settlementMethod || 'cash';
      const amount = Number(purchaseReturn.totalAmount) || 0;

      // The account is credited NOW, not when the return was recorded — that
      // moved no money. `refundStatus` is what separates the two.
      const settleAccount = data.account
        ? (await paymentAccountService.assertUsableAccount(shopId, data.account, req, method))._id
        : await paymentAccountService.resolveAccountForMethod(
            req?.shop || { _id: shopId }, method, req
          );

      // Guarded on a positive figure for the reason the create path documents:
      // `Payment.amount` carries a `min: 0.01`, and a zero-value return must
      // still be closable.
      if (amount > 0) {
        await Payment.create([{
          shop: shopId,
          branch: purchaseReturn.branch,
          purchase: purchaseReturn.purchase,
          amount,
          method,
          account: settleAccount,
          type: PAYMENT_TYPES.PURCHASE_REFUND,
          reference: purchaseReturn.returnNo,
          notes: `কেনা ফেরতের বকেয়া গ্রহণ: ${purchaseReturn.returnNo}`,
          receivedBy: userId,
        }], sessionOpt);

        await paymentAccountService.applyAccountDelta({
          shop: shopId,
          account: settleAccount,
          amount,
          session: session || null,
        });
      }

      purchaseReturn.account = settleAccount;
      purchaseReturn.refundStatus = 'settled';
      purchaseReturn.settledAt = new Date();
      purchaseReturn.settledBy = userId;
      purchaseReturn.settlementMethod = method;
      await purchaseReturn.save(sessionOpt);

      await AuditLog.create([{
        shop: shopId,
        branch: purchaseReturn.branch,
        user: userId,
        action: AUDIT_ACTIONS.PURCHASE_RETURN_SETTLE.en,
        actionBn: AUDIT_ACTIONS.PURCHASE_RETURN_SETTLE.bn,
        description: `Settled pending purchase refund ${purchaseReturn.returnNo}.`
          + ` Amount: ${amount}, method: ${method}`,
        descriptionBn: `${purchaseReturn.returnNo} এর বকেয়া ৳${amount} পাওয়া গেছে`,
        entity: {
          type: 'purchase_return',
          id: purchaseReturn._id,
          name: purchaseReturn.returnNo,
        },
      }], sessionOpt);

      return purchaseReturn;
    });
  }

  /** Paginated list. Every filter is ANDed onto the shop predicate (I-5). */
  async getReturns(shopId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      purchaseId,
      supplierId,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const query = { shop: shopId };

    if (options.branchId) query.branch = options.branchId;

    if (search && String(search).trim()) {
      // Escaped: raw user input in `$regex` is a ReDoS vector, and a pasted
      // "PRET(" must not 500 the list.
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { returnNo: { $regex: escaped, $options: 'i' } },
        { invoiceNo: { $regex: escaped, $options: 'i' } },
        { supplierName: { $regex: escaped, $options: 'i' } },
      ];
    }

    if (purchaseId) query.purchase = purchaseId;
    if (supplierId) query.supplier = supplierId;

    // Anything other than 'pending' is ignored rather than passed through, so
    // a stray query string cannot slice the list in a way the UI has no way to
    // display or clear. Same rule the sales-return list applies.
    if (options.refundStatus === 'pending') {
      query.refundStatus = 'pending';
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const SORT_FIELDS = {
      createdAt: 'createdAt',
      returnNo: 'returnNo',
      total: 'totalAmount',
      totalAmount: 'totalAmount',
    };
    const sortField = SORT_FIELDS[sortBy] || 'createdAt';
    const sort = { [sortField]: sortOrder === 'asc' ? 1 : -1 };

    const [returns, total] = await Promise.all([
      PurchaseReturn.find(query)
        .populate('supplier', 'name phone')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PurchaseReturn.countDocuments(query),
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

  async getReturnById(shopId, returnId, req = null) {
    const purchaseReturn = await PurchaseReturn.findOne(
      branchFilter(req, { _id: returnId, shop: shopId })
    )
      .populate('purchase', 'invoiceNo supplierInvoiceNo totalAmount paid due status date')
      .populate('supplier', 'name phone address')
      .populate('createdBy', 'name phone');

    if (!purchaseReturn) {
      throw new AppError('Purchase return not found', 'ফেরত পাওয়া যায়নি', 404);
    }

    return purchaseReturn;
  }

  /** Every return raised against one purchase — the detail page's ফেরত card. */
  async getReturnsByPurchase(shopId, purchaseId, req = null) {
    return PurchaseReturn.find(branchFilter(req, { shop: shopId, purchase: purchaseId }))
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * What can still go back, and how much of it is physically there.
   *
   * The UI clamps its stepper to `min(maxReturnable, stockAvailable)` — both
   * numbers are returned rather than the minimum, because they mean different
   * things and the modal says which one is binding ("আর ২টি ফেরত দেওয়া যাবে"
   * versus "স্টকে আছে ২টি").
   */
  async getReturnableItems(shopId, purchaseId, req = null) {
    const purchase = await Purchase.findOne(
      branchFilter(req, { _id: purchaseId, shop: shopId })
    );
    if (!purchase) {
      throw new AppError('Purchase not found', 'ক্রয়টি পাওয়া যায়নি', 404);
    }
    if (purchase.status === 'cancelled') {
      throw new AppError(
        'Cannot return goods from a cancelled purchase',
        'বাতিল ক্রয় থেকে মাল ফেরত দেওয়া যাবে না',
        400
      );
    }

    const priorReturns = await PurchaseReturn.find({ shop: shopId, purchase: purchaseId }).lean();
    const returnedMap = {};
    for (const ret of priorReturns) {
      for (const ri of ret.items) {
        const key = String(ri.purchaseItemId);
        returnedMap[key] = (returnedMap[key] || 0) + ri.quantity;
      }
    }

    const productIds = [...new Set((purchase.items || []).map(i => String(i.product)))];
    const products = await Product.find({ _id: { $in: productIds }, shop: shopId })
      .select('_id unit stock hasVariants variants')
      .lean();
    const productMap = new Map(products.map(p => [String(p._id), p]));

    const items = (purchase.items || [])
      .map((line) => {
        const product = productMap.get(String(line.product));
        const stkUnit = storageUnit(product);
        const alreadyReturned = returnedMap[String(line._id)] || 0;
        const maxReturnable = quantize(Math.max(0, line.quantity - alreadyReturned), stkUnit);

        return {
          purchaseItemId: line._id,
          product: line.product,
          productName: line.productName,
          productCode: line.productCode,
          variantId: line.variantId || null,
          variantLabel: line.variantLabel || null,
          unit: line.unit || null,
          packSize: line.packSize || null,
          originalQuantity: line.quantity,
          alreadyReturned,
          maxReturnable,
          // The physical cap (D-5). A line whose goods have all been sold on
          // shows 0 here and a positive `maxReturnable` — the modal disables it
          // and says why, rather than letting the shopkeeper type a number the
          // server will refuse.
          stockAvailable: quantize(availableStock(product, line.variantId), stkUnit),
          unitPrice: line.unitPrice,
          lineDiscount: line.lineDiscount || 0,
          discountShare: line.discountShare || 0,
          landedUnitPrice: line.landedUnitPrice ?? line.unitPrice,
          batchNumber: line.batchNumber || null,
          expiryDate: line.expiryDate || null,
        };
      })
      .filter(item => item.maxReturnable > 0);

    return {
      purchase: {
        _id: purchase._id,
        invoiceNo: purchase.invoiceNo,
        supplier: purchase.supplier || null,
        supplierName: purchase.supplierName,
        totalAmount: purchase.totalAmount,
        paid: purchase.paid,
        due: purchase.due,
        status: purchase.status,
        date: purchase.date,
      },
      items,
    };
  }

  /**
   * Stat tiles and the pending banner.
   *
   * The window is built exactly the way `getReturns` builds its own, and an
   * ABSENT bound means unbounded — not "this month". A summary whose window is
   * wider or narrower than the list it sits on top of gives a shopkeeper two
   * numbers and no way to tell which is lying. Same note as the sales side.
   */
  async getReturnsSummary(shopId, options = {}) {
    const { startDate, endDate, branchId = null } = options;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    return PurchaseReturn.getReturnsSummary(shopId, start, end, branchId);
  }

}

module.exports = new PurchaseReturnService();

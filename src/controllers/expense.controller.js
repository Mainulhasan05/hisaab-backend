const expenseService = require('../services/expense.service');
const aiExpenseService = require('../services/aiExpense.service');
const aiQuota = require('../utils/aiQuota.util');
const ApiResponse = require('../utils/response.util');
const asyncHandler = require('../utils/asyncHandler.util');
const logger = require('../utils/logger.util');

// Get all expenses
exports.getExpenses = asyncHandler(async (req, res) => {
  const options = { ...req.query };
  if (req.branchId) options.branchId = req.branchId;
  const result = await expenseService.getExpenses(req.shop._id, options);
  return ApiResponse.paginated(res, {
    ...result,
    message: 'Expenses retrieved successfully',
    messageBn: 'খরচের তালিকা সফলভাবে লোড হয়েছে',
  });
});

// Create expense
exports.createExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.createExpense(req.shop._id, req.user._id, req.body, req);
  return ApiResponse.created(res, {
    data: expense,
    message: 'Expense added successfully',
    messageBn: 'খরচ সফলভাবে যোগ হয়েছে',
  });
});

// Update expense
exports.updateExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.updateExpense(req.shop._id, req.user._id, req.params.id, req.body, req);
  return ApiResponse.success(res, {
    data: expense,
    message: 'Expense updated successfully',
    messageBn: 'খরচ সফলভাবে আপডেট হয়েছে',
  });
});

// Delete expense
// Void an expense. Not delete — expenses are an immutable ledger row; see
// `voidExpense` in the service and `immutableGuard` on the model.
exports.voidExpense = asyncHandler(async (req, res) => {
  const expense = await expenseService.voidExpense(
    req.shop._id,
    req.user._id,
    req.params.id,
    req.body?.reason,
    req
  );
  return ApiResponse.success(res, {
    data: expense,
    message: 'Expense voided successfully',
    messageBn: 'খরচটি বাতিল করা হয়েছে',
  });
});

// Get expense summary
exports.getSummary = asyncHandler(async (req, res) => {
  const summary = await expenseService.getSummary(req.shop._id, req.query, req);
  return ApiResponse.success(res, {
    data: summary,
    message: 'Expense summary retrieved',
    messageBn: 'খরচের সারাংশ লোড হয়েছে',
  });
});

// Get expense categories
exports.getCategories = asyncHandler(async (req, res) => {
  const categories = await expenseService.getCategories(req.shop._id);
  return ApiResponse.success(res, {
    data: categories,
    message: 'Expense categories retrieved',
    messageBn: 'খরচের ক্যাটাগরি লোড হয়েছে',
  });
});

// Create custom expense category
exports.createCategory = asyncHandler(async (req, res) => {
  const category = await expenseService.createCategory(req.shop._id, req.body);
  return ApiResponse.created(res, {
    data: category,
    message: 'Category created successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে তৈরি হয়েছে',
  });
});

// Create several expenses at once
exports.createBulk = asyncHandler(async (req, res) => {
  const result = await expenseService.createBulk(
    req.shop._id,
    req.user._id,
    req.body?.expenses,
    req,
    req.body?.source === 'ai' ? 'ai' : 'manual'
  );

  // 207-ish semantics on a 201: some rows may have failed while others landed.
  // A flat 201 would let a client that ignores `failed` report full success,
  // and a 400 would let one that ignores `created` tell the shopkeeper to enter
  // everything again — including the three expenses now sitting in their book.
  return ApiResponse.created(res, {
    data: result,
    message: `${result.summary.ok} of ${result.summary.total} expenses created`,
    messageBn: result.summary.failed
      ? `${result.summary.ok}টি খরচ যোগ হয়েছে, ${result.summary.failed}টি হয়নি`
      : `${result.summary.ok}টি খরচ সফলভাবে যোগ হয়েছে`,
  });
});

/**
 * How many AI messages this BRANCH has left today. Spends nothing.
 *
 * The composer calls this on mount so the remaining-messages pill is right
 * before the shopkeeper types anything — discovering the allowance is gone by
 * being refused costs them a thought and a tap, and the refusal arrives after
 * they have already composed the sentence.
 */
exports.getAiUsage = asyncHandler(async (req, res) => {
  const usage = await aiQuota.getUsage(req.shop, req.branchId || null);
  return ApiResponse.success(res, {
    data: usage,
    message: 'AI usage retrieved',
    messageBn: 'এআই ব্যবহারের হিসাব লোড হয়েছে',
  });
});

/**
 * Draft expense rows from one natural-language message. WRITES NOTHING.
 *
 * ── THE ORDER OF THE TWO RESERVATIONS IS THE POINT ──────────────────────────
 *
 * The shop's message is spent FIRST, then a slot on a Gemini key. If the pool
 * turns out to be exhausted, the shop's message is handed straight back. The
 * other order — pool first — would mean a shopkeeper who never got an answer
 * still has four messages left instead of five, and nothing on their screen
 * would connect the two.
 *
 * Every failure below refunds, EXCEPT the one where the message itself could
 * not be read (422). That one consumed a real Gemini call and a real answer;
 * refunding it would let a loop of gibberish cost the platform unbounded quota
 * at no cost to the sender. Open question §10.2 in AI_EXPENSE_PLAN.md leans the
 * other way while the prompt is still being tuned — flip the `catch` below if
 * that is the call.
 */
exports.aiParse = asyncHandler(async (req, res) => {
  const branchId = req.branchId || null;

  const reservation = await aiQuota.spend(req.shop, branchId);

  if (!reservation.ok) {
    // `ApiResponse.tooManyRequests` forwards `messageBn` but not `data`, so the
    // numbers go in the sentence. The client refreshes its pill from
    // `GET /expenses/ai/usage` after a 429 rather than reading them off here.
    return ApiResponse.tooManyRequests(res, {
      message: `Daily AI message limit reached (${reservation.limit})`,
      messageBn: reservation.limit === 0
        ? 'এই দোকানে এআই বার্তার বরাদ্দ নেই। প্ল্যাটফর্ম অ্যাডমিনের সাথে যোগাযোগ করুন।'
        : `আজকের ${reservation.limit}টি এআই বার্তা শেষ হয়েছে। আগামীকাল আবার চেষ্টা করুন।`,
    });
  }

  try {
    const result = await aiExpenseService.parseMessage(req.shop._id, req.body?.message);

    return ApiResponse.success(res, {
      data: {
        ...result,
        usage: {
          limit: reservation.limit,
          usedToday: reservation.usedToday,
          remaining: reservation.remaining,
        },
      },
      message: 'Message parsed',
      messageBn: result.lines.length
        ? `${result.lines.length}টি খরচ পাওয়া গেছে`
        : 'কোনো খরচ পাওয়া যায়নি',
    });
  } catch (err) {
    // 422 is "your message could not be read" — the call happened, the answer
    // came back, it was not usable. Everything else (pool exhausted, timeout,
    // Google 5xx) is our problem, not the shopkeeper's, so give the message
    // back before the error leaves here.
    if (err?.statusCode !== 422) {
      await aiQuota
        .refund(req.shop, branchId, reservation.dayKey)
        .catch((refundErr) =>
          // A failed refund must not replace the real error with a worse one.
          // The shopkeeper loses one message; the log is how we find out.
          logger.warn('Failed to refund AI message', {
            shop: String(req.shop._id),
            branch: branchId ? String(branchId) : null,
            error: refundErr?.message,
          })
        );
    }
    throw err;
  }
});

// Delete custom expense category
exports.deleteCategory = asyncHandler(async (req, res) => {
  await expenseService.deleteCategory(req.shop._id, req.params.id);
  return ApiResponse.success(res, {
    message: 'Category deleted successfully',
    messageBn: 'ক্যাটাগরি সফলভাবে মুছে ফেলা হয়েছে',
  });
});

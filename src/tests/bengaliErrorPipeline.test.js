/**
 * The Bengali error pipeline reaches the wire.
 *
 * This app writes every error twice — English for the logs, Bengali for the
 * shopkeeper — and for a long time only the English half was serialised. Three
 * separate places dropped it, and all three failed silently:
 *
 *   1. `ApiResponse.error` destructured `{ message, statusCode, errors }`, so
 *      every `badRequest`/`notFound`/`conflict` caller that passed a Bengali
 *      sentence had it thrown away. `validate.middleware` is one of them, which
 *      means form validation — the error a shopkeeper hits most — was English.
 *   2. `sendErrorProd` built its response object without `messageBn`, losing
 *      every `AppError`'s Bengali in production.
 *   3. `sendErrorDev` buried it inside the `error` debug blob instead of at the
 *      top level, so it was missing in development too.
 *
 * `hisaab-frontend/lib/axios.js` reads `data.messageBn` and every Redux thunk
 * does `error.messageBn || error.message`, so all three failures looked the
 * same from the outside: English text, no error, nothing in the logs.
 *
 * REGRESSION vs INVARIANT (AGENT_WORKFLOW.md §7.1): every assertion about
 * `messageBn` being PRESENT is a regression test and fails against the old
 * code. The assertions about `message`, `code`, `branch` and `errors` still
 * being present are invariant guards — they passed before and must keep
 * passing, because the fix must not change any other part of the error shape.
 */

const ApiResponse = require('../utils/response.util');
const { AppError, errorHandler } = require('../middleware/error.middleware');

jest.mock('../utils/logger.util', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

/** Minimal Express `res` that records what was sent. */
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const req = {
  originalUrl: '/api/products',
  method: 'POST',
  ip: '127.0.0.1',
};

/** `errorHandler` branches on NODE_ENV, so each test states which it wants. */
function handle(err, env) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  const res = mockRes();
  try {
    errorHandler(err, req, res, jest.fn());
  } finally {
    process.env.NODE_ENV = previous;
  }
  return res;
}

describe('ApiResponse carries messageBn', () => {
  it('error() serialises it', () => {
    const res = mockRes();
    ApiResponse.error(res, {
      message: 'Validation failed',
      messageBn: 'তথ্য যাচাই ব্যর্থ',
      statusCode: 400,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.messageBn).toBe('তথ্য যাচাই ব্যর্থ');
    // Invariant: the rest of the envelope is unchanged.
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.success).toBe(false);
    expect(res.body.statusCode).toBe(400);
  });

  it('omits the key entirely when there is no Bengali copy', () => {
    const res = mockRes();
    ApiResponse.error(res, { message: 'Boom', statusCode: 500 });

    expect('messageBn' in res.body).toBe(false);
    expect(res.body.message).toBe('Boom');
  });

  // The helpers are what controllers actually call, and each one used to have
  // its own chance to drop the field on the way down to `error()`.
  it.each([
    ['badRequest', 400, 'এই তথ্য দিয়ে হবে না'],
    ['unauthorized', 401, 'আগে লগইন করুন'],
    ['notFound', 404, 'পাওয়া যায়নি'],
    ['conflict', 409, 'এটি আগে থেকেই আছে'],
    ['validationError', 422, 'তথ্য যাচাই ব্যর্থ'],
    ['tooManyRequests', 429, 'একটু পরে আবার চেষ্টা করুন'],
    ['serverError', 500, 'সার্ভারে সমস্যা হয়েছে'],
  ])('%s() passes it through', (method, status, messageBn) => {
    const res = mockRes();
    ApiResponse[method](res, { message: 'English', messageBn });

    expect(res.statusCode).toBe(status);
    expect(res.body.messageBn).toBe(messageBn);
  });

  it('forbidden() carries it alongside the code', () => {
    const res = mockRes();
    ApiResponse.forbidden(res, {
      message: 'Not allowed',
      messageBn: 'এই কাজের অনুমতি নেই',
      code: 'NO_PERMISSION',
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.messageBn).toBe('এই কাজের অনুমতি নেই');
    expect(res.body.code).toBe('NO_PERMISSION'); // invariant
  });

  it('paymentRequired() carries it alongside the code', () => {
    const res = mockRes();
    ApiResponse.paymentRequired(res, {
      message: 'Subscription expired',
      messageBn: 'সাবস্ক্রিপশনের মেয়াদ শেষ',
    });

    expect(res.statusCode).toBe(402);
    expect(res.body.messageBn).toBe('সাবস্ক্রিপশনের মেয়াদ শেষ');
    expect(res.body.code).toBe('SUBSCRIPTION_EXPIRED'); // invariant
  });

  it('validationError keeps the per-field errors array', () => {
    const res = mockRes();
    ApiResponse.validationError(res, {
      message: 'Validation failed',
      messageBn: 'তথ্য যাচাই ব্যর্থ',
      errors: [{ field: 'phone', message: 'required', messageBn: 'এই ফিল্ডটি আবশ্যক' }],
    });

    expect(res.body.messageBn).toBe('তথ্য যাচাই ব্যর্থ');
    expect(res.body.errors).toHaveLength(1); // invariant
    expect(res.body.errors[0].messageBn).toBe('এই ফিল্ডটি আবশ্যক');
  });
});

describe('errorHandler carries messageBn', () => {
  it('production: an operational AppError keeps its Bengali', () => {
    const err = new AppError('Product not found', 'পণ্যটি পাওয়া যায়নি', 404);
    const res = handle(err, 'production');

    expect(res.statusCode).toBe(404);
    expect(res.body.messageBn).toBe('পণ্যটি পাওয়া যায়নি');
    expect(res.body.message).toBe('Product not found'); // invariant
  });

  it('development: the Bengali sits at the top level, not only in the debug blob', () => {
    const err = new AppError('Product not found', 'পণ্যটি পাওয়া যায়নি', 404);
    const res = handle(err, 'development');

    expect(res.body.messageBn).toBe('পণ্যটি পাওয়া যায়নি');
  });

  it('production: code, phone and branch still ride along', () => {
    const err = new AppError('Wrong branch', 'এই রেকর্ডটি অন্য শাখার', 404);
    err.code = 'WRONG_BRANCH';
    err.branch = { _id: 'b1', name: 'উত্তরা' };
    err.phone = '01700000000';

    const res = handle(err, 'production');

    expect(res.body.messageBn).toBe('এই রেকর্ডটি অন্য শাখার');
    // Invariants — these already worked and the fix must not disturb them.
    expect(res.body.code).toBe('WRONG_BRANCH');
    expect(res.body.branch).toEqual({ _id: 'b1', name: 'উত্তরা' });
    expect(res.body.phone).toBe('01700000000');
  });

  it('production: a non-operational crash still gets a Bengali sentence', () => {
    const err = new Error('Cannot read properties of undefined');
    err.statusCode = 500;

    const res = handle(err, 'production');

    expect(res.statusCode).toBe(500);
    expect(typeof res.body.messageBn).toBe('string');
    expect(res.body.messageBn.length).toBeGreaterThan(0);
  });

  it('production: a Mongo duplicate-key error is translated to Bengali', () => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    err.keyValue = { code: 'RICE-1' };

    const res = handle(err, 'production');

    expect(res.statusCode).toBe(409);
    expect(res.body.messageBn).toContain('পণ্য কোড');
    expect(res.body.messageBn).toContain('RICE-1');
  });

  it('production: an expired JWT is explained in Bengali', () => {
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';

    const res = handle(err, 'production');

    expect(res.statusCode).toBe(401);
    expect(res.body.messageBn).toBe('আপনার সেশন শেষ হয়ে গেছে। অনুগ্রহ করে পুনরায় লগইন করুন।');
  });
});

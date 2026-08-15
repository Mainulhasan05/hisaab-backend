/**
 * Can an image upload be attempted at all, and if not, exactly why.
 *
 * Both upload endpoints — the shop-facing `media.controller` and the admin
 * `adminMedia.controller` — used to answer this with a bare boolean and then
 * throw the same sentence: "Image storage is not configured on this server".
 * Three unrelated failures produced that one sentence, and none of them were
 * logged:
 *
 *   1. sharp did not load          → a build/deploy problem on the box
 *   2. STORAGE_ENC_KEY is unset    → an environment problem, and the one that
 *                                    survives a `.env` edit, because the value
 *                                    is read from `process.env` and a running
 *                                    process never re-reads the file
 *   3. no active R2 account        → a data problem, fixed in Admin → Storage
 *
 * Telling them apart used to mean attaching a debugger to production. The
 * blocker carries a `code` so the response says which one it is, and
 * `assertUploadReady` logs the detail server-side so it is answerable from the
 * log alone.
 *
 * The Bengali message stays deliberately vague for all three. A shop owner
 * cannot act on any of them, and "the server is not ready yet, contact support"
 * is the honest version of every branch.
 */

const imagePipeline = require('./imagePipeline.util');
const { AppError } = require('../middleware/error.middleware');
const logger = require('./logger.util');

const MESSAGE_BN = 'সার্ভারে ছবি সংরক্ষণ সুবিধা এখনো প্রস্তুত নয়';

/**
 * @returns {Promise<{code: string, detail: string}|null>} null when uploads may proceed
 */
async function uploadBlocker() {
  if (!imagePipeline.isAvailable()) {
    return {
      code: 'IMAGE_PIPELINE_UNAVAILABLE',
      detail:
        'sharp failed to load in this process, so no image can be decoded or ' +
        'resized. Reinstall it for this platform (npm rebuild sharp).',
    };
  }

  // Required lazily: `storage.service` pulls in the S3 client and the models,
  // and this util is required from both media services during their own module
  // load. A top-level require here closes that into a cycle.
  const storageService = require('../services/storage.service');
  return storageService.configurationBlocker();
}

/** True when an upload may be attempted. Kept for callers that only need the bit. */
async function isUploadReady() {
  return (await uploadBlocker()) === null;
}

/**
 * Throw the 503 the caller owes the user, naming the cause.
 *
 * @param {string} [scope] which library refused, for the log line
 */
async function assertUploadReady(scope = 'media') {
  const blocker = await uploadBlocker();
  if (!blocker) return;

  // Logged every time rather than once at boot: cause 3 can start and stop
  // being true while the process runs, so a stale boot-time line would be
  // worse than none.
  logger.error(`Upload refused (${scope}) — ${blocker.code}: ${blocker.detail}`);

  const error = new AppError(
    `Image storage is not ready: ${blocker.detail}`,
    MESSAGE_BN,
    503
  );
  error.code = blocker.code;
  throw error;
}

module.exports = {
  MESSAGE_BN,
  uploadBlocker,
  isUploadReady,
  assertUploadReady,
};

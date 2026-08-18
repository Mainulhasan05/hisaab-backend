/**
 * Connect a platform admin's founder-alert channel using the Telegram account
 * they have already linked on the SHOP side.
 *
 * The console flow (`/admin-hq-x7k9m2p4/alerts` → Connect) mints a deep link
 * and waits for `/start <token>`. That is the right flow for a new operator,
 * but when the founder is already talking to the same bot from their own shop
 * account, the chat id we need is sitting in `telegramlinks` — and until an
 * `AdminTelegramLink` row exists, `platformNotify._hasAudience()` is false and
 * every founder alert is composed and dropped.
 *
 * Idempotent: re-running relinks (and re-activates) rather than duplicating.
 *
 * Run from hisaab-backend/:
 *   node scripts/link-admin-telegram.js                 # founder phone from env
 *   node scripts/link-admin-telegram.js 01757995016     # explicit
 *   node scripts/link-admin-telegram.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

/**
 * Same resolution order as `adminSecurity.service.js`, deliberately — the
 * founder's number is the one identity these two features must never disagree
 * about.
 */
const FALLBACK_PHONE = '01757995016';

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const phone =
    args.find((a) => !a.startsWith('--')) ||
    process.env.PLATFORM_FOUNDER_PHONE ||
    process.env.SUPER_ADMIN_PHONE ||
    FALLBACK_PHONE;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}`);
  console.log(`Founder phone: ${phone}${dryRun ? '  (dry run)' : ''}\n`);

  const Admin = require('../src/models/Admin.model');
  const User = require('../src/models/User.model');
  const TelegramLink = require('../src/models/TelegramLink.model');
  const AdminTelegramLink = require('../src/models/AdminTelegramLink.model');

  const admin = await Admin.findOne({ phone }).lean();
  if (!admin) throw new Error(`No admin account with phone ${phone}`);
  console.log(`Admin:  ${admin.name} (${admin.role}) ${admin._id}`);

  // The shop-side link is keyed on the USER with this phone, not the admin —
  // they are separate accounts that happen to share a number.
  const user = await User.findOne({ phone }).select('_id name').lean();
  if (!user) throw new Error(`No shop user with phone ${phone} — link from the console instead`);

  const shopLink = await TelegramLink.findOne({ user: user._id, isActive: true }).lean();
  if (!shopLink) {
    throw new Error(
      `User ${user.name} has no ACTIVE Telegram link — connect the bot from the shop ` +
      `settings first, or use the admin console's own connect flow.`
    );
  }
  console.log(
    `Telegram: chat ${shopLink.telegramChatId} ` +
    `(${shopLink.telegramFirstName || '—'}${shopLink.telegramUsername ? ` @${shopLink.telegramUsername}` : ''})`
  );

  const existing = await AdminTelegramLink.findOne({ admin: admin._id });
  if (
    existing &&
    existing.isActive &&
    existing.telegramChatId === String(shopLink.telegramChatId)
  ) {
    console.log('\nAlready connected to this chat. Nothing to do.');
    return;
  }

  if (dryRun) {
    console.log(`\nWould ${existing ? 'relink' : 'create'} the admin alert channel.`);
    return;
  }

  const telegramFields = {
    telegramChatId: String(shopLink.telegramChatId),
    telegramUserId: String(shopLink.telegramUserId),
    telegramUsername: shopLink.telegramUsername || null,
    telegramFirstName: shopLink.telegramFirstName || null,
  };

  // `metadata.source` marks these rows as script-made, so an operator reading
  // linkHistory later can tell them apart from a real `/start` handshake.
  if (existing) {
    const previousChatId = existing.telegramChatId;
    const wasActive = existing.isActive;
    Object.assign(existing, telegramFields);
    existing.isActive = true;
    existing.unlinkedAt = null;
    existing.linkedAt = existing.linkedAt || new Date();
    existing.linkHistory.push({
      action: 'relinked',
      at: new Date(),
      metadata: { previousChatId, wasActive, source: 'link-admin-telegram script' },
    });
    await existing.save();
    console.log('\nRelinked the admin alert channel.');
  } else {
    await AdminTelegramLink.create({
      admin: admin._id,
      ...telegramFields,
      linkedAt: new Date(),
      linkHistory: [
        { action: 'linked', at: new Date(), metadata: { source: 'link-admin-telegram script' } },
      ],
    });
    console.log('\nCreated the admin alert channel.');
  }

  // The notifier caches "is anyone listening" for 60s in Redis. This process
  // shares that Redis, so drop it rather than making the operator wait a minute
  // wondering whether the script worked.
  try {
    const platformNotify = require('../src/services/platformNotify.service');
    await platformNotify.invalidateCache();
    console.log('Dropped the cached audience/cooldown lookups.');
  } catch (e) {
    console.log(`Cache drop skipped (${e.message}) — it expires within 60s anyway.`);
  }

  console.log('New shop, login, security and daily-pulse alerts now have a listener.');
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nFailed: ${e.message}`);
    process.exit(1);
  });

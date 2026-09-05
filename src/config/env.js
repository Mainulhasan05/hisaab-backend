const required = ['MONGODB_URI', 'JWT_SECRET'];

function validateEnv(env = process.env) {
  const missing = required.filter((key) => !env[key] || String(env[key]).trim() === '');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (env.USE_REDIS === 'true' && !env.REDIS_SOCKET && !env.REDIS_HOST) {
    throw new Error('USE_REDIS=true requires REDIS_SOCKET or REDIS_HOST');
  }

  if (env.IMAGE_UPLOAD_PROVIDER === 'imgbb' && !env.IMGBB_API_KEY) {
    throw new Error('IMAGE_UPLOAD_PROVIDER=imgbb requires IMGBB_API_KEY');
  }

  // R2 credential encryption. Optional — with no key the storage pool simply
  // reports itself unconfigured and the admin panel refuses to save an account.
  // A MALFORMED key is fatal though: it would pass `isConfigured()` nowhere but
  // would let someone believe encryption is on, and every account save would
  // fail at the last moment with a crypto error instead of at boot.
  if (env.STORAGE_ENC_KEY && !/^[0-9a-fA-F]{64}$/.test(env.STORAGE_ENC_KEY.trim())) {
    throw new Error(
      'STORAGE_ENC_KEY must be 64 hex characters (32 bytes). Generate with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Meta Conversions API is optional, but half-configured is worse than off:
  // it would silently drop every conversion instead of failing loudly here.
  if (env.META_CAPI_ACCESS_TOKEN && !env.META_PIXEL_ID) {
    throw new Error('META_CAPI_ACCESS_TOKEN requires META_PIXEL_ID');
  }

  // Telegram is entirely optional — with no token the bot never starts and the
  // rest of the app is unaffected. A malformed token is worth catching here
  // though, because the only other symptom is a 404 from getMe at boot.
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[\w-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN.trim())) {
    throw new Error('TELEGRAM_BOT_TOKEN is malformed — expected "<digits>:<secret>" from @BotFather');
  }

  /* PayStation. Optional as a whole — with no merchant id the owner-facing
   * checkout stays hidden and billing carries on being keyed in by hand.
   *
   * Half-configured is fatal, and this is the integration where that rule earns
   * its keep most. The failure is not a quiet one: a shop that has ALREADY BEEN
   * CHARGED gets nothing back, because either we cannot ask the gateway what
   * happened (no password) or the gateway has nowhere to return the customer
   * (no API_PUBLIC_URL). Both are unrecoverable from the shop's side and both
   * are trivially caught here.
   *
   * The two URLs must be externally reachable ORIGINS, not paths: PayStation
   * resolves the callback from the public internet, and the app URL is where a
   * customer's browser is sent afterwards. A localhost value in production
   * means every payment succeeds at the bank and lands nowhere. */
  if (env.PAYSTATION_MERCHANT_ID) {
    const missingPaystation = ['PAYSTATION_PASSWORD', 'API_PUBLIC_URL', 'APP_PUBLIC_URL']
      .filter((key) => !env[key] || String(env[key]).trim() === '');
    if (missingPaystation.length > 0) {
      throw new Error(
        `PAYSTATION_MERCHANT_ID requires ${missingPaystation.join(', ')} — ` +
        'a half-configured gateway takes money it cannot deliver against'
      );
    }
    for (const key of ['API_PUBLIC_URL', 'APP_PUBLIC_URL']) {
      if (!/^https?:\/\//i.test(String(env[key]).trim())) {
        throw new Error(`${key} must be an absolute URL including the scheme (https://…)`);
      }
    }
  }
}

module.exports = { validateEnv };

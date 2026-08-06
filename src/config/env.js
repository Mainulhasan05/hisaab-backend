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

  // Meta Conversions API is optional, but half-configured is worse than off:
  // it would silently drop every conversion instead of failing loudly here.
  if (env.META_CAPI_ACCESS_TOKEN && !env.META_PIXEL_ID) {
    throw new Error('META_CAPI_ACCESS_TOKEN requires META_PIXEL_ID');
  }
}

module.exports = { validateEnv };

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
}

module.exports = { validateEnv };

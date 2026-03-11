const WINDOW_MINUTES = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES || 10);
const MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 20);

const attemptsByKey = new Map();

function getClientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

function cleanupExpired(now, windowMs) {
  for (const [key, value] of attemptsByKey.entries()) {
    if (!value || now > value.resetAt + windowMs) {
      attemptsByKey.delete(key);
    }
  }
}

function loginRateLimit(req, res, next) {
  const windowMs = Math.max(1, WINDOW_MINUTES) * 60 * 1000;
  const limit = Math.max(1, MAX_ATTEMPTS);
  const now = Date.now();
  const key = getClientKey(req);

  cleanupExpired(now, windowMs);

  const existing = attemptsByKey.get(key);
  if (!existing || now > existing.resetAt) {
    attemptsByKey.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }

  existing.count += 1;
  attemptsByKey.set(key, existing);

  if (existing.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: `Too many login attempts from this network. Try again in ${retryAfterSeconds} seconds.`
    });
  }

  return next();
}

function clearLoginRateLimit(req) {
  const key = getClientKey(req);
  attemptsByKey.delete(key);
}

module.exports = {
  loginRateLimit,
  clearLoginRateLimit
};

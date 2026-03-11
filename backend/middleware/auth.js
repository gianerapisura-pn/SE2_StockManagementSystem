const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 30);
const SESSION_ABSOLUTE_HOURS = Number(process.env.SESSION_ABSOLUTE_HOURS || 8);

function endSessionWith401(req, res, message) {
  if (!req.session) return res.status(401).json({ error: message });
  req.session.destroy(() => res.status(401).json({ error: message }));
  return null;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = Date.now();
  const idleMs = Math.max(1, SESSION_IDLE_MINUTES) * 60 * 1000;
  const absoluteMs = Math.max(1, SESSION_ABSOLUTE_HOURS) * 60 * 60 * 1000;

  if (!req.session.authMeta || !req.session.authMeta.loginAt) {
    req.session.authMeta = {
      loginAt: now,
      lastActivityAt: now
    };
    return next();
  }

  const loginAt = Number(req.session.authMeta.loginAt || now);
  const lastActivityAt = Number(req.session.authMeta.lastActivityAt || loginAt);

  if (now - loginAt > absoluteMs) {
    return endSessionWith401(req, res, 'Session expired. Please log in again.');
  }

  if (now - lastActivityAt > idleMs) {
    return endSessionWith401(req, res, 'Session timed out due to inactivity. Please log in again.');
  }

  req.session.authMeta.lastActivityAt = now;
  return next();
}

function requireRole(...roles) {
  const allowed = new Set(roles || []);
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!allowed.has(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role permission' });
    }
    return next();
  };
}

const requireAdmin = requireRole('Admin');

module.exports = { requireAuth, requireRole, requireAdmin };

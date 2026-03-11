const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const pool = require('../db');
const { generateUserId } = require('../utils/userId');
const { logActivity } = require('../utils/logger');
const { validatePasswordRules } = require('../utils/passwordPolicy');
const { clearLoginRateLimit } = require('../middleware/loginRateLimit');

const VALID_SUFFIXES = new Set(['Jr.', 'II', 'III']);
const VALID_GENDERS = new Set(['Male', 'Female']);
const VALID_ROLES = new Set(['Admin', 'Staff']);
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);

function getBaseUrl() {
  return process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
}

function cleanEnv(value) {
  return String(value || '').trim();
}

function getTransporter() {
  const user = cleanEnv(process.env.SMTP_USER).toLowerCase();
  const pass = cleanEnv(process.env.SMTP_PASS).replace(/\s+/g, '');
  const host = cleanEnv(process.env.SMTP_HOST) || 'smtp.gmail.com';
  const port = Number(cleanEnv(process.env.SMTP_PORT) || '587');
  const secureEnv = cleanEnv(process.env.SMTP_SECURE).toLowerCase();
  const secure = secureEnv ? secureEnv === 'true' : port === 465;

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

function parseLegacyName(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return { last_name: '', first_name: '', middle_name: '' };

  if (!raw.includes(',')) {
    return { last_name: '', first_name: raw, middle_name: '' };
  }

  const [lastRaw, restRaw] = raw.split(',');
  const last_name = (lastRaw || '').trim();
  const rest = (restRaw || '').trim();
  if (!rest) return { last_name, first_name: '', middle_name: '' };

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { last_name, first_name: '', middle_name: '' };

  let middle_name = '';
  if (tokens.length > 1 && /^[A-Za-z]{1,3}\.?$/.test(tokens[tokens.length - 1])) {
    middle_name = tokens.pop();
  }

  return {
    last_name,
    first_name: tokens.join(' ').trim(),
    middle_name: middle_name.trim()
  };
}

function normalizeNameParts(payload = {}) {
  let last_name = String(payload.last_name || '').trim();
  let first_name = String(payload.first_name || '').trim();
  let middle_name = String(payload.middle_name || '').trim();

  if ((!last_name || !first_name || !middle_name) && payload.name) {
    const parsed = parseLegacyName(payload.name);
    if (!last_name) last_name = parsed.last_name;
    if (!first_name) first_name = parsed.first_name;
    if (!middle_name) middle_name = parsed.middle_name;
  }

  return { last_name, first_name, middle_name };
}

function normalizePhoneNumber(raw = '') {
  const clean = String(raw || '').replace(/\D/g, '');
  if (!clean) return '';
  if (clean.length === 9) return clean;
  if (clean.length === 10 && clean.startsWith('9')) return clean.slice(1);
  if (clean.length === 11 && clean.startsWith('09')) return clean.slice(2);
  if (clean.length === 12 && clean.startsWith('639')) return clean.slice(3);
  return '';
}

function buildDisplayName(last_name, first_name, middle_name, suffix = '') {
  const last = String(last_name || '').trim();
  const first = String(first_name || '').trim();
  const middle = String(middle_name || '').trim();
  const normalizedSuffix = String(suffix || '').trim();
  const middleAndSuffix = [middle, normalizedSuffix].filter(Boolean).join(' ');
  return `${last}, ${first}${middleAndSuffix ? ` ${middleAndSuffix}` : ''}`.trim();
}

async function sendResetEmail(email, token) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('Forgot-password email is not configured. Set SMTP_USER and SMTP_PASS in .env (for Gmail, use an App Password).');
  }

  const resetUrl = `${getBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
  const from = cleanEnv(process.env.SMTP_FROM) || cleanEnv(process.env.SMTP_USER);
  await transporter.sendMail({
    from,
    to: cleanEnv(email).toLowerCase(),
    subject: '1800 Soles - Password Reset',
    text: `Use this link to reset your password: ${resetUrl}\nThis link expires in 1 hour.`,
    html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`
  });
}

async function getUserCount() {
  const [[row]] = await pool.query('SELECT COUNT(*) AS total FROM users');
  return Number(row.total || 0);
}

async function registerStatus(_req, res) {
  try {
    const totalUsers = await getUserCount();
    return res.json({ allow_public_signup: totalUsers === 0 });
  } catch (err) {
    console.error('Register status error:', err);
    return res.status(500).json({ error: 'Failed to check registration status' });
  }
}

async function register(req, res) {
  const { username, email, password, agree } = req.body;
  const { last_name, first_name, middle_name } = normalizeNameParts(req.body);
  const roleRaw = String(req.body.role || '').trim();
  const suffix = String(req.body.suffix || '').trim() || null;
  const gender = String(req.body.gender || '').trim();
  const phone_number = normalizePhoneNumber(req.body.phone_number);

  try {
    const totalUsers = await getUserCount();
    const isBootstrap = totalUsers === 0;
    const actor = req.session && req.session.user ? req.session.user : null;
    const isAdminInitiated = Boolean(actor && actor.role === 'Admin');

    if (!isBootstrap && !isAdminInitiated) {
      return res.status(403).json({ error: 'Public signup is disabled. Contact your admin to create an account.' });
    }

    const role = isBootstrap ? roleRaw : (roleRaw || 'Staff');

    if (isBootstrap && !agree) {
      return res.status(400).json({ error: 'Please accept terms and conditions.' });
    }

    if (!last_name || !first_name || !middle_name || !role || !username || !email || !password || !gender || !phone_number) {
      return res.status(400).json({ error: 'Last name, first name, middle name, role, username, email, gender, phone number, and password are required.' });
    }

    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Role must be Admin or Staff.' });
    }

    if (isBootstrap && role !== 'Admin') {
      return res.status(400).json({ error: 'The first account must be an Admin.' });
    }

    if (!isBootstrap && role !== 'Staff') {
      return res.status(400).json({ error: 'Only Staff accounts can be created from this form.' });
    }

    if (suffix && !VALID_SUFFIXES.has(suffix)) {
      return res.status(400).json({ error: 'Invalid suffix.' });
    }

    if (!VALID_GENDERS.has(gender)) {
      return res.status(400).json({ error: 'Gender must be Male or Female.' });
    }

    if (!/^\d{9}$/.test(phone_number)) {
      return res.status(400).json({ error: 'Phone number must be 9 digits after +639 (example: +639123456789).' });
    }

    const policy = validatePasswordRules(password);
    if (!policy.ok) return res.status(400).json({ error: policy.message });

    const [[existingUser]] = await pool.query(
      'SELECT user_id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    if (existingUser) return res.status(409).json({ error: 'Username or email already exists.' });

    const user_id = await generateUserId();
    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users (user_id, role, last_name, first_name, middle_name, suffix, gender, phone_number, username, email, password_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [user_id, role, last_name, first_name, middle_name, suffix, gender, phone_number, username, email, hash]
    );

    if (isAdminInitiated) {
      await logActivity({
        user_id: actor.user_id,
        action_type: role === 'Staff' ? 'CREATE_STAFF' : 'CREATE_ADMIN',
        description: `Created ${role} account for ${username} (${user_id})`
      });
      return res.json({ message: `${role} account created successfully.`, user_id });
    }

    await logActivity({ user_id, action_type: 'REGISTER', description: 'User registered' });
    return res.json({ message: 'Registered successfully, please log in.', user_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists.' });
    }
    const msg = err.sqlMessage || err.message || 'Registration failed';
    console.error('Register error:', err);
    return res.status(500).json({ error: msg });
  }
}

async function login(req, res) {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const [[user]] = await pool.query(
      `SELECT user_id, role, last_name, first_name, middle_name, suffix, gender, phone_number, username, email, password_hash,
              failed_login_attempts, lock_until
       FROM users
       WHERE (username = ? OR email = ?) AND is_active = 1
       LIMIT 1`,
      [identifier, identifier]
    );

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.lock_until && new Date(user.lock_until).getTime() > Date.now()) {
      return res.status(423).json({
        error: `Account temporarily locked due to failed login attempts. Try again after ${new Date(user.lock_until).toLocaleString()}.`
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + Math.max(1, LOCKOUT_MINUTES) * 60 * 1000);
        await pool.query(
          'UPDATE users SET failed_login_attempts = 0, lock_until = ?, updated_at = NOW() WHERE user_id = ?',
          [lockUntil, user.user_id]
        );
        return res.status(423).json({
          error: `Too many failed login attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`
        });
      }

      await pool.query(
        'UPDATE users SET failed_login_attempts = ?, lock_until = NULL, updated_at = NOW() WHERE user_id = ?',
        [attempts, user.user_id]
      );
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query(
      'UPDATE users SET failed_login_attempts = 0, lock_until = NULL, updated_at = NOW() WHERE user_id = ?',
      [user.user_id]
    );

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.user = {
      user_id: user.user_id,
      role: user.role,
      last_name: user.last_name,
      first_name: user.first_name,
      middle_name: user.middle_name,
      suffix: user.suffix,
      gender: user.gender,
      phone_number: user.phone_number,
      name: buildDisplayName(user.last_name, user.first_name, user.middle_name, user.suffix),
      username: user.username,
      email: user.email
    };

    const now = Date.now();
    req.session.authMeta = {
      loginAt: now,
      lastActivityAt: now
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    await logActivity({ user_id: user.user_id, action_type: 'LOGIN', description: 'User logged in' });
    clearLoginRateLimit(req);
    return res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

function logout(req, res) {
  const user = req.session.user;
  req.session.destroy(async () => {
    if (user) {
      try {
        await logActivity({ user_id: user.user_id, action_type: 'LOGOUT', description: 'User logged out' });
      } catch (err) {
        console.warn('Activity log failed for LOGOUT:', err);
      }
    }
    return res.json({ message: 'Logged out' });
  });
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const [[user]] = await pool.query(
      'SELECT user_id, email FROM users WHERE email = ? AND is_active = 1 LIMIT 1',
      [email]
    );

    if (!user) {
      return res.json({ message: 'If that email exists, a reset link was sent.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await pool.query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [user.user_id]
    );

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [user.user_id, tokenHash]
    );

    await sendResetEmail(user.email, token);
    return res.json({ message: 'If that email exists, a reset link was sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: err.message || 'Failed to process forgot password request.' });
  }
}

async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  const policy = validatePasswordRules(newPassword);
  if (!policy.ok) return res.status(400).json({ error: policy.message });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [[resetRow]] = await pool.query(
      `SELECT pr.reset_id, pr.user_id
       FROM password_resets pr
       JOIN users u ON u.user_id = pr.user_id
       WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW() AND u.is_active = 1
       ORDER BY pr.reset_id DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (!resetRow) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE user_id = ?', [newHash, resetRow.user_id]);
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE reset_id = ?', [resetRow.reset_id]);

    await logActivity({
      user_id: resetRow.user_id,
      action_type: 'CHANGE_PASSWORD',
      description: 'Password changed via forgot-password flow'
    });

    return res.json({ message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
}

function me(req, res) {
  return res.json({ user: req.session.user });
}

module.exports = {
  registerStatus,
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  me
};

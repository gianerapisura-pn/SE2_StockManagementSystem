const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const pool = require('../db');
const { logActivity } = require('../utils/logger');
const { validatePasswordRules } = require('../utils/passwordPolicy');
const { generateUserId } = require('../utils/userId');

const VALID_SUFFIXES = new Set(['Jr.', 'II', 'III']);
const VALID_GENDERS = new Set(['Male', 'Female']);
const VALID_ROLES = new Set(['Admin', 'Staff']);

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

function buildDisplayName(last_name, first_name, middle_name, suffix = '') {
  const last = String(last_name || '').trim();
  const first = String(first_name || '').trim();
  const middle = String(middle_name || '').trim();
  const normalizedSuffix = String(suffix || '').trim();
  const middleAndSuffix = [middle, normalizedSuffix].filter(Boolean).join(' ');
  return `${last}, ${first}${middleAndSuffix ? ` ${middleAndSuffix}` : ''}`.trim();
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

async function verifyAdminPassword(req, adminPassword) {
  if (!adminPassword) return 'Admin password is required for this action.';

  const [[admin]] = await pool.query(
    'SELECT password_hash FROM users WHERE user_id = ? AND role = \'Admin\' AND is_active = 1 LIMIT 1',
    [req.session.user.user_id]
  );

  if (!admin) return 'Admin account not found.';

  const valid = await bcrypt.compare(adminPassword, admin.password_hash);
  if (!valid) return 'Invalid admin password.';

  return null;
}

async function updateProfile(req, res) {
  const { last_name, first_name, middle_name, username, email } = req.body;
  const suffix = String(req.body.suffix || '').trim() || null;
  const phone_number = normalizePhoneNumber(req.body.phone_number);

  if (!last_name || !first_name || !middle_name || !username || !email || !phone_number) {
    return res.status(400).json({ error: 'Last name, first name, middle name, username, email, and phone number are required' });
  }

  if (suffix && !VALID_SUFFIXES.has(suffix)) {
    return res.status(400).json({ error: 'Invalid suffix.' });
  }

  if (!/^\d{9}$/.test(phone_number)) {
    return res.status(400).json({ error: 'Phone number must be 9 digits after +639 (example: +639123456789).' });
  }

  try {
    const [[dup]] = await pool.query(
      'SELECT user_id FROM users WHERE (username = ? OR email = ?) AND user_id <> ?',
      [username, email, req.session.user.user_id]
    );
    if (dup) return res.status(409).json({ error: 'Username or email already exists.' });

    await pool.query(
      `UPDATE users
       SET last_name=?, first_name=?, middle_name=?, suffix=?, phone_number=?, username=?, email=?, updated_at=NOW()
       WHERE user_id=?`,
      [last_name, first_name, middle_name, suffix, phone_number, username, email, req.session.user.user_id]
    );

    req.session.user.last_name = last_name;
    req.session.user.first_name = first_name;
    req.session.user.middle_name = middle_name;
    req.session.user.suffix = suffix;
    req.session.user.phone_number = phone_number;
    req.session.user.name = buildDisplayName(last_name, first_name, middle_name, suffix);
    req.session.user.username = username;
    req.session.user.email = email;

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'UPDATE_PROFILE',
      description: 'Profile updated'
    });

    return res.json({
      message: 'Profile updated successfully.',
      user: {
        user_id: req.session.user.user_id,
        role: req.session.user.role,
        last_name,
        first_name,
        middle_name,
        suffix,
        gender: req.session.user.gender,
        phone_number,
        name: req.session.user.name,
        username,
        email
      }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
}

async function updatePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing passwords' });

  const policy = validatePasswordRules(newPassword);
  if (!policy.ok) return res.status(400).json({ error: policy.message });

  try {
    const [[user]] = await pool.query('SELECT password_hash FROM users WHERE user_id=?', [req.session.user.user_id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=?, updated_at=NOW() WHERE user_id=?', [hash, req.session.user.user_id]);
    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'CHANGE_PASSWORD',
      description: 'Password changed'
    });
    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update password' });
  }
}

async function getStaffList(_req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT user_id, role, last_name, first_name, middle_name, suffix, gender, phone_number, username, email, is_active, created_at, terminated_at
       FROM users
       WHERE role = 'Staff'
       ORDER BY created_at DESC, user_id DESC`
    );

    return res.json({ staff: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch staff accounts' });
  }
}

async function createStaffAccount(req, res) {
  const { admin_password, username, email } = req.body;
  const last_name = String(req.body.last_name || '').trim();
  const first_name = String(req.body.first_name || '').trim();
  const middle_name = String(req.body.middle_name || '').trim();
  const suffix = String(req.body.suffix || '').trim() || null;
  const gender = String(req.body.gender || '').trim();
  const phone_number = normalizePhoneNumber(req.body.phone_number);

  try {
    const stepUpError = await verifyAdminPassword(req, admin_password);
    if (stepUpError) return res.status(401).json({ error: stepUpError });

    if (!last_name || !first_name || !middle_name || !gender || !phone_number || !username || !email) {
      return res.status(400).json({ error: 'Last name, first name, middle name, gender, phone number, username, and email are required.' });
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


    const [[existingUser]] = await pool.query(
      'SELECT user_id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    if (existingUser) return res.status(409).json({ error: 'Username or email already exists.' });

    const user_id = await generateUserId();
    const bootstrapSecret = crypto.randomBytes(24).toString('hex');
    const hash = await bcrypt.hash(bootstrapSecret, 10);

    await pool.query(
      `INSERT INTO users (user_id, role, last_name, first_name, middle_name, suffix, gender, phone_number, username, email, password_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [user_id, 'Staff', last_name, first_name, middle_name, suffix, gender, phone_number, username, email, hash]
    );

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'CREATE_STAFF',
      description: `Created staff account for ${username} (${user_id})`
    });

    return res.json({ message: 'Staff account created successfully. Send reset link so staff can set a password.', user_id });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to create staff account' });
  }
}

async function updateStaffDetails(req, res) {
  const { userId } = req.params;
  const { admin_password, username, email } = req.body;
  const last_name = String(req.body.last_name || '').trim();
  const first_name = String(req.body.first_name || '').trim();
  const middle_name = String(req.body.middle_name || '').trim();
  const suffix = String(req.body.suffix || '').trim() || null;
  const phone_number = normalizePhoneNumber(req.body.phone_number);

  try {
    const stepUpError = await verifyAdminPassword(req, admin_password);
    if (stepUpError) return res.status(401).json({ error: stepUpError });

    if (!last_name || !first_name || !middle_name || !phone_number || !username || !email) {
      return res.status(400).json({ error: 'Last name, first name, middle name, phone number, username, and email are required.' });
    }

    if (suffix && !VALID_SUFFIXES.has(suffix)) {
      return res.status(400).json({ error: 'Invalid suffix.' });
    }

    if (!/^\d{9}$/.test(phone_number)) {
      return res.status(400).json({ error: 'Phone number must be 9 digits after +639 (example: +639123456789).' });
    }

    const [[target]] = await pool.query(
      `SELECT user_id, username, role
       FROM users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role !== 'Staff') return res.status(400).json({ error: 'Only Staff accounts can be edited here.' });

    const [[dup]] = await pool.query(
      'SELECT user_id FROM users WHERE user_id <> ? AND (username = ? OR email = ?)',
      [userId, String(username).trim(), String(email).trim()]
    );
    if (dup) return res.status(409).json({ error: 'Username or email already exists.' });

    await pool.query(
      `UPDATE users
       SET last_name = ?, first_name = ?, middle_name = ?, suffix = ?, phone_number = ?, username = ?, email = ?, updated_at = NOW()
       WHERE user_id = ?`,
      [last_name, first_name, middle_name, suffix, phone_number, String(username).trim(), String(email).trim(), userId]
    );

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'EDIT_STAFF',
      description: `Updated staff account details for ${target.username} (${target.user_id})`
    });

    return res.json({ message: 'Staff details updated successfully.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists.' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to update staff details' });
  }
}

async function updateStaffStatus(req, res) {
  const { userId } = req.params;
  const { is_active, admin_password } = req.body;

  try {
    const stepUpError = await verifyAdminPassword(req, admin_password);
    if (stepUpError) return res.status(401).json({ error: stepUpError });

    if (!['0', '1', 0, 1, true, false].includes(is_active)) {
      return res.status(400).json({ error: 'is_active must be true/false or 1/0.' });
    }

    const activeFlag = is_active === true || is_active === 1 || is_active === '1' ? 1 : 0;

    const [[target]] = await pool.query(
      `SELECT user_id, username, role
       FROM users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role !== 'Staff') return res.status(400).json({ error: 'Only Staff accounts can be updated here.' });

    await pool.query('UPDATE users SET is_active = ?, terminated_at = CASE WHEN ? = 0 THEN NOW() ELSE NULL END, updated_at = NOW() WHERE user_id = ?', [activeFlag, activeFlag, userId]);

    if (!activeFlag) {
      await pool.query('DELETE FROM sessions WHERE data LIKE ?', [`%\"user_id\":\"${userId}\"%`]);
    }

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: activeFlag ? 'ACTIVATE_STAFF' : 'DEACTIVATE_STAFF',
      description: `${activeFlag ? 'Activated' : 'Deactivated'} staff account ${target.username} (${target.user_id})`
    });

    return res.json({ message: `Staff account ${activeFlag ? 'activated' : 'deactivated'} successfully.` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update staff status' });
  }
}

async function updateStaffRole(req, res) {
  const { userId } = req.params;
  const { role, admin_password } = req.body;

  try {
    const stepUpError = await verifyAdminPassword(req, admin_password);
    if (stepUpError) return res.status(401).json({ error: stepUpError });

    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Role must be Admin or Staff.' });
    }

    const [[target]] = await pool.query(
      'SELECT user_id, username, role FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!target) return res.status(404).json({ error: 'User not found.' });

    if (target.user_id === req.session.user.user_id) {
      return res.status(400).json({ error: 'You cannot change your own role from this module.' });
    }

    await pool.query('UPDATE users SET role = ?, updated_at = NOW() WHERE user_id = ?', [role, userId]);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'UPDATE_STAFF_ROLE',
      description: `Changed role of ${target.username} (${target.user_id}) to ${role}`
    });

    return res.json({ message: 'Staff role updated successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update staff role' });
  }
}

async function sendStaffResetLink(req, res) {
  const { userId } = req.params;
  const { admin_password } = req.body;

  try {
    const stepUpError = await verifyAdminPassword(req, admin_password);
    if (stepUpError) return res.status(401).json({ error: stepUpError });

    const [[staff]] = await pool.query(
      `SELECT user_id, username, email, role, is_active
       FROM users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );

    if (!staff) return res.status(404).json({ error: 'User not found.' });
    if (staff.role !== 'Staff') return res.status(400).json({ error: 'Only Staff accounts can use this action.' });
    if (!staff.is_active) return res.status(400).json({ error: 'Cannot send reset link to an inactive account.' });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await pool.query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
      [staff.user_id]
    );

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [staff.user_id, tokenHash]
    );

    await sendResetEmail(staff.email, token);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'RESET_STAFF_PASSWORD',
      description: `Sent password reset link to ${staff.username} (${staff.user_id})`
    });

    return res.json({ message: 'Password reset link sent to staff email.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Failed to send reset link' });
  }
}

module.exports = {
  updateProfile,
  updatePassword,
  getStaffList,
  createStaffAccount,
  updateStaffDetails,
  updateStaffStatus,
  updateStaffRole,
  sendStaffResetLink
};

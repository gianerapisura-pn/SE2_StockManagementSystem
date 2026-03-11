const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/loginRateLimit');

const router = express.Router();

router.get('/register-status', authController.registerStatus);
router.post('/register', authController.register);
router.post('/login', loginRateLimit, authController.login);
router.post('/logout', requireAuth, authController.logout);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/me', requireAuth, authController.me);

module.exports = router;

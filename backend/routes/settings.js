const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const settingsController = require('../controllers/settingsController');

const router = express.Router();

router.use(requireAuth);

router.put('/profile', settingsController.updateProfile);
router.put('/password', settingsController.updatePassword);

router.get('/staff', requireRole('Admin'), settingsController.getStaffList);
router.post('/staff', requireRole('Admin'), settingsController.createStaffAccount);
router.put('/staff/:userId', requireRole('Admin'), settingsController.updateStaffDetails);
router.put('/staff/:userId/status', requireRole('Admin'), settingsController.updateStaffStatus);
router.put('/staff/:userId/role', requireRole('Admin'), settingsController.updateStaffRole);
router.post('/staff/:userId/send-reset-link', requireRole('Admin'), settingsController.sendStaffResetLink);

module.exports = router;

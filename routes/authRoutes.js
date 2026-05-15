// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');

// Public routes
router.post('/request-otp', authController.requestOTP);
router.post('/verify-otp', authController.verifyOTP);

// Protected routes (require valid token)
router.post('/register', authenticate, authController.register);
router.post('/register-driver', authenticate, authController.registerDriver);
router.get('/me', authenticate, authController.getMe);

module.exports = router;

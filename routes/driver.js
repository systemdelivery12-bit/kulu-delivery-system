// routes/driver.js
const express = require('express');
const router = express.Router();
const driverCtrl = require('../controllers/driverController');
const { authenticate } = require('../middleware/authMiddleware');
const pool = require('../db/pool');

// Middleware: must be a driver and approved
const requireApprovedDriver = async (req, res, next) => {
  if (req.user.role !== 'driver') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Driver access only' } });
  }
  try {
    const driver = await pool.query('SELECT * FROM drivers WHERE user_id = $1 AND is_approved = true', [req.user.userId]);
    if (driver.rows.length === 0) {
      return res.status(403).json({ success: false, error: { code: 'NOT_APPROVED', message: 'Driver not approved yet' } });
    }
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'ERROR', message: err.message } });
  }
};

router.use(authenticate, requireApprovedDriver);

router.put('/status', driverCtrl.toggleOnline);
router.get('/assignments', driverCtrl.getAssignments);
router.put('/assignments/:id/respond', driverCtrl.respondToAssignment);
router.put('/stops/:stopId/status', driverCtrl.updateStopStatus);
router.post('/location', driverCtrl.sendLocation);
router.get('/earnings', driverCtrl.getEarnings);

module.exports = router;

const express = require('express');
const router = express.Router();
const dashboardCtrl = require('../controllers/adminDashboardController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate, authorize('admin'));

router.get('/orders/pending', dashboardCtrl.getPendingOrders);
router.get('/drivers/online', dashboardCtrl.getOnlineDrivers);
router.get('/drivers/locations', dashboardCtrl.getDriverLocations);   // ← NEW
router.post('/assign', dashboardCtrl.assignOrders);
router.post('/reassign', dashboardCtrl.reassignDriver);
router.get('/assignments/active', dashboardCtrl.getActiveAssignments);

module.exports = router;

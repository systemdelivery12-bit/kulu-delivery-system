const express = require('express');
const router = express.Router();
const dashboardCtrl = require('../controllers/adminDashboardController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate, authorize('admin'));

// Orders & drivers
router.get('/orders/pending', dashboardCtrl.getPendingOrders);
router.get('/drivers/online', dashboardCtrl.getOnlineDrivers);
router.get('/drivers/locations', dashboardCtrl.getDriverLocations);
router.post('/assign', dashboardCtrl.assignOrders);
router.post('/reassign', dashboardCtrl.reassignDriver);
router.get('/assignments/active', dashboardCtrl.getActiveAssignments);

// Coin packages management
router.post('/coin-packages', dashboardCtrl.createCoinPackage);
router.get('/coin-packages', dashboardCtrl.getCoinPackages);
router.put('/coin-packages/:id', dashboardCtrl.updateCoinPackage);

// Bonus coins to driver
router.post('/drivers/:driverId/bonus', dashboardCtrl.addBonusCoins);

// Coin transactions history (all)
router.get('/coin-transactions', dashboardCtrl.getCoinTransactions);

module.exports = router;

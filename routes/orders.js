const express = require('express');
const router = express.Router();
const orderCtrl = require('../controllers/orderController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate);

router.post('/estimate', orderCtrl.estimateOrder);
router.post('/', authorize('customer'), orderCtrl.createOrder);
router.get('/', authorize('customer'), orderCtrl.getOrders);
router.get('/:id/tracking', orderCtrl.getOrderTracking);   // NEW
router.get('/:id', orderCtrl.getOrderById);

module.exports = router;

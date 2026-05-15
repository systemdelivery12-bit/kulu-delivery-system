const express = require('express');
const router = express.Router();
const orderCtrl = require('../controllers/orderController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

// All order actions require authentication as customer
router.use(authenticate);

// Estimate delivery fee (any authenticated user, but typically customer)
router.post('/estimate', orderCtrl.estimateOrder);

// Place order (customer only)
router.post('/', authorize('customer'), orderCtrl.createOrder);

// Get order history (customer only)
router.get('/', authorize('customer'), orderCtrl.getOrders);

// Get single order detail
router.get('/:id', orderCtrl.getOrderById);

module.exports = router;

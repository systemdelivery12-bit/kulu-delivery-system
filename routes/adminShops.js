const express = require('express');
const router = express.Router();
const shopCtrl = require('../controllers/adminShopController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate, authorize('admin'));

router.post('/', shopCtrl.createShop);
router.get('/', shopCtrl.getAllShops);
router.put('/:id', shopCtrl.updateShop);
router.delete('/:id', shopCtrl.deleteShop);

module.exports = router;

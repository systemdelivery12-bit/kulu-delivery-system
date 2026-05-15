const express = require('express');
const router = express.Router();
const prodCtrl = require('../controllers/adminProductController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

router.use(authenticate, authorize('admin'));

router.post('/', prodCtrl.createProduct);
router.get('/shop/:shopId', prodCtrl.getShopProducts);
router.put('/:id', prodCtrl.updateProduct);
router.delete('/:id', prodCtrl.deleteProduct);

module.exports = router;

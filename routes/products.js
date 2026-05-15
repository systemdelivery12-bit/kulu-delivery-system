const express = require('express');
const router = express.Router();
const productCtrl = require('../controllers/productController');

router.get('/', productCtrl.getProducts);
router.get('/:id', productCtrl.getProductById);

module.exports = router;

const pool = require('../db/pool');

exports.createProduct = async (req, res) => {
  const { shopId, nameTig, descriptionTig, price, imageUrl } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO products (shop_id, name_tig, description_tig, price, image_url) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [shopId, nameTig, descriptionTig || null, price, imageUrl || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'PRODUCT_CREATE_FAIL', message: err.message } });
  }
};

exports.getShopProducts = async (req, res) => {
  const shopId = req.params.shopId;
  try {
    const result = await pool.query('SELECT * FROM products WHERE shop_id = $1 AND is_available = true', [shopId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

exports.updateProduct = async (req, res) => {
  const { id } = req.params;
  const { nameTig, descriptionTig, price, imageUrl, isAvailable } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products SET name_tig=$1, description_tig=$2, price=$3, image_url=$4, is_available=$5 WHERE id=$6 RETURNING *`,
      [nameTig, descriptionTig, price, imageUrl, isAvailable, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'UPDATE_FAIL', message: err.message } });
  }
};

exports.deleteProduct = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE products SET is_available = false WHERE id = $1', [id]);
    res.json({ success: true, message: 'Product deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DELETE_FAIL', message: err.message } });
  }
};

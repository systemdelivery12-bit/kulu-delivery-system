const pool = require('../db/pool');

// POST /admin/shops
exports.createShop = async (req, res) => {
  const { nameTig, category, zoneId, phone, coordinates, logoImage } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO shops (name_tig, category, zone_id, phone, coordinates, logo_image)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nameTig, category, zoneId, phone, coordinates || null, logoImage || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SHOP_CREATE_FAIL', message: err.message } });
  }
};

// GET /admin/shops
exports.getAllShops = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shops ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// PUT /admin/shops/:id
exports.updateShop = async (req, res) => {
  const { id } = req.params;
  const { nameTig, category, zoneId, phone, coordinates, logoImage, isActive } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shops SET name_tig=$1, category=$2, zone_id=$3, phone=$4, coordinates=$5, logo_image=$6, is_active=$7 WHERE id=$8 RETURNING *`,
      [nameTig, category, zoneId, phone, coordinates, logoImage, isActive, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'UPDATE_FAIL', message: err.message } });
  }
};

// DELETE /admin/shops/:id (soft delete by setting is_active = false)
exports.deleteShop = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [id]);
    res.json({ success: true, message: 'Shop deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DELETE_FAIL', message: err.message } });
  }
};

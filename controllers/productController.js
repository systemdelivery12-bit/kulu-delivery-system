const pool = require('../db/pool');

// GET /products?search=&category=&zoneId=&shopId=&sortBy=&page=&limit=
exports.getProducts = async (req, res) => {
  const { search, category, zoneId, shopId, sortBy, page = 1, limit = 20 } = req.query;
  let query = `
    SELECT p.*, s.name_tig as shop_name, s.category as shop_category, s.zone_id as shop_zone_id,
           z.name_tig as shop_zone_name
    FROM products p
    JOIN shops s ON p.shop_id = s.id
    JOIN zones z ON s.zone_id = z.id
    WHERE p.is_available = true AND s.is_active = true
  `;
  const params = [];
  let paramIndex = 1;

  if (search) {
    query += ` AND (p.name_tig ILIKE $${paramIndex} OR p.description_tig ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }
  if (category) {
    query += ` AND s.category = $${paramIndex}`;
    params.push(category);
    paramIndex++;
  }
  if (zoneId) {
    query += ` AND s.zone_id = $${paramIndex}`;
    params.push(zoneId);
    paramIndex++;
  }
  if (shopId) {
    query += ` AND s.id = $${paramIndex}`;
    params.push(shopId);
    paramIndex++;
  }

  // Sorting
  if (sortBy === 'price_asc') query += ' ORDER BY p.price ASC';
  else if (sortBy === 'price_desc') query += ' ORDER BY p.price DESC';
  else if (sortBy === 'newest') query += ' ORDER BY p.created_at DESC';
  else query += ' ORDER BY p.id DESC'; // default

  // Pagination
  const offset = (page - 1) * limit;
  query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(query, params);
    // Count total (simplified, can do a separate count query)
    res.json({ success: true, data: result.rows, page, limit });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// GET /products/:id
exports.getProductById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT p.*, s.name_tig as shop_name, s.zone_id as shop_zone_id, z.name_tig as shop_zone_name
       FROM products p
       JOIN shops s ON p.shop_id = s.id
       JOIN zones z ON s.zone_id = z.id
       WHERE p.id = $1 AND p.is_available = true`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

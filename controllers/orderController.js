const pool = require('../db/pool');
const { calculateFee, estimateTravelTime } = require('../utils/deliveryFee');

exports.estimateOrder = async (req, res) => {
  const { items, deliveryZoneId } = req.body;
  if (!items || !items.length || !deliveryZoneId) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'Items and deliveryZoneId required' } });
  }

  try {
    const zoneRes = await pool.query('SELECT coordinates FROM zones WHERE id = $1', [deliveryZoneId]);
    const customerCoords = zoneRes.rows[0]?.coordinates || null;

    let itemTotal = 0;
    const shopCoords = [];

    for (const item of items) {
      const product = await pool.query(
        `SELECT p.price, s.coordinates as shop_coords, s.id as shop_id
         FROM products p JOIN shops s ON p.shop_id = s.id
         WHERE p.id = $1 AND p.is_available = true`,
        [item.productId]
      );
      if (product.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: 'PRODUCT_NOT_FOUND', message: `Product ${item.productId} not found` } });
      }
      const prod = product.rows[0];
      itemTotal += prod.price * (item.quantity || 1);

      if (!shopCoords.find(c => c.shopId === prod.shop_id)) {
        shopCoords.push({ shopId: prod.shop_id, coords: prod.shop_coords });
      }
    }

    let totalMinutes = 0;
    for (let i = 0; i < shopCoords.length; i++) {
      if (i > 0) {
        totalMinutes += await estimateTravelTime(shopCoords[i-1].coords, shopCoords[i].coords);
      }
    }
    if (shopCoords.length > 0 && customerCoords) {
      totalMinutes += await estimateTravelTime(shopCoords[shopCoords.length-1].coords, customerCoords);
    } else {
      totalMinutes += 15;
    }

    const deliveryFee = await calculateFee(totalMinutes);

    res.json({
      success: true,
      data: {
        itemTotal,
        deliveryFee,
        total: itemTotal + deliveryFee,
        breakdown: { totalMinutes, feeCalculation: `Total time ${totalMinutes} min → fee ${deliveryFee} Birr` }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'ESTIMATE_FAIL', message: err.message } });
  }
};

exports.createOrder = async (req, res) => {
  const customerId = req.user.userId;
  const { items, deliveryZoneId, paymentMethod, note } = req.body;

  if (!items || !items.length || !deliveryZoneId || !paymentMethod) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let itemTotal = 0;
    const shopCoords = [];
    const orderItemsData = [];

    for (const item of items) {
      const prod = await client.query(
        `SELECT p.price, p.shop_id, s.coordinates as shop_coords
         FROM products p JOIN shops s ON p.shop_id = s.id
         WHERE p.id = $1 AND p.is_available = true`,
        [item.productId]
      );
      if (prod.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: { code: 'PRODUCT_NOT_FOUND' } });
      }
      const p = prod.rows[0];
      const qty = item.quantity || 1;
      itemTotal += p.price * qty;
      orderItemsData.push({ productId: item.productId, shopId: p.shop_id, quantity: qty, unitPrice: p.price });

      if (!shopCoords.find(c => c.shopId === p.shop_id)) {
        shopCoords.push({ shopId: p.shop_id, coords: p.shop_coords });
      }
    }

    let totalMinutes = 0;
    const zoneRes = await client.query('SELECT coordinates FROM zones WHERE id = $1', [deliveryZoneId]);
    const customerCoords = zoneRes.rows[0]?.coordinates || null;

    for (let i = 0; i < shopCoords.length; i++) {
      if (i > 0) {
        totalMinutes += await estimateTravelTime(shopCoords[i-1].coords, shopCoords[i].coords);
      }
    }
    if (shopCoords.length > 0 && customerCoords) {
      totalMinutes += await estimateTravelTime(shopCoords[shopCoords.length-1].coords, customerCoords);
    } else {
      totalMinutes += 15;
    }

    const deliveryFee = await calculateFee(totalMinutes);
    const totalAmount = itemTotal + deliveryFee;

    let orderStatus = 'pending_assignment';
    let paymentStatus = 'unpaid';
    if (paymentMethod !== 'cod') {
      orderStatus = 'pending_payment';
      paymentStatus = 'pending_verification';
    }

    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, delivery_zone_id, status, payment_method, payment_status, item_total, delivery_fee, total_amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [customerId, deliveryZoneId, orderStatus, paymentMethod, paymentStatus, itemTotal, deliveryFee, totalAmount, note || null]
    );
    const orderId = orderResult.rows[0].id;

    for (const item of orderItemsData) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, shop_id, quantity, unit_price) VALUES ($1,$2,$3,$4,$5)',
        [orderId, item.productId, item.shopId, item.quantity, item.unitPrice]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: { orderId, status: orderStatus, itemTotal, deliveryFee, totalAmount }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'ORDER_CREATE_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

exports.getOrderById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;

  try {
    let query;
    if (role === 'admin') {
      query = 'SELECT * FROM orders WHERE id = $1';
    } else {
      query = 'SELECT * FROM orders WHERE id = $1 AND customer_id = $2';
    }
    const params = role === 'admin' ? [id] : [id, userId];
    const orderRes = await pool.query(query, params);
    if (orderRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    }
    const order = orderRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT oi.*, p.name_tig as product_name, p.image_url FROM order_items oi
       JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1`,
      [id]
    );
    order.items = itemsRes.rows;

    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

exports.getOrders = async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// NEW – get live tracking for one order
exports.getOrderTracking = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;

  try {
    let order;
    if (role === 'admin') {
      order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    } else {
      order = await pool.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2', [id, userId]);
    }
    if (order.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    }

    const assignment = await pool.query(
      `SELECT a.* FROM assignments a
       JOIN assignment_items ai ON a.id = ai.assignment_id
       JOIN order_items oi ON ai.order_item_id = oi.id
       WHERE oi.order_id = $1 AND a.status IN ('accepted', 'in_progress')
       ORDER BY a.assigned_at DESC LIMIT 1`,
      [id]
    );

    if (assignment.rows.length === 0) {
      return res.json({
        success: true,
        data: { order: order.rows[0], driver: null, stops: [], latestLocation: null }
      });
    }

    const assign = assignment.rows[0];
    const driver = await pool.query(
      'SELECT u.full_name, u.phone, d.vehicle_type, d.rating FROM users u JOIN drivers d ON u.id = d.user_id WHERE u.id = $1',
      [assign.driver_id]
    );
    const stops = await pool.query('SELECT * FROM delivery_stops WHERE assignment_id = $1 ORDER BY sequence', [assign.id]);
    const location = await pool.query(
      'SELECT lat, lng, recorded_at FROM driver_tracking_log WHERE driver_id = $1 AND assignment_id = $2 ORDER BY recorded_at DESC LIMIT 1',
      [assign.driver_id, assign.id]
    );

    res.json({
      success: true,
      data: {
        order: order.rows[0],
        driver: driver.rows[0] || null,
        stops: stops.rows,
        latestLocation: location.rows[0] || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

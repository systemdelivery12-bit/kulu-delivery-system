// controllers/orderController.js
const pool = require('../db/pool');
const { calculateFee, estimateTravelTime } = require('../utils/deliveryFee');

// POST /orders/estimate
exports.estimateOrder = async (req, res) => {
  const { items, deliveryZoneId } = req.body;
  if (!items || !items.length || !deliveryZoneId) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'Items and deliveryZoneId required' } });
  }

  try {
    // Get delivery zone coordinates (if any)
    const zoneRes = await pool.query('SELECT coordinates FROM zones WHERE id = $1', [deliveryZoneId]);
    const customerCoords = zoneRes.rows[0]?.coordinates || null;

    let itemTotal = 0;
    const shopCoords = [];  // store coordinates of each shop in order of route

    // Fetch product details and shop coordinates
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
      
      // Avoid duplicate shop coords if same shop appears twice? For route, we only need unique stops.
      // But for simplicity, we assume items from same shop are in one pickup; we'll just push the shop coords once.
      if (!shopCoords.find(c => c.shopId === prod.shop_id)) {
        shopCoords.push({ shopId: prod.shop_id, coords: prod.shop_coords });
      }
    }

    // Build route: shop1 -> shop2 -> ... -> customer
    let totalMinutes = 0;
    let currentCoord = shopCoords.length > 0 ? shopCoords[0].coords : null; // start at first shop (driver goes there first)
    // Actually the driver starts from a central point; we ignore that now. We'll just calculate shop-to-shop then last shop to customer.
    // Better: route = first shop -> second shop -> ... -> last shop -> customer
    for (let i = 0; i < shopCoords.length; i++) {
      if (i > 0) {
        // from previous shop to this shop
        const mins = await estimateTravelTime(shopCoords[i-1].coords, shopCoords[i].coords);
        totalMinutes += mins;
      }
    }
    // from last shop to customer
    if (shopCoords.length > 0 && customerCoords) {
      const lastShopCoord = shopCoords[shopCoords.length-1].coords;
      const mins = await estimateTravelTime(lastShopCoord, customerCoords);
      totalMinutes += mins;
    } else {
      // fallback if no coords: assume 15 min
      totalMinutes += 15;
    }

    // Calculate delivery fee
    const deliveryFee = await calculateFee(totalMinutes);

    res.json({
      success: true,
      data: {
        itemTotal,
        deliveryFee,
        total: itemTotal + deliveryFee,
        breakdown: {
          totalMinutes,
          feeCalculation: `Total time ${totalMinutes} min → fee ${deliveryFee} Birr`
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'ESTIMATE_FAIL', message: err.message } });
  }
};

// POST /orders
exports.createOrder = async (req, res) => {
  const customerId = req.user.userId; // from auth middleware
  const { items, deliveryZoneId, paymentMethod, note } = req.body;

  if (!items || !items.length || !deliveryZoneId || !paymentMethod) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Calculate item total and gather shop info (same as estimate)
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

    // 2. Estimate total travel time and delivery fee
    let totalMinutes = 0;
    // Get customer zone coordinates
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
      totalMinutes += 15; // fallback
    }

    const deliveryFee = await calculateFee(totalMinutes);
    const totalAmount = itemTotal + deliveryFee;

    // 3. Set payment status based on method
    let orderStatus = 'pending_assignment';
    let paymentStatus = 'unpaid';
    if (paymentMethod === 'cod') {
      paymentStatus = 'unpaid'; // COD is collected later
    } else {
      // For bank/wallet, require manual verification -> pending_payment
      orderStatus = 'pending_payment';
      paymentStatus = 'pending_verification';
    }

    // 4. Insert order
    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, delivery_zone_id, status, payment_method, payment_status, item_total, delivery_fee, total_amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [customerId, deliveryZoneId, orderStatus, paymentMethod, paymentStatus, itemTotal, deliveryFee, totalAmount, note || null]
    );
    const orderId = orderResult.rows[0].id;

    // 5. Insert order items
    for (const item of orderItemsData) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, shop_id, quantity, unit_price) VALUES ($1,$2,$3,$4,$5)`,
        [orderId, item.productId, item.shopId, item.quantity, item.unitPrice]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: {
        orderId,
        status: orderStatus,
        itemTotal,
        deliveryFee,
        totalAmount
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'ORDER_CREATE_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

// GET /orders/:id
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

    // Fetch items
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

// GET /orders (history for customer)
exports.getOrders = async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

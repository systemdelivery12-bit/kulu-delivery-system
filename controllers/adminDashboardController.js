// controllers/adminDashboardController.js
const pool = require('../db/pool');

// GET /admin/orders/pending – all orders waiting for assignment
exports.getPendingOrders = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, z.name_tig as zone_name
       FROM orders o
       JOIN zones z ON o.delivery_zone_id = z.id
       WHERE o.status = 'pending_assignment'
       ORDER BY o.created_at ASC`
    );
    // For each order, also fetch its items (optional but helpful)
    const orders = result.rows;
    for (let order of orders) {
      const items = await pool.query(
        `SELECT oi.*, p.name_tig as product_name
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [order.id]
      );
      order.items = items.rows;
    }
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// GET /admin/drivers/online – drivers currently online
exports.getOnlineDrivers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, u.full_name, u.phone,
        (SELECT COUNT(*) FROM assignments a WHERE a.driver_id = d.user_id AND a.status IN ('accepted','in_progress')) as current_load
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE d.is_online = true AND d.is_approved = true`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// POST /admin/assign – assign one or more orders to a driver
exports.assignOrders = async (req, res) => {
  const { driverId, orderIds } = req.body;
  if (!driverId || !orderIds || !orderIds.length) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'driverId and orderIds required' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify driver exists, is approved and online
    const driver = await client.query(
      'SELECT * FROM drivers WHERE user_id = $1 AND is_approved = true AND is_online = true',
      [driverId]
    );
    if (driver.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'DRIVER_NOT_AVAILABLE' } });
    }

    // 2. Verify all orders are in pending_assignment status and fetch their zones
    const orders = [];
    for (const orderId of orderIds) {
      const orderRes = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND status = $2',
        [orderId, 'pending_assignment']
      );
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: { code: 'ORDER_NOT_AVAILABLE', message: `Order ${orderId} is not pending` } });
      }
      orders.push(orderRes.rows[0]);
    }

    // 3. Check driver capacity (max_orders - current load)
    const currentLoad = await client.query(
      'SELECT COUNT(*)::int FROM assignments WHERE driver_id = $1 AND status IN ($2,$3)',
      [driverId, 'accepted', 'in_progress']
    );
    const load = currentLoad.rows[0].count;
    if (load + orderIds.length > driver.rows[0].max_orders) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'DRIVER_FULL' } });
    }

    // 4. Create one assignment for all these orders
    const assignmentRes = await client.query(
      'INSERT INTO assignments (driver_id, status) VALUES ($1, $2) RETURNING id',
      [driverId, 'pending_accept']
    );
    const assignmentId = assignmentRes.rows[0].id;

    // 5. Link all order items from these orders to the assignment
    // and gather shops/zones to build route
    const shopIds = new Set();
    let customerZoneId = null;
    let customerCoords = null;
    let customerName = '';

    for (const order of orders) {
      // Update order status
      await client.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', ['assigned', order.id]);

      // Get order items
      const items = await client.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
      for (const item of items.rows) {
        await client.query(
          'INSERT INTO assignment_items (assignment_id, order_item_id) VALUES ($1, $2)',
          [assignmentId, item.id]
        );
        // Collect unique shops
        shopIds.add(item.shop_id);
      }

      // We'll use the first order's customer info for the drop (all orders should be from same customer? Actually, batching multiple orders from different customers is possible.
      // For simplicity now, we assume admin groups same-customer orders or we create separate drops per order. Let's design: each order has its own customer and zone.
      // We'll store the zone IDs of each order to build drops later. Better: we'll just build a drop for each unique customer/zone.
      // For now, we’ll handle one customer only (if different customers, admin should assign separately – this is MVP).
      if (!customerZoneId) {
        customerZoneId = order.delivery_zone_id;
        const cust = await client.query('SELECT full_name FROM users WHERE id = $1', [order.customer_id]);
        customerName = cust.rows[0]?.full_name || 'Customer';
        const zone = await client.query('SELECT coordinates FROM zones WHERE id = $1', [customerZoneId]);
        customerCoords = zone.rows[0]?.coordinates || null;
      } else {
        // For MVP, if multiple different customers, we'll just use the first; later we can split.
        // You can enhance by creating separate drops per order.
      }
    }

    // 6. Build delivery_stops: pickups (each unique shop) then drop
    let seq = 1;
    const shopRows = await client.query(
      'SELECT id, name_tig, coordinates FROM shops WHERE id = ANY($1)',
      [Array.from(shopIds)]
    );
    // Sort shops by ID for a predictable route (later admin can reorder)
    shopRows.rows.sort((a,b) => a.id - b.id);

    for (const shop of shopRows.rows) {
      await client.query(
        `INSERT INTO delivery_stops (assignment_id, sequence, stop_type, location_type, reference_id, coordinates, status)
         VALUES ($1, $2, 'pickup', 'shop', $3, $4, 'pending')`,
        [assignmentId, seq, shop.id, shop.coordinates]
      );
      seq++;
    }

    // Drop at customer (only one for now, if multiple customers, repeat)
    // For MVP, we assume all orders go to the same customer or at least same zone. If there are different zones, we would need multiple drops.
    // Let's handle multiple distinct zones: add a drop for each unique zone in orders.
    const uniqueZones = new Map();
    for (const order of orders) {
      if (!uniqueZones.has(order.delivery_zone_id)) {
        uniqueZones.set(order.delivery_zone_id, order.customer_id);
      }
    }
    for (const [zoneId, custId] of uniqueZones) {
      const zoneCoords = await client.query('SELECT coordinates FROM zones WHERE id = $1', [zoneId]);
      await client.query(
        `INSERT INTO delivery_stops (assignment_id, sequence, stop_type, location_type, reference_id, coordinates, status)
         VALUES ($1, $2, 'drop', 'customer', $3, $4, 'pending')`,
        [assignmentId, seq, custId, zoneCoords.rows[0]?.coordinates || null]
      );
      seq++;
    }

    await client.query('COMMIT');

    // 7. Fetch the complete assignment to return
    const fullAssignment = await pool.query(
      'SELECT * FROM assignments WHERE id = $1', [assignmentId]
    );
    const stops = await pool.query(
      'SELECT * FROM delivery_stops WHERE assignment_id = $1 ORDER BY sequence', [assignmentId]
    );

    res.status(201).json({
      success: true,
      data: {
        assignment: fullAssignment.rows[0],
        stops: stops.rows
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'ASSIGN_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

// POST /admin/reassign – reassign an entire assignment to a new driver
exports.reassignDriver = async (req, res) => {
  const { assignmentId, newDriverId } = req.body;
  if (!assignmentId || !newDriverId) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify assignment exists and is not completed
    const assign = await client.query('SELECT * FROM assignments WHERE id = $1 AND status != $2', [assignmentId, 'completed']);
    if (assign.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND_OR_COMPLETED' } });
    }

    // Verify new driver is available
    const driver = await client.query('SELECT * FROM drivers WHERE user_id = $1 AND is_approved = true AND is_online = true', [newDriverId]);
    if (driver.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'DRIVER_NOT_AVAILABLE' } });
    }

    // Update assignment driver_id, set status back to pending_accept
    await client.query(
      'UPDATE assignments SET driver_id = $1, status = $2, accepted_at = NULL WHERE id = $3',
      [newDriverId, 'pending_accept', assignmentId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Assignment reassigned' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'REASSIGN_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

// GET /admin/assignments/active – active deliveries
exports.getActiveAssignments = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.full_name as driver_name, u.phone as driver_phone, d.vehicle_type,
        (SELECT json_agg(json_build_object('stop_id', ds.id, 'sequence', ds.sequence, 'stop_type', ds.stop_type, 'status', ds.status))
         FROM delivery_stops ds WHERE ds.assignment_id = a.id ORDER BY ds.sequence) as stops
       FROM assignments a
       JOIN drivers d ON a.driver_id = d.user_id
       JOIN users u ON d.user_id = u.id
       WHERE a.status IN ('accepted', 'in_progress')
       ORDER BY a.assigned_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

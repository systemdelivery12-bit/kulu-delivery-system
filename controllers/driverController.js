// controllers/driverController.js
const pool = require('../db/pool');

// Utility: get driver profile from req.user
const getDriverId = (req) => req.user.userId;

// PUT /driver/status  (toggle online/offline)
exports.toggleOnline = async (req, res) => {
  const driverId = getDriverId(req);
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'isOnline required' } });
  }
  try {
    await pool.query('UPDATE drivers SET is_online = $1 WHERE user_id = $2', [isOnline, driverId]);
    res.json({ success: true, data: { isOnline } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'TOGGLE_FAIL', message: err.message } });
  }
};

// GET /driver/assignments  (active tasks)
exports.getAssignments = async (req, res) => {
  const driverId = getDriverId(req);
  try {
    const assignments = await pool.query(
      `SELECT a.*, 
        (SELECT json_agg(json_build_object(
          'stopId', ds.id, 'sequence', ds.sequence, 'stopType', ds.stop_type,
          'locationType', ds.location_type, 'referenceId', ds.reference_id,
          'status', ds.status, 'coordinates', ds.coordinates
        ) ORDER BY ds.sequence)
         FROM delivery_stops ds WHERE ds.assignment_id = a.id) as stops
       FROM assignments a
       WHERE a.driver_id = $1 AND a.status IN ('pending_accept', 'accepted', 'in_progress')
       ORDER BY a.assigned_at DESC`,
      [driverId]
    );

    // For each assignment, fetch order details (customer, items)
    for (let asgn of assignments.rows) {
      // Get unique order ids from assignment_items -> order_items -> order_id
      const orderIdsRes = await pool.query(
        `SELECT DISTINCT oi.order_id
         FROM assignment_items ai
         JOIN order_items oi ON ai.order_item_id = oi.id
         WHERE ai.assignment_id = $1`,
        [asgn.id]
      );
      const orderIds = orderIdsRes.rows.map(r => r.order_id);
      asgn.orderIds = orderIds;
      // Fetch basic order info (customer name, zone, total)
      if (orderIds.length > 0) {
        const ordersRes = await pool.query(
          `SELECT o.id, o.delivery_fee, o.total_amount, u.full_name as customer_name, z.name_tig as zone_name
           FROM orders o
           JOIN users u ON o.customer_id = u.id
           JOIN zones z ON o.delivery_zone_id = z.id
           WHERE o.id = ANY($1)`,
          [orderIds]
        );
        asgn.orders = ordersRes.rows;
        // Compute total earnings for this assignment (sum of delivery_fee)
        asgn.earnings = ordersRes.rows.reduce((sum, o) => sum + parseFloat(o.delivery_fee), 0);
      } else {
        asgn.orders = [];
        asgn.earnings = 0;
      }
    }

    res.json({ success: true, data: assignments.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

// PUT /driver/assignments/:id/respond  (accept or reject)
exports.respondToAssignment = async (req, res) => {
  const driverId = getDriverId(req);
  const { id } = req.params; // assignment id
  const { response } = req.body; // 'accept' or 'reject'

  if (!response || !['accept', 'reject'].includes(response)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_RESPONSE' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify assignment belongs to this driver and is pending_accept
    const asgn = await client.query(
      'SELECT * FROM assignments WHERE id = $1 AND driver_id = $2 AND status = $3',
      [id, driverId, 'pending_accept']
    );
    if (asgn.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: { code: 'ASSIGNMENT_NOT_AVAILABLE' } });
    }

    if (response === 'accept') {
      await client.query('UPDATE assignments SET status = $1, accepted_at = NOW() WHERE id = $2', ['accepted', id]);
      // Orders stay in 'assigned' status, driver will start when they update first stop.
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Assignment accepted' });
    } else {
      // Reject: set assignment to rejected, and revert orders to pending_assignment
      await client.query('UPDATE assignments SET status = $1 WHERE id = $2', ['rejected', id]);

      // Get all order_ids from this assignment
      const orderIds = await client.query(
        `SELECT DISTINCT oi.order_id
         FROM assignment_items ai
         JOIN order_items oi ON ai.order_item_id = oi.id
         WHERE ai.assignment_id = $1`,
        [id]
      );
      for (let row of orderIds.rows) {
        await client.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', ['pending_assignment', row.order_id]);
      }
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Assignment rejected, orders returned to pending' });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'RESPOND_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

// PUT /driver/stops/:stopId/status
exports.updateStopStatus = async (req, res) => {
  const driverId = getDriverId(req);
  const { stopId } = req.params;
  const { status } = req.body; // 'arrived', 'picked_up', 'delivered'

  if (!status || !['arrived', 'picked_up', 'delivered'].includes(status)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify stop belongs to an assignment of this driver
    const stop = await client.query(
      `SELECT ds.*, a.driver_id, a.status as assign_status
       FROM delivery_stops ds
       JOIN assignments a ON ds.assignment_id = a.id
       WHERE ds.id = $1 AND a.driver_id = $2
       FOR UPDATE`,
      [stopId, driverId]
    );
    if (stop.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: { code: 'STOP_NOT_FOUND_OR_NOT_YOURS' } });
    }

    const currentStop = stop.rows[0];
    const assignmentId = currentStop.assignment_id;

    // Validate status transition (optional, but we can trust the driver app)
    // If status is 'picked_up', previous status should be 'arrived'. We won't enforce for MVP.
    await client.query('UPDATE delivery_stops SET status = $1 WHERE id = $2', [status, stopId]);

    // If this stop is the first pickup and we're setting it to 'arrived' or 'picked_up',
    // move assignment from 'accepted' to 'in_progress' if not already.
    if (currentStop.assign_status === 'accepted' && (status === 'arrived' || status === 'picked_up')) {
      await client.query('UPDATE assignments SET status = $1 WHERE id = $2', ['in_progress', assignmentId]);
    }

    // Check if this is the last stop (max sequence) and status is 'delivered' (for a drop)
    const maxSeq = await client.query(
      'SELECT MAX(sequence) as max_seq FROM delivery_stops WHERE assignment_id = $1',
      [assignmentId]
    );
    const isLastStop = currentStop.sequence === maxSeq.rows[0].max_seq;

    if (isLastStop && currentStop.stop_type === 'drop' && status === 'delivered') {
      // Complete the assignment and all associated orders
      await client.query('UPDATE assignments SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', assignmentId]);

      // Set all orders in this assignment to 'delivered'
      const orderIds = await client.query(
        `SELECT DISTINCT oi.order_id
         FROM assignment_items ai
         JOIN order_items oi ON ai.order_item_id = oi.id
         WHERE ai.assignment_id = $1`,
        [assignmentId]
      );
      for (let row of orderIds.rows) {
        await client.query("UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id = $1", [row.order_id]);
      }

      // Increment driver total deliveries
      await client.query('UPDATE drivers SET total_deliveries = total_deliveries + 1 WHERE user_id = $1', [driverId]);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Stop status updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: { code: 'UPDATE_FAIL', message: err.message } });
  } finally {
    client.release();
  }
};

// POST /driver/location  (GPS ping)
exports.sendLocation = async (req, res) => {
  const driverId = getDriverId(req);
  const { lat, lng, assignmentId } = req.body;
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_COORDS' } });
  }
  try {
    await pool.query(
      'INSERT INTO driver_tracking_log (driver_id, assignment_id, lat, lng) VALUES ($1, $2, $3, $4)',
      [driverId, assignmentId || null, lat, lng]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'LOCATION_FAIL', message: err.message } });
  }
};

// GET /driver/earnings
exports.getEarnings = async (req, res) => {
  const driverId = getDriverId(req);
  const { period } = req.query; // today, week, month

  try {
    let dateFilter = '';
    if (period === 'today') {
      dateFilter = 'AND a.completed_at::date = CURRENT_DATE';
    } else if (period === 'week') {
      dateFilter = 'AND a.completed_at >= date_trunc(\'week\', CURRENT_DATE)';
    } else if (period === 'month') {
      dateFilter = 'AND a.completed_at >= date_trunc(\'month\', CURRENT_DATE)';
    }

    // Sum delivery fees from orders delivered by completed assignments
    const result = await pool.query(
      `SELECT COALESCE(SUM(o.delivery_fee), 0) as total_earnings,
              COUNT(DISTINCT a.id) as total_trips
       FROM assignments a
       JOIN assignment_items ai ON a.id = ai.assignment_id
       JOIN order_items oi ON ai.order_item_id = oi.id
       JOIN orders o ON oi.order_id = o.id
       WHERE a.driver_id = $1 AND a.status = 'completed'
       ${dateFilter}`,
      [driverId]
    );

    // Get detailed history for the period
    const history = await pool.query(
      `SELECT a.id as assignment_id, a.completed_at, SUM(o.delivery_fee) as earning,
              array_agg(DISTINCT o.id) as order_ids
       FROM assignments a
       JOIN assignment_items ai ON a.id = ai.assignment_id
       JOIN order_items oi ON ai.order_item_id = oi.id
       JOIN orders o ON oi.order_id = o.id
       WHERE a.driver_id = $1 AND a.status = 'completed'
       ${dateFilter}
       GROUP BY a.id, a.completed_at
       ORDER BY a.completed_at DESC`,
      [driverId]
    );

    res.json({
      success: true,
      data: {
        totalEarnings: parseFloat(result.rows[0].total_earnings),
        totalTrips: parseInt(result.rows[0].total_trips),
        history: history.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

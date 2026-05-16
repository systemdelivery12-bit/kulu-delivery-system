const pool = require('../db/pool');

const getDriverId = (req) => req.user.userId;
const getIO = (req) => req.app.get('io');

// ---------- TOGGLE ONLINE ----------
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

// ---------- GET ASSIGNMENTS ----------
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

    for (let asgn of assignments.rows) {
      const orderIdsRes = await pool.query(
        `SELECT DISTINCT oi.order_id
         FROM assignment_items ai
         JOIN order_items oi ON ai.order_item_id = oi.id
         WHERE ai.assignment_id = $1`,
        [asgn.id]
      );
      const orderIds = orderIdsRes.rows.map(r => r.order_id);
      asgn.orderIds = orderIds;

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

// ---------- RESPOND TO ASSIGNMENT ----------
exports.respondToAssignment = async (req, res) => {
  const driverId = getDriverId(req);
  const { id } = req.params;
  const { response } = req.body;

  if (!response || !['accept', 'reject'].includes(response)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_RESPONSE' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Assignment accepted' });
    } else {
      await client.query('UPDATE assignments SET status = $1 WHERE id = $2', ['rejected', id]);
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

// ---------- UPDATE STOP STATUS (with coin deduction) ----------
exports.updateStopStatus = async (req, res) => {
  const driverId = getDriverId(req);
  const { stopId } = req.params;
  const { status } = req.body;

  if (!status || !['arrived', 'picked_up', 'delivered'].includes(status)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    await client.query('UPDATE delivery_stops SET status = $1 WHERE id = $2', [status, stopId]);

    if (currentStop.assign_status === 'accepted' && (status === 'arrived' || status === 'picked_up')) {
      await client.query('UPDATE assignments SET status = $1 WHERE id = $2', ['in_progress', assignmentId]);
    }

    const maxSeq = await client.query('SELECT MAX(sequence) as max_seq FROM delivery_stops WHERE assignment_id = $1', [assignmentId]);
    const isLastStop = currentStop.sequence === maxSeq.rows[0].max_seq;

    if (isLastStop && currentStop.stop_type === 'drop' && status === 'delivered') {
      await client.query('UPDATE assignments SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', assignmentId]);
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
      await client.query('UPDATE drivers SET total_deliveries = total_deliveries + 1 WHERE user_id = $1', [driverId]);

      // ---- COIN DEDUCTION (17% commission) ----
      const commissionRate = await pool.query("SELECT commission_percent FROM delivery_fee_config LIMIT 1");
      const percent = parseFloat(commissionRate.rows[0]?.commission_percent || 17);

      const feeRes = await pool.query(
        `SELECT COALESCE(SUM(o.delivery_fee), 0) as total_fee
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         JOIN assignment_items ai ON oi.id = ai.order_item_id
         WHERE ai.assignment_id = $1`,
        [assignmentId]
      );
      const totalFee = parseFloat(feeRes.rows[0].total_fee);
      const deduction = Math.round((totalFee * percent) / 100 * 100) / 100;

      // Update wallet (allow negative once – driver will be blocked for future orders)
      await client.query(
        `INSERT INTO driver_wallets (driver_id, coin_balance) VALUES ($1, 0)
         ON CONFLICT (driver_id) DO UPDATE SET coin_balance = driver_wallets.coin_balance - $2, updated_at = NOW()`,
        [driverId, deduction]
      );

      const balRes = await client.query('SELECT coin_balance FROM driver_wallets WHERE driver_id = $1', [driverId]);
      const newBalance = balRes.rows[0].coin_balance;

      await client.query(
        'INSERT INTO coin_transactions (driver_id, type, amount, balance_after, reference_id, note) VALUES ($1, $2, $3, $4, $5, $6)',
        [driverId, 'deduction', -deduction, newBalance, assignmentId, `Commission ${percent}% on delivery fee ${totalFee}`]
      );
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

// ---------- SEND LOCATION ----------
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

    const io = getIO(req);
    let orderIds = [];
    if (assignmentId) {
      const orders = await pool.query(
        `SELECT DISTINCT oi.order_id
         FROM assignment_items ai
         JOIN order_items oi ON ai.order_item_id = oi.id
         WHERE ai.assignment_id = $1`,
        [assignmentId]
      );
      orderIds = orders.rows.map(r => r.order_id);
    }

    io.to('admin:all').emit('driver:locationUpdate', {
      driverId,
      lat,
      lng,
      assignmentId,
      timestamp: new Date()
    });

    orderIds.forEach(orderId => {
      io.to(`order:${orderId}`).emit('driver:locationUpdate', {
        driverId,
        lat,
        lng,
        assignmentId,
        timestamp: new Date()
      });
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'LOCATION_FAIL', message: err.message } });
  }
};

// ---------- EARNINGS ----------
exports.getEarnings = async (req, res) => {
  const driverId = getDriverId(req);
  const { period } = req.query;

  try {
    let dateFilter = '';
    if (period === 'today') {
      dateFilter = 'AND a.completed_at::date = CURRENT_DATE';
    } else if (period === 'week') {
      dateFilter = 'AND a.completed_at >= date_trunc(\'week\', CURRENT_DATE)';
    } else if (period === 'month') {
      dateFilter = 'AND a.completed_at >= date_trunc(\'month\', CURRENT_DATE)';
    }

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

// ========== WALLET & COIN PURCHASE ==========
exports.getWallet = async (req, res) => {
  const driverId = getDriverId(req);
  try {
    const wallet = await pool.query('SELECT * FROM driver_wallets WHERE driver_id = $1', [driverId]);
    const balance = wallet.rows.length ? wallet.rows[0].coin_balance : 0;
    const transactions = await pool.query(
      'SELECT * FROM coin_transactions WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 20',
      [driverId]
    );
    res.json({ success: true, data: { balance, transactions: transactions.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

exports.getAvailablePackages = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coin_packages WHERE is_active = true');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAIL', message: err.message } });
  }
};

exports.purchasePackage = async (req, res) => {
  const driverId = getDriverId(req);
  const packageId = parseInt(req.params.id);
  const { receiptImage } = req.body;

  if (!receiptImage) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_RECEIPT' } });
  }

  try {
    const pkg = await pool.query('SELECT * FROM coin_packages WHERE id = $1 AND is_active = true', [packageId]);
    if (pkg.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'PACKAGE_NOT_FOUND' } });
    }

    const request = await pool.query(
      `INSERT INTO coin_purchase_requests (driver_id, package_id, receipt_image, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [driverId, packageId, receiptImage]
    );
    res.status(201).json({ success: true, message: 'Purchase request submitted, waiting admin approval', requestId: request.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'PURCHASE_FAIL', message: err.message } });
  }
};

const pool = require('../db/pool');

const getDriverId = (req) => req.user.userId;
const getIO = (req) => req.app.get('io');

// ---------- existing functions unchanged (toggleOnline, getAssignments, respondToAssignment, updateStopStatus, sendLocation, getEarnings) ----------
// I'll rewrite updateStopStatus to include coin deduction.

// [... previous toggleOnline, getAssignments, respondToAssignment ... ]

// UPDATE STOP STATUS (with coin deduction)
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

      // ---- COIN DEDUCTION ----
      const commissionRate = await pool.query("SELECT commission_percent FROM delivery_fee_config LIMIT 1");
      const percent = parseFloat(commissionRate.rows[0]?.commission_percent || 17);

      // Calculate total delivery fee for this assignment
      const feeRes = await pool.query(
        `SELECT COALESCE(SUM(o.delivery_fee), 0) as total_fee
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         JOIN assignment_items ai ON oi.id = ai.order_item_id
         WHERE ai.assignment_id = $1`,
        [assignmentId]
      );
      const totalFee = parseFloat(feeRes.rows[0].total_fee);
      const deduction = Math.round((totalFee * percent) / 100 * 100) / 100; // round to 2 decimals

      // Update wallet (allow negative)
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

// Add the remaining driverController functions (toggleOnline, getAssignments, respondToAssignment, sendLocation, getEarnings) 
// unchanged, plus the new wallet functions below.

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
  const { receiptImage } = req.body; // driver uploads receipt (like payment verification)

  if (!receiptImage) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_RECEIPT' } });
  }

  try {
    // Check package exists
    const pkg = await pool.query('SELECT * FROM coin_packages WHERE id = $1 AND is_active = true', [packageId]);
    if (pkg.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'PACKAGE_NOT_FOUND' } });
    }

    // Create a coin purchase request (pending verification). For simplicity, we'll directly add coins
    // after admin verifies. We'll use the same payment_verifications table but that's for orders.
    // Better: store a pending purchase request.
    // We'll create a simple entry in coin_transactions with type 'purchase' but pending? 
    // Instead, let's mimic the manual flow: driver submits receipt, admin verifies later.
    // For now, we'll just insert the transaction as pending and admin has to manually approve via admin panel (we'll add a verification endpoint later).
    // For MVP, we can trust the driver and add coins immediately? No, you need admin verification.
    // I'll create a purchase_requests table, but that's more changes.
    // Workaround: Use a similar endpoint as payment verification: driver uploads proof, admin sees it in a list, then admin calls an endpoint to add coins.
    // We'll implement a simple pending purchases table.

    // For simplicity, I'll add a quick "purchase_requests" table or we can reuse coin_transactions with status.
    // I'll create a purchases table.
    // To avoid extra SQL, we'll store purchase request in coin_transactions with amount=0? Not clean.
    // I'll create a quick table: coin_purchase_requests.
    // We'll add that in the SQL and controller.

    // Let's include the purchase request logic here.
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

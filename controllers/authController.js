// controllers/authController.js
const pool = require('../db/pool');
const jwt = require('jsonwebtoken');
const { sendOTP, verifyOTP } = require('../utils/otpService');

// Helper: generate JWT
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, role: user.role, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
};

// POST /auth/request-otp
exports.requestOTP = async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_PHONE', message: 'Phone number required' } });
  }

  try {
    await sendOTP(phone);
    res.json({ success: true, message: 'OTP sent', expiresIn: 300 });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'OTP_FAILED', message: err.message } });
  }
};

// POST /auth/verify-otp
exports.verifyOTP = async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'Phone and OTP required' } });
  }

  const isValid = verifyOTP(phone, otp);
  if (!isValid) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_OTP', message: 'OTP is wrong or expired' } });
  }

  // Check if user exists
  const userQuery = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  let user = userQuery.rows[0];
  let isNew = false;

  if (!user) {
    // Create user with minimal data, role will be set later in register
    const newUser = await pool.query(
      `INSERT INTO users (phone, full_name, role) VALUES ($1, $2, 'customer') RETURNING *`,
      [phone, 'New User']
    );
    user = newUser.rows[0];
    isNew = true;
  }

  const token = generateToken(user);
  res.json({
    success: true,
    data: {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        fullName: user.full_name,
        isActive: user.is_active
      },
      isNew
    }
  });
};

// POST /auth/register (complete profile after OTP)
exports.register = async (req, res) => {
  const { fullName, defaultZoneId } = req.body;
  const userId = req.user.userId; // set by auth middleware

  try {
    await pool.query('UPDATE users SET full_name = $1 WHERE id = $2', [fullName, userId]);
    
    // Insert or update customer profile
    await pool.query(
      `INSERT INTO customers (user_id, default_zone_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET default_zone_id = $2`,
      [userId, defaultZoneId || null]
    );

    const updatedUser = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    res.json({ success: true, data: updatedUser.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'REGISTER_FAILED', message: err.message } });
  }
};

// POST /auth/register-driver (driver full registration, requires auth)
exports.registerDriver = async (req, res) => {
  const { fullName, vehicleType, idCardImage, vehicleImage, bankInfo } = req.body;
  const userId = req.user.userId;

  // Update role to driver (admin must approve)
  try {
    await pool.query('UPDATE users SET full_name = $1, role = $2 WHERE id = $3', [fullName, 'driver', userId]);

    await pool.query(
      `INSERT INTO drivers (user_id, vehicle_type, id_card_image, vehicle_image, bank_account_info, is_approved)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (user_id) DO UPDATE SET
         vehicle_type = $2,
         id_card_image = $3,
         vehicle_image = $4,
         bank_account_info = $5,
         is_approved = FALSE`,
      [userId, vehicleType, idCardImage, vehicleImage || null, bankInfo || null]
    );

    res.json({ success: true, message: 'Driver registration submitted for approval' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DRIVER_REG_FAILED', message: err.message } });
  }
};

// GET /auth/me
exports.getMe = async (req, res) => {
  const userId = req.user.userId;
  try {
    const user = await pool.query('SELECT id, phone, full_name, role, is_active FROM users WHERE id = $1', [userId]);
    if (!user.rows[0]) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND' } });
    }
    
    let profile = null;
    if (user.rows[0].role === 'customer') {
      const cust = await pool.query('SELECT * FROM customers WHERE user_id = $1', [userId]);
      profile = cust.rows[0];
    } else if (user.rows[0].role === 'driver') {
      const drv = await pool.query('SELECT * FROM drivers WHERE user_id = $1', [userId]);
      profile = drv.rows[0];
    }

    res.json({ success: true, data: { ...user.rows[0], profile } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'FETCH_FAILED', message: err.message } });
  }
};

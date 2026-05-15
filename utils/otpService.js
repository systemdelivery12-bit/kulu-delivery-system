// utils/otpService.js
const otpStore = new Map(); // phone -> { otp, expiresAt }

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
};

const sendOTP = async (phone) => {
  const otp = generateOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  otpStore.set(phone, { otp, expiresAt });

  // In production, send SMS via Africa's Talking here
  console.log(`📱 OTP for ${phone}: ${otp}`);

  return { success: true, expiresIn: 300 };
};

const verifyOTP = (phone, otp) => {
  const record = otpStore.get(phone);
  if (!record) return false;

  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return false;
  }

  if (record.otp === otp) {
    otpStore.delete(phone);
    return true;
  }

  return false;
};

module.exports = { sendOTP, verifyOTP };

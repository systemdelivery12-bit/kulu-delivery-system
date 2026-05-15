require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const pool = require('./db/pool'); // keep if you want, not used yet but we'll need later

const adminShopRoutes = require('./routes/adminShops');
const adminProductRoutes = require('./routes/adminProducts');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');

const authRoutes = require('./routes/authRoutes');
app.use('/api/v1/admin/shops', adminShopRoutes);
app.use('/api/v1/admin/products', adminProductRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);

const adminDashboardRoutes = require('./routes/adminDashboard');
// ...
app.use('/api/v1/admin/dashboard', adminDashboardRoutes);

const app = express();
const PORT = process.env.PORT || 3000;const driverRoutes = require('./routes/driver');
// ...
app.use('/api/v1/driver', driverRoutes);

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Routes
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'Kulu Delivery API is running!' });
});

app.use('/api/v1/auth', authRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});





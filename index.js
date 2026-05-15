require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const pool = require('./db/pool'); // keep if you want, not used yet but we'll need later

const authRoutes = require('./routes/authRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

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

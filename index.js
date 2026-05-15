require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: '*',  // restrict in production
    methods: ['GET', 'POST']
  }
});

// Make io accessible to controllers
app.set('io', io);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Import routes
const authRoutes = require('./routes/authRoutes');
const adminShopRoutes = require('./routes/adminShops');
const adminProductRoutes = require('./routes/adminProducts');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const adminDashboardRoutes = require('./routes/adminDashboard');
const driverRoutes = require('./routes/driver');

// Routes
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'Kulu Delivery API is running!' });
});
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin/shops', adminShopRoutes);
app.use('/api/v1/admin/products', adminProductRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/admin/dashboard', adminDashboardRoutes);
app.use('/api/v1/driver', driverRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
});

// Socket.io authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded; // { userId, role, phone }
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.userId} (${socket.user.role})`);

  // Driver joins a room for his own ID so we can track him
  if (socket.user.role === 'driver') {
    socket.join(`driver:${socket.user.userId}`);
  }

  // Customer can join a room for their order tracking
  socket.on('subscribe:order', (orderId) => {
    socket.join(`order:${orderId}`);
  });

  // Driver sends location
  socket.on('driver:location', (data) => {
    const { lat, lng, assignmentId } = data;
    // Broadcast to admin (all drivers map) – admin joins a special room
    socket.to('admin:all').emit('driver:locationUpdate', {
      driverId: socket.user.userId,
      lat,
      lng,
      assignmentId,
      timestamp: new Date()
    });
    // Also broadcast to customers tracking this driver's assignment
    // We need to know which order(s) are in this assignment.
    // For simplicity, we'll query the DB in a real app; for now we'll let the driver emit also the orderIds.
    // We'll store orderIds when the assignment is fetched. Let's add them in the event.
    if (data.orderIds) {
      data.orderIds.forEach(orderId => {
        socket.to(`order:${orderId}`).emit('driver:locationUpdate', {
          driverId: socket.user.userId,
          lat,
          lng,
          assignmentId,
          timestamp: new Date()
        });
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.userId}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

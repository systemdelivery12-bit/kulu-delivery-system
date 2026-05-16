require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: '*',
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

// Serve static files from 'public' folder (admin map, etc.)
app.use(express.static(path.join(__dirname, 'public')));

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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
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

  // Admin joins the all-drivers room
  if (socket.user.role === 'admin') {
    socket.join('admin:all');
  }

  // Driver joins his personal room (for future use)
  if (socket.user.role === 'driver') {
    socket.join(`driver:${socket.user.userId}`);
  }

  // Customer can subscribe to an order room
  socket.on('subscribe:order', (orderId) => {
    socket.join(`order:${orderId}`);
  });

  // Driver sends live location
  socket.on('driver:location', (data) => {
    const { lat, lng, assignmentId, orderIds } = data;
    // Broadcast to admin map
    socket.to('admin:all').emit('driver:locationUpdate', {
      driverId: socket.user.userId,
      lat,
      lng,
      assignmentId,
      timestamp: new Date()
    });

    // Broadcast to customers tracking those orders
    if (orderIds) {
      orderIds.forEach(orderId => {
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
  console.log(`Kulu Delivery server running on port ${PORT}`);
});

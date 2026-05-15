-- KULU DELIVERY - Complete Database Schema

-- Users base table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'driver', 'admin')),
    created_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Customers profile
CREATE TABLE customers (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    default_zone_id INTEGER,
    email VARCHAR(100),
    profile_image VARCHAR(255)
);

-- Drivers profile
CREATE TABLE drivers (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('walking', 'bicycle', 'motorcycle', 'car')),
    id_card_image VARCHAR(255),
    vehicle_image VARCHAR(255),
    bank_account_info TEXT,
    is_approved BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    max_orders INTEGER DEFAULT 3,
    rating DECIMAL(3,2) DEFAULT 5.00,
    total_deliveries INTEGER DEFAULT 0
);

-- Admins (just a marker)
CREATE TABLE admins (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    permissions JSONB
);

-- Delivery zones (your 34 zones)
CREATE TABLE zones (
    id SERIAL PRIMARY KEY,
    name_tig VARCHAR(100) NOT NULL,
    name_eng VARCHAR(100),
    coordinates POINT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Shops
CREATE TABLE shops (
    id SERIAL PRIMARY KEY,
    name_tig VARCHAR(100) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('restaurant','pharmacy','electronics','boutique','fresh_food','other')),
    zone_id INTEGER REFERENCES zones(id),
    phone VARCHAR(15),
    coordinates POINT,
    logo_image VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Product categories (optional but useful)
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name_tig VARCHAR(50) NOT NULL,
    icon VARCHAR(100)
);

-- Products
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) NOT NULL,
    name_tig VARCHAR(150) NOT NULL,
    description_tig TEXT,
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(255),
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(user_id) NOT NULL,
    delivery_zone_id INTEGER REFERENCES zones(id) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_payment'
        CHECK (status IN ('pending_payment','pending_assignment','assigned','in_progress','delivered','cancelled')),
    payment_method VARCHAR(30) NOT NULL CHECK (payment_method IN ('cod', 'telebirr', 'cbe_bank', 'mpesa', 'ebirr', 'other_wallet', 'other_bank')),
    payment_status VARCHAR(20) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending_verification', 'verified', 'failed')),
    item_total DECIMAL(10,2) NOT NULL,
    delivery_fee DECIMAL(10,2) NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Order items (per-product, includes shop_id for splitting)
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) NOT NULL,
    product_id INTEGER REFERENCES products(id) NOT NULL,
    shop_id INTEGER REFERENCES shops(id) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    item_total DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

-- Assignments (admin-to-driver)
CREATE TABLE assignments (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES drivers(user_id) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending_accept'
        CHECK (status IN ('pending_accept', 'accepted', 'rejected', 'in_progress', 'completed')),
    assigned_at TIMESTAMP DEFAULT NOW(),
    accepted_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- Which order items are in an assignment
CREATE TABLE assignment_items (
    assignment_id INTEGER REFERENCES assignments(id) NOT NULL,
    order_item_id INTEGER REFERENCES order_items(id) NOT NULL,
    PRIMARY KEY (assignment_id, order_item_id)
);

-- Route stops for each assignment (pickup / drop)
CREATE TABLE delivery_stops (
    id SERIAL PRIMARY KEY,
    assignment_id INTEGER REFERENCES assignments(id) NOT NULL,
    sequence INTEGER NOT NULL,
    stop_type VARCHAR(20) CHECK (stop_type IN ('pickup', 'drop')),
    location_type VARCHAR(20) CHECK (location_type IN ('shop', 'customer')),
    reference_id INTEGER,   -- shops.id or users.id (customer)
    coordinates POINT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'picked_up', 'delivered'))
);

-- GPS tracking log from drivers
CREATE TABLE driver_tracking_log (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES drivers(user_id) NOT NULL,
    assignment_id INTEGER REFERENCES assignments(id),
    lat DECIMAL(10,7) NOT NULL,
    lng DECIMAL(10,7) NOT NULL,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Payment verification (receipt uploads)
CREATE TABLE payment_verifications (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) NOT NULL,
    method VARCHAR(30) NOT NULL,
    proof_image VARCHAR(255) NOT NULL,
    verified_by INTEGER REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Ratings (customer <-> driver)
CREATE TABLE ratings (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) NOT NULL,
    rater_id INTEGER REFERENCES users(id) NOT NULL,
    rated_id INTEGER REFERENCES users(id) NOT NULL,
    score SMALLINT CHECK (score BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Delivery fee configuration (admin editable)
CREATE TABLE delivery_fee_config (
    id SERIAL PRIMARY KEY,
    distance_type VARCHAR(10) NOT NULL CHECK (distance_type IN ('short', 'medium', 'long')),
    minute_min INTEGER NOT NULL,
    minute_max INTEGER NOT NULL,
    base_fee DECIMAL(10,2) NOT NULL,
    rate_per_minute DECIMAL(10,2) NOT NULL,
    vehicle_multiplier JSONB DEFAULT '{"walking":0.6,"bicycle":0.8,"motorcycle":1.0,"car":1.3}',
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Seed default fee configuration
INSERT INTO delivery_fee_config (distance_type, minute_min, minute_max, base_fee, rate_per_minute) VALUES
('short', 0, 10, 130.00, 2.00),
('medium', 11, 20, 160.00, 2.00),
('long', 21, 30, 200.00, 2.00);

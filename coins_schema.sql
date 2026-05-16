-- Driver coin wallet
CREATE TABLE driver_wallets (
    driver_id INTEGER PRIMARY KEY REFERENCES drivers(user_id),
    coin_balance DECIMAL(10,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Seed wallets for existing drivers
INSERT INTO driver_wallets (driver_id, coin_balance)
SELECT user_id, 0 FROM drivers
ON CONFLICT (driver_id) DO NOTHING;

-- Coin packages
CREATE TABLE coin_packages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    coins DECIMAL(10,2) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE coin_purchase_requests (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES drivers(user_id),
    package_id INTEGER REFERENCES coin_packages(id),
    receipt_image VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP
);
-- Coin transactions (purchases, deductions, bonuses)
CREATE TABLE coin_transactions (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES drivers(user_id),
    type VARCHAR(20) CHECK (type IN ('purchase', 'deduction', 'bonus')),
    amount DECIMAL(10,2) NOT NULL,
    balance_after DECIMAL(10,2) NOT NULL,
    reference_id INTEGER,
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Add commission rate to delivery fee config (default 17%)
ALTER TABLE delivery_fee_config ADD COLUMN IF NOT EXISTS commission_percent DECIMAL(5,2) DEFAULT 17.00;

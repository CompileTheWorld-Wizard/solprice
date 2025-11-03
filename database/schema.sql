-- Create solPrice table
CREATE TABLE IF NOT EXISTS solPrice (
    id SERIAL PRIMARY KEY,
    price DECIMAL(20, 8) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on created_at for faster queries
CREATE INDEX IF NOT EXISTS idx_solPrice_created_at ON solPrice(created_at);


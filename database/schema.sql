-- Drop the solprice table if it exists
DROP TABLE IF EXISTS solprice;

-- Create solprice table to store latest prices for multiple tokens
-- Only stores essential data: price, price_usd, block_time
CREATE TABLE IF NOT EXISTS solprice (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(255) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    price_usd DECIMAL(20, 8) NOT NULL,
    block_time TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mint_address)
);

-- Create index on mint_address for faster lookups
CREATE INDEX IF NOT EXISTS idx_solprice_mint_address ON solprice(mint_address);

-- Create index on block_time for faster queries
CREATE INDEX IF NOT EXISTS idx_solprice_block_time ON solprice(block_time);


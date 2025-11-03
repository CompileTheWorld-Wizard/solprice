import axios from 'axios';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate environment variables
const requiredEnvVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Create PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// API URL for SOL price
const SOL_PRICE_API_URL = 'https://api-v3.raydium.io/mint/price?mints=So11111111111111111111111111111111111111112';

interface SolPriceResponse {
  id: string;
  success: boolean;
  data: {
    [mint: string]: string;
  };
}

/**
 * Fetches SOL price from Raydium API
 */
async function getSolPrice(): Promise<number | null> {
  try {
    const response = await axios.get<SolPriceResponse>(SOL_PRICE_API_URL);
    
    if (response.data.success && response.data.data) {
      const mintAddress = 'So11111111111111111111111111111111111111112';
      const price = response.data.data[mintAddress];
      
      if (price) {
        return parseFloat(price);
      }
    }
    
    console.error('Failed to get SOL price from API response');
    return null;
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return null;
  }
}

/**
 * Saves SOL price to PostgreSQL database
 * Replaces existing price to keep only one record
 */
async function saveSolPrice(price: number): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Delete all existing records to keep only one
    await client.query('DELETE FROM solPrice');
    
    // Insert the new price
    await client.query(
      'INSERT INTO solPrice (price, created_at) VALUES ($1, NOW())',
      [price]
    );
    console.log(`✓ SOL price updated: $${price.toFixed(2)} at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Error saving SOL price to database:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main function to fetch and save SOL price
 */
async function fetchAndSaveSolPrice(): Promise<void> {
  try {
    console.log('Fetching SOL price...');
    const price = await getSolPrice();
    
    if (price !== null) {
      await saveSolPrice(price);
    } else {
      console.error('Failed to fetch SOL price, skipping database save');
    }
  } catch (error) {
    console.error('Error in fetchAndSaveSolPrice:', error);
  }
}

/**
 * Test database connection
 */
async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('✓ Database connection successful');
    return true;
  } catch (error) {
    console.error('✗ Database connection failed:', error);
    return false;
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('Starting SOL Price Fetcher...\n');
  
  // Test database connection
  const isConnected = await testConnection();
  if (!isConnected) {
    console.error('Cannot proceed without database connection. Please check your .env file.');
    process.exit(1);
  }
  
  // Fetch and save price immediately
  await fetchAndSaveSolPrice();
  
  // Set up interval to fetch price every 60 seconds (adjust as needed)
  const intervalSeconds = 1;
  console.log(`\nFetching SOL price every ${intervalSeconds} seconds...\n`);
  
  setInterval(async () => {
    await fetchAndSaveSolPrice();
  }, intervalSeconds * 1000);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});

// Start the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});


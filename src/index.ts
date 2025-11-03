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

// Create PostgreSQL connection pool with retry configuration
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Connection pool settings for better reliability
  max: 10, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2,
};

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  operationName: string,
  maxRetries: number = RETRY_CONFIG.maxRetries,
  initialDelay: number = RETRY_CONFIG.initialDelay
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        throw lastError;
      }
      
      // Calculate delay with exponential backoff
      const delay = Math.min(
        initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt),
        RETRY_CONFIG.maxDelay
      );
      
      console.warn(
        `${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`
      );
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Retry failed');
}

/**
 * Get a client from the pool with retry logic
 */
async function getClientWithRetry() {
  return retryWithBackoff(
    async () => {
      const client = await pool.connect();
      return client;
    },
    'Database connection'
  );
}

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
 * Includes retry logic for connection failures
 */
async function saveSolPrice(price: number): Promise<void> {
  return retryWithBackoff(async () => {
    const client = await getClientWithRetry();
    
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
  }, 'Save SOL price');
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
 * Test database connection with retry logic
 */
async function testConnection(): Promise<boolean> {
  try {
    const client = await getClientWithRetry();
    try {
      await client.query('SELECT NOW()');
      console.log('✓ Database connection successful');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('✗ Database connection failed after retries:', error);
    return false;
  }
}

/**
 * Initialize database schema - creates table and index if they don't exist
 */
async function initializeSchema(): Promise<void> {
  return retryWithBackoff(async () => {
    const client = await getClientWithRetry();
    
    try {
      // Create solPrice table if it doesn't exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS solPrice (
          id SERIAL PRIMARY KEY,
          price DECIMAL(20, 8) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Create index on created_at if it doesn't exist
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_solPrice_created_at ON solPrice(created_at)
      `);
      
      console.log('✓ Database schema initialized');
    } catch (error) {
      console.error('Error initializing database schema:', error);
      throw error;
    } finally {
      client.release();
    }
  }, 'Initialize database schema');
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
  
  // Initialize database schema (create table if not exists)
  await initializeSchema();
  
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


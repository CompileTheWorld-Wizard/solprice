import { Pool } from 'pg';
import { createClient } from 'redis';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

// Validate environment variables
const requiredEnvVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'BITQUERY_TOKEN'];
const optionalEnvVars = ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Create PostgreSQL connection pool with optimized settings for high throughput
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20, // Increased pool size for parallel operations
  min: 5, // Keep minimum connections ready
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // Reduced timeout for faster failure detection
  allowExitOnIdle: false, // Keep connections alive
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected pool error:', err);
});

// Redis client
let redisClient: ReturnType<typeof createClient> | null = null;

// Initialize Redis client
async function initializeRedis() {
  try {
    const redisUrl = process.env.REDIS_URL ||
      `redis://${process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ''}${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;

    redisClient = createClient({ url: redisUrl });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    await redisClient.connect();
    console.log('✓ Redis connection successful');
  } catch (error) {
    console.warn('⚠ Redis connection failed, continuing without Redis:', error);
    redisClient = null;
  }
}

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelay: 1000,
  maxDelay: 30000,
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

      if (attempt === maxRetries) {
        throw lastError;
      }

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
 * Get a client from the pool (optimized - no retry for speed)
 */
async function getClientFromPool() {
  return pool.connect();
}

// Bitquery WebSocket configuration
const BITQUERY_WS_URL = `wss://streaming.bitquery.io/graphql?token=${process.env.BITQUERY_TOKEN}`;
const GRAPHQL_SUBSCRIPTION_ID = "1";
const INACTIVITY_TIMEOUT_MS = 5000;
const REDIS_TTL_SECONDS = 300; // 5 minutes

// GraphQL subscription query for Solana trades
const subscriptionQuery = `
subscription LatestTrades {
  Solana {
    DEXTradeByTokens(
      where: {
        Trade: {
          Currency: {
            MintAddress: {
              in: [
                "So11111111111111111111111111111111111111112",
                "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
              ]
            },
          },
          AmountInUSD: { gt: "10" },
          PriceInUSD: { gt: 0 }
        },
        Transaction: { Result: { Success: true } }
      }
    ) {
      Block {
        allTime: Time
      }
      Transaction {
        Signature
      }
      Trade {
        Amount
        AmountInUSD
        Price
        PriceInUSD
        Currency {
          Name
          Symbol
          MintAddress
        }
        Market {
          MarketAddress
        }
        Dex {
          ProtocolName
          ProtocolFamily
        }
        Side {
          Type
          Currency {
            Symbol
            MintAddress
            Name
          }
          AmountInUSD
          Amount
        }
      }
    }
  }
}
`;

// Types for Bitquery response
interface TradeData {
  Block: {
    allTime: string;
  };
  Transaction: {
    Signature: string;
  };
  Trade: {
    Amount: string;
    AmountInUSD: string;
    Price: number;
    PriceInUSD: number;
    Currency: {
      Name: string;
      Symbol: string;
      MintAddress: string;
    };
    Market: {
      MarketAddress: string;
    };
    Dex: {
      ProtocolName: string;
      ProtocolFamily: string;
    };
    Side: {
      Type: string;
      Currency: {
        Symbol: string;
        MintAddress: string;
        Name: string;
      };
      AmountInUSD: string;
      Amount: string;
    };
  };
}

interface BitqueryResponse {
  type: string;
  id?: string;
  payload?: {
    data?: {
      Solana?: {
        DEXTradeByTokens?: TradeData[];
      };
    };
    errors?: any[];
  };
}

// WebSocket connection state
let bitqueryConnection: WebSocket | null = null;
let isReconnecting = false;
let lastMessageTime = Date.now();
let inactivityInterval: NodeJS.Timeout | null = null;
let redisCleanupInterval: NodeJS.Timeout | null = null;
let postgresBatchInterval: NodeJS.Timeout | null = null;

// Buffer for batching PostgreSQL writes (saves every 1 second)
interface PriceBufferItem {
  mintAddress: string;
  price: number;
  priceUsd: number;
  blockTime: Date;
}
const postgresBuffer = new Map<string, PriceBufferItem>(); // Key: mintAddress, Value: latest price data

/**
 * Clean up old entries from Redis (older than 5 minutes)
 * Can be called periodically or on each write
 */
async function cleanupOldRedisData(mintAddress?: string): Promise<void> {
  if (!redisClient) return;

  try {
    const now = Date.now();
    const fiveMinutesAgo = now - (REDIS_TTL_SECONDS * 1000);

    if (mintAddress) {
      // Clean up specific token
      const timeseriesKey = `price:timeseries:${mintAddress}`;
      const removed = await redisClient.zRemRangeByScore(timeseriesKey, '-inf', fiveMinutesAgo.toString());
      if (removed > 0) {
        console.log(`Cleaned up ${removed} old entries for ${mintAddress}`);
      }
    } else {
      // Clean up all tokens - scan for all price:timeseries:* keys
      const pattern = 'price:timeseries:*';
      let cursor = '0';
      let cleanedCount = 0;
      
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: pattern,
          COUNT: 100,
        });
        cursor = result.cursor;
        
        for (const key of result.keys) {
          const removed = await redisClient.zRemRangeByScore(key, '-inf', fiveMinutesAgo.toString());
          if (removed > 0) {
            cleanedCount += removed;
          }
        }
      } while (cursor !== '0');
      
      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} old entries across all tokens`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old Redis data:', error);
  }
}

/**
 * Store price data in Redis as time series (5 minutes retention)
 * Uses sorted set to store time series data with timestamp as score
 * Only stores: price, price_usd, block_time
 */
async function storePriceInRedis(
  mintAddress: string,
  priceData: {
    price: number;
    priceUsd: number;
    blockTime: Date;
  }
): Promise<void> {
  if (!redisClient) return;

  try {
    const timeseriesKey = `price:timeseries:${mintAddress}`;
    const timestamp = priceData.blockTime.getTime();
    const now = Date.now();
    const fiveMinutesAgo = now - (REDIS_TTL_SECONDS * 1000);
    
    // Only store essential data: price, price_usd, block_time
    const value = JSON.stringify({
      price: priceData.price,
      price_usd: priceData.priceUsd,
      block_time: priceData.blockTime.toISOString(),
    });

    // Add to sorted set with timestamp as score
    // Using zAdd with member and score (redis v4+ API)
    await redisClient.zAdd(timeseriesKey, {
      score: timestamp,
      value: value,
    });

    // Remove entries older than 5 minutes based on current time
    // This ensures we keep only the last 5 minutes of data
    const removed = await redisClient.zRemRangeByScore(timeseriesKey, '-inf', fiveMinutesAgo.toString());

    // Set expiration on the sorted set key (6 minutes to ensure cleanup if no writes occur)
    await redisClient.expire(timeseriesKey, REDIS_TTL_SECONDS + 60);
  } catch (error) {
    console.error('Error storing price in Redis:', error);
  }
}

/**
 * Store latest prices in batch (optimized for multiple trades)
 * Uses a single database transaction for all trades
 */
async function storeLatestPricesBatch(trades: PriceBufferItem[]): Promise<void> {
  if (trades.length === 0) return;

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Prepare batch insert/update using VALUES clause for better performance
    const values: any[] = [];
    const placeholders: string[] = [];
    
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const baseIndex = i * 4;
      placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, NOW())`);
      values.push(trade.mintAddress, trade.price, trade.priceUsd, trade.blockTime);
    }
    
    // Single query for all trades - much faster than individual queries
    await client.query(
      `INSERT INTO solprice (mint_address, price, price_usd, block_time, created_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (mint_address) 
       DO UPDATE SET
         price = EXCLUDED.price,
         price_usd = EXCLUDED.price_usd,
         block_time = EXCLUDED.block_time,
         created_at = NOW()`,
      values
    );
    
    await client.query('COMMIT');
    
    // Store in Redis in parallel (non-blocking)
    Promise.all(
      trades.map(trade => 
        storePriceInRedis(trade.mintAddress, {
          price: trade.price,
          priceUsd: trade.priceUsd,
          blockTime: trade.blockTime,
        }).catch(err => {
          // Redis errors don't fail the batch
          console.error(`Redis error for ${trade.mintAddress}:`, err);
        })
      )
    ).catch(() => {
      // Ignore Redis batch errors
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error storing prices in batch:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Flush buffered prices to PostgreSQL (called every 1 second)
 */
async function flushPostgresBuffer(): Promise<void> {
  if (postgresBuffer.size === 0) return;

  // Get all buffered prices
  const trades = Array.from(postgresBuffer.values());
  const count = trades.length;
  
  // Clear the buffer before processing (in case new data arrives during processing)
  postgresBuffer.clear();
  
  try {
    const startTime = Date.now();
    await storeLatestPricesBatch(trades);
    const duration = Date.now() - startTime;
    console.log(`✓ Flushed ${count} price(s) to PostgreSQL in ${duration}ms`);
  } catch (error) {
    console.error(`✗ Failed to flush ${count} price(s) to PostgreSQL:`, error);
    // Re-add failed trades back to buffer for retry (optional - could cause duplicates)
    // For now, we'll just log the error and continue
  }
}

/**
 * Store latest price in PostgreSQL database (single trade - fallback)
 * Optimized to run PostgreSQL and Redis operations in parallel
 */
async function storeLatestPrice(trade: TradeData): Promise<void> {
  // Pre-compute values once
  const {
    Trade: {
      Currency,
      Price,
      PriceInUSD,
    },
    Block,
  } = trade;

  const price = typeof Price === 'number' ? Price : parseFloat(String(Price));
  const priceUsd = typeof PriceInUSD === 'number' ? PriceInUSD : parseFloat(String(PriceInUSD));
  const blockTime = Block.allTime ? new Date(Block.allTime) : new Date();
  const mintAddress = Currency.MintAddress;

  const client = await pool.connect();

  try {
    // Run PostgreSQL and Redis operations in parallel for better performance
    await Promise.all([
      // PostgreSQL upsert
      client.query(
        `INSERT INTO solprice (
          mint_address, price, price_usd, block_time, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (mint_address) 
        DO UPDATE SET
          price = EXCLUDED.price,
          price_usd = EXCLUDED.price_usd,
          block_time = EXCLUDED.block_time,
          created_at = NOW()`,
        [mintAddress, price, priceUsd, blockTime]
      ),
      // Redis time series (non-blocking, errors are handled internally)
      storePriceInRedis(mintAddress, {
        price,
        priceUsd,
        blockTime,
      }),
    ]);
  } catch (error) {
    console.error('Error storing price in database:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Process trade data from Bitquery
 * Only processes the latest trade per token per block (last occurrence in array)
 * Optimized with parallel processing and minimal logging
 */
async function processTradeData(trades: TradeData[], receiveTime: number): Promise<void> {
  const processStartTime = Date.now();
  const totalTrades = trades.length;
  
  if (totalTrades === 0) return;
  
  // Group trades by mint_address and block_time, keeping only the last occurrence
  // Single pass through array - O(n) complexity
  const latestTradesMap = new Map<string, TradeData>();
  
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const mintAddress = trade.Trade.Currency.MintAddress;
    const blockTime = trade.Block.allTime || '';
    
    // Create a unique key for token + block
    const key = `${mintAddress}:${blockTime}`;
    
    // Keep only the last trade for each token/block combination
    latestTradesMap.set(key, trade);
  }
  
  const uniqueTrades = Array.from(latestTradesMap.values());
  const filteredCount = totalTrades - uniqueTrades.length;
  
  // Pre-process all trade data and add to buffer (saves every 1 second)
  const processedCount = uniqueTrades.length;
  
  for (const trade of uniqueTrades) {
    const {
      Trade: {
        Currency,
        Price,
        PriceInUSD,
      },
      Block,
    } = trade;
    
    const priceData: PriceBufferItem = {
      mintAddress: Currency.MintAddress,
      price: typeof Price === 'number' ? Price : parseFloat(String(Price)),
      priceUsd: typeof PriceInUSD === 'number' ? PriceInUSD : parseFloat(String(PriceInUSD)),
      blockTime: Block.allTime ? new Date(Block.allTime) : new Date(),
    };
    
    // Add to buffer (only latest price per mint_address is kept)
    // Store in Redis immediately (real-time for Redis)
    postgresBuffer.set(priceData.mintAddress, priceData);
    
    // Store in Redis immediately (non-blocking)
    storePriceInRedis(priceData.mintAddress, {
      price: priceData.price,
      priceUsd: priceData.priceUsd,
      blockTime: priceData.blockTime,
    }).catch(err => {
      console.error(`Redis error for ${priceData.mintAddress}:`, err);
    });
  }
  
  const processEndTime = Date.now();
  const totalDuration = processEndTime - receiveTime;
  const processingDuration = processEndTime - processStartTime;
  
  // Single summary log
  console.log(
    `✓ Buffered ${processedCount} trade(s)` +
    (filteredCount > 0 ? ` (filtered ${filteredCount} duplicates)` : '') +
    ` in ${processingDuration}ms (total: ${totalDuration}ms from receive) - Buffer size: ${postgresBuffer.size}`
  );
}

/**
 * Send subscription to Bitquery
 */
function sendSubscription(): void {
  if (!bitqueryConnection || bitqueryConnection.readyState !== WebSocket.OPEN) {
    console.warn('Cannot send subscription, socket not open.');
    return;
  }

  const subscriptionMessage = {
    type: 'start',
    id: GRAPHQL_SUBSCRIPTION_ID,
    payload: { query: subscriptionQuery },
  };

  bitqueryConnection.send(JSON.stringify(subscriptionMessage));
  console.log('Subscription message sent.');
}

/**
 * Start inactivity timer
 */
function startInactivityTimer(): void {
  if (inactivityInterval) {
    clearInterval(inactivityInterval);
  }

  inactivityInterval = setInterval(() => {
    if (Date.now() - lastMessageTime > INACTIVITY_TIMEOUT_MS) {
      console.warn('No message received for 5s. Closing and reconnecting...');
      reconnect();
    }
  }, 5000);
}

/**
 * Reconnect to Bitquery WebSocket
 */
function reconnect(): void {
  if (isReconnecting) return;

  isReconnecting = true;

  if (inactivityInterval) {
    clearInterval(inactivityInterval);
    inactivityInterval = null;
  }

  if (bitqueryConnection) {
    try {
      if (bitqueryConnection.readyState === WebSocket.OPEN) {
        const completeMessage = {
          type: 'complete',
          id: GRAPHQL_SUBSCRIPTION_ID,
        };
        bitqueryConnection.send(JSON.stringify(completeMessage));
        console.log('Complete message sent before reconnection.');
      }
      bitqueryConnection.close(1000, 'Reconnecting due to inactivity');
    } catch (e) {
      console.error('Error closing connection:', e);
    }
  }

  console.warn('Reconnecting in 3 seconds...');
  setTimeout(() => {
    isReconnecting = false;
    connectToBitquery();
  }, 3000);
}

/**
 * Connect to Bitquery WebSocket
 */
function connectToBitquery(): void {
  console.log('Connecting to Bitquery...');

  bitqueryConnection = new WebSocket(BITQUERY_WS_URL, ['graphql-ws']);

  bitqueryConnection.on('open', () => {
    console.log('Connected to Bitquery WebSocket', bitqueryConnection?.readyState);
    bitqueryConnection?.send(JSON.stringify({ type: 'connection_init' }));
    lastMessageTime = Date.now();
    startInactivityTimer();
  });

  bitqueryConnection.on('message', (data: WebSocket.Data) => {
    lastMessageTime = Date.now();
    let response: BitqueryResponse;

    try {
      response = JSON.parse(data.toString());
    } catch (err) {
      console.error('Invalid JSON from server:', data);
      return;
    }

    switch (response.type) {
      case 'connection_ack':
        console.log('Connection acknowledged.');
        sendSubscription();
        break;

      case 'data':
        console.log('Received trade data');
        if (response.payload?.data?.Solana?.DEXTradeByTokens) {
          const trades = response.payload.data.Solana.DEXTradeByTokens;
          const receiveTime = Date.now();
          // Process asynchronously to avoid blocking
          setImmediate(() => processTradeData(trades, receiveTime));
        }
        break;

      case 'ka':
        console.log('Keep-alive received.');
        break;

      case 'error':
        console.log('Error from server:', response);
        console.error('Error from server:', response.payload?.errors);
        break;

      default:
        console.warn('Unknown message type:', response);
    }
  });

  bitqueryConnection.on('close', () => {
    console.warn('WebSocket closed. Reconnecting...');
    reconnect();
  });

  bitqueryConnection.on('error', (error: Error) => {
    console.error('WebSocket error:', error.message);
    reconnect();
  });
}

/**
 * Test database connection with retry logic
 */
async function testConnection(): Promise<boolean> {
  return retryWithBackoff(async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT NOW()');
      console.log('✓ Database connection successful');
      return true;
    } finally {
      client.release();
    }
  }, 'Database connection test').catch((error) => {
    console.error('✗ Database connection failed after retries:', error);
    return false;
  });
}

/**
 * Initialize database schema - creates table and index if they don't exist
 */
async function initializeSchema(): Promise<void> {
  return retryWithBackoff(async () => {
    const client = await pool.connect();

    try {
      // Create solprice table if it doesn't exist
      // Only stores essential data: price, price_usd, block_time
      await client.query(`
        CREATE TABLE IF NOT EXISTS solprice (
          id SERIAL PRIMARY KEY,
          mint_address VARCHAR(255) NOT NULL,
          price DECIMAL(20, 8) NOT NULL,
          price_usd DECIMAL(20, 8) NOT NULL,
          block_time TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(mint_address)
        )
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_solprice_mint_address ON solprice(mint_address)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_solprice_block_time ON solprice(block_time)
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
  console.log('Starting Bitquery Price Fetcher...\n');

  // Test database connection
  const isConnected = await testConnection();
  if (!isConnected) {
    console.error('Cannot proceed without database connection. Please check your .env file.');
    process.exit(1);
  }

  // Initialize Redis
  await initializeRedis();

  // Initialize database schema
  await initializeSchema();

  // Start periodic Redis cleanup (every 1 minute) to ensure old data is removed
  if (redisClient) {
    redisCleanupInterval = setInterval(() => {
      cleanupOldRedisData().catch(err => {
        console.error('Error in periodic Redis cleanup:', err);
      });
    }, 60000); // Run every 60 seconds
    console.log('✓ Periodic Redis cleanup started (every 60 seconds)');
  }

  // Start periodic PostgreSQL batch flush (every 1 second)
  postgresBatchInterval = setInterval(() => {
    flushPostgresBuffer().catch(err => {
      console.error('Error flushing PostgreSQL buffer:', err);
    });
  }, 1000); // Run every 1 second
  console.log('✓ PostgreSQL batch flush started (every 1 second)');

  // Connect to Bitquery WebSocket
  connectToBitquery();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  if (inactivityInterval) {
    clearInterval(inactivityInterval);
  }

  if (redisCleanupInterval) {
    clearInterval(redisCleanupInterval);
  }

  if (postgresBatchInterval) {
    clearInterval(postgresBatchInterval);
    // Flush any remaining buffered data before shutdown
    await flushPostgresBuffer().catch(err => {
      console.error('Error flushing buffer on shutdown:', err);
    });
  }

  if (bitqueryConnection) {
    try {
      if (bitqueryConnection.readyState === WebSocket.OPEN) {
        const completeMessage = {
          type: 'complete',
          id: GRAPHQL_SUBSCRIPTION_ID,
        };
        bitqueryConnection.send(JSON.stringify(completeMessage));
      }
      bitqueryConnection.close();
    } catch (e) {
      console.error('Error closing WebSocket:', e);
    }
  }

  if (redisClient) {
    await redisClient.quit();
  }

  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');

  if (inactivityInterval) {
    clearInterval(inactivityInterval);
  }

  if (redisCleanupInterval) {
    clearInterval(redisCleanupInterval);
  }

  if (postgresBatchInterval) {
    clearInterval(postgresBatchInterval);
    // Flush any remaining buffered data before shutdown
    await flushPostgresBuffer().catch(err => {
      console.error('Error flushing buffer on shutdown:', err);
    });
  }

  if (bitqueryConnection) {
    try {
      if (bitqueryConnection.readyState === WebSocket.OPEN) {
        const completeMessage = {
          type: 'complete',
          id: GRAPHQL_SUBSCRIPTION_ID,
        };
        bitqueryConnection.send(JSON.stringify(completeMessage));
      }
      bitqueryConnection.close();
    } catch (e) {
      console.error('Error closing WebSocket:', e);
    }
  }

  if (redisClient) {
    await redisClient.quit();
  }

  await pool.end();
  process.exit(0);
});

// Start the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

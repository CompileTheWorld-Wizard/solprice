# SOL Price Fetcher

A TypeScript project that fetches real-time SOL (Solana) price from Raydium API and saves it to a PostgreSQL database.

## Features

- Fetches SOL price in real-time from Raydium API
- Saves price data to PostgreSQL database
- Runs continuously with configurable interval (default: 60 seconds)
- Environment-based configuration

## Prerequisites

- Node.js (v18 or higher)
- PostgreSQL database
- npm or yarn

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file** in the root directory with your PostgreSQL credentials:
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=your_database_name
   DB_USER=your_database_user
   DB_PASSWORD=your_database_password
   ```

3. **Create the database table:**
   Run the SQL script in `database/schema.sql` on your PostgreSQL database:
   ```bash
   psql -U your_database_user -d your_database_name -f database/schema.sql
   ```
   
   Or manually execute:
   ```sql
   CREATE TABLE IF NOT EXISTS solPrice (
       id SERIAL PRIMARY KEY,
       price DECIMAL(20, 8) NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
   
   CREATE INDEX IF NOT EXISTS idx_solPrice_created_at ON solPrice(created_at);
   ```

4. **Build the project:**
   ```bash
   npm run build
   ```

5. **Run the application:**
   ```bash
   npm start
   ```

   Or for development mode with auto-reload:
   ```bash
   npm run dev
   ```

## Project Structure

```
.
├── src/
│   └── index.ts          # Main application file
├── database/
│   └── schema.sql        # Database schema
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

1. The application connects to PostgreSQL using credentials from `.env`
2. It fetches SOL price from the Raydium API endpoint
3. Saves the price to the `solPrice` table with a timestamp
4. Repeats every 60 seconds

## API Endpoint

The project uses the Raydium API:
```
https://api-v3.raydium.io/mint/price?mints=So11111111111111111111111111111111111111112
```

## Database Schema

The `solPrice` table has the following structure:
- `id`: Auto-incrementing primary key
- `price`: SOL price (DECIMAL with 8 decimal places)
- `created_at`: Timestamp of when the price was saved

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DB_HOST` | PostgreSQL host address | Yes |
| `DB_PORT` | PostgreSQL port | Yes |
| `DB_NAME` | Database name | Yes |
| `DB_USER` | Database username | Yes |
| `DB_PASSWORD` | Database password | Yes |

## License

ISC


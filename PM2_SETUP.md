# PM2 Setup Guide for SOL Price Fetcher

This guide explains how to run the SOL Price Fetcher application in the background using PM2 on Ubuntu.

## Prerequisites

1. Node.js installed (v18 or higher)
2. PostgreSQL database running
3. Project dependencies installed (`npm install`)
4. `.env` file configured with database credentials

## Installation Steps

### 1. Install PM2 Globally

```bash
npm install -g pm2
```

### 2. Build the Project

Make sure your TypeScript code is compiled:

```bash
npm run build
```

### 3. Create Logs Directory (Optional)

The PM2 config creates logs in a `logs` directory. Create it if it doesn't exist:

```bash
mkdir -p logs
```

### 4. Start the Application with PM2

#### Option A: Using the Ecosystem File (Recommended)

```bash
pm2 start ecosystem.config.js
```

#### Option B: Direct Command

```bash
pm2 start dist/index.js --name sol-price-fetcher
```

### 5. Save PM2 Configuration

Save the current PM2 process list so it restarts on system reboot:

```bash
pm2 save
pm2 startup
```

The `pm2 startup` command will output a command that you need to run with sudo. Copy and run that command.

## Common PM2 Commands

### View Running Processes

```bash
pm2 list
```

### View Application Logs

```bash
# Real-time logs
pm2 logs sol-price-fetcher

# Last 100 lines
pm2 logs sol-price-fetcher --lines 100

# View only error logs
pm2 logs sol-price-fetcher --err

# View only output logs
pm2 logs sol-price-fetcher --out
```

### Monitor Application

```bash
pm2 monit
```

### Stop Application

```bash
pm2 stop sol-price-fetcher
```

### Restart Application

```bash
pm2 restart sol-price-fetcher
```

### Reload Application (Zero Downtime)

```bash
pm2 reload sol-price-fetcher
```

### Delete Application from PM2

```bash
pm2 delete sol-price-fetcher
```

### View Application Information

```bash
pm2 info sol-price-fetcher
```

### View Application Statistics

```bash
pm2 status
```

## Updating the Application

When you make changes to the code:

1. **Build the new code:**
   ```bash
   npm run build
   ```

2. **Restart the PM2 process:**
   ```bash
   pm2 restart sol-price-fetcher
   ```

   Or use reload for zero downtime:
   ```bash
   pm2 reload sol-price-fetcher
   ```

## Logs Location

Logs are stored in the `logs/` directory:
- `logs/pm2-error.log` - Error logs
- `logs/pm2-out.log` - Output logs
- `logs/pm2-combined.log` - Combined logs

You can also view logs in real-time:
```bash
tail -f logs/pm2-combined.log
```

## Auto-Start on System Reboot

After running `pm2 save` and `pm2 startup`, your application will automatically start when the server reboots.

## Troubleshooting

### Check if PM2 is running

```bash
pm2 status
```

### Check application status

```bash
pm2 info sol-price-fetcher
```

### View detailed error logs

```bash
pm2 logs sol-price-fetcher --err --lines 200
```

### Restart all PM2 processes

```bash
pm2 restart all
```

### Stop all PM2 processes

```bash
pm2 stop all
```

### Clear all logs

```bash
pm2 flush
```


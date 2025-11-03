module.exports = {
  apps: [{
    name: 'sol-price-fetcher',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    merge_logs: true,
    // Restart app if it crashes
    min_uptime: '10s',
    max_restarts: 10,
    // Wait 3 seconds before considering app as stable
    listen_timeout: 3000,
    // Graceful shutdown timeout
    kill_timeout: 5000
  }]
};


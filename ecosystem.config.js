// PM2 process config for production deployment.
// Install once: npm install -g pm2
// Start:        pm2 start ecosystem.config.js --env production
// Save boot:    pm2 save && pm2 startup
// Logs:         pm2 logs solar-commission
// Reload:       pm2 reload solar-commission
module.exports = {
  apps: [{
    name: 'solar-commission',
    script: 'server.js',
    // SQLite + WAL works best with a single Node process.
    // Do NOT enable cluster mode — multiple processes writing to the same SQLite
    // file is unsafe.
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '512M',
    watch: false,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    env: {
      NODE_ENV: 'development',
      PORT: 3001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001
      // JWT_SECRET must be set externally — server refuses to start without it in production.
      // Example: pm2 set solar-commission:JWT_SECRET <random-32+chars>
    }
  }]
};

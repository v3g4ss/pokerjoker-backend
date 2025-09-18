module.exports = {
  apps: [
    {
      name: 'poker-joker',
      script: 'server.js',
      // Prod-Mode: 1 Prozess reicht meist. Für mehr: instances: 'max', exec_mode: 'cluster'
      instances: 1,
      exec_mode: 'fork', // 'cluster' für mehrere Instanzen
      watch: false,      // in Prod: false; in Dev kannst du true setzen
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
        // weitere ENV liest dein server.js ohnehin aus .env
      },
      // Logs
      error_file: 'logs/err.log',
      out_file:   'logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Health/Grace
      kill_timeout: 8000,          // Zeit für graceful shutdown
      listen_timeout: 8000,        // Start-Timeout
      // Auto-Restart Regeln
      max_restarts: 10,
      restart_delay: 2000
    }
  ]
};

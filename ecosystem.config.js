module.exports = {
  apps: [
    {
      name: 'power-center',
      script: './src/server.js',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '600M',
    },
  ],
};

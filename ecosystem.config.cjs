/**
 * PM2 ecosystem for gh-secretary.
 *
 * Все секретные переменные читаются из .env через `env_file`.
 * НЕ хардкодить токены в этом файле — он в репозитории.
 *
 * Запуск:   pm2 start ecosystem.config.cjs
 * Логи:     pm2 logs secretary-proxy
 */
module.exports = {
  apps: [
    {
      name: "secretary-proxy",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      env_file: ".env",
      time: true,
    },
  ],
};

/**
 * PM2 ecosystem example for gh-secretary
 * Copy to project root as ecosystem.config.cjs and adjust paths.
 */
module.exports = {
  apps: [
    {
      name: "secretary-proxy",
      script: "src/server.js",
      cwd: __dirname.replace(/\/pm2$/, ""),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        PORT: "18792",
      },
      env_file: ".env",
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};

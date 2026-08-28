module.exports = {
  apps: [{
    name: 'medogram',
    script: 'dist/src/server.js',
    cwd: '/var/www/bee.xedoc.ru',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '350M',
    time: true,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3031',
      DATABASE_PATH: '/var/www/bee.xedoc.ru/data/medogram.sqlite',
      ADMIN_EMAIL: 'rodion89@list.ru',
      TRUST_PROXY: '1'
    }
  }]
};

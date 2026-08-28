import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/db.js';

test('новый favicon подключён для браузеров, ярлыков и manifest', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const html = await fetch(`${base}/`).then((response) => response.text());
    assert.match(html, /href="\/assets\/favicon\.svg" type="image\/svg\+xml"/);
    assert.match(html, /href="\/assets\/favicon-32\.png" type="image\/png" sizes="32x32"/);
    assert.match(html, /href="\/favicon\.ico"/);
    assert.match(html, /href="\/assets\/apple-touch-icon\.png" sizes="180x180"/);
    assert.match(html, /href="\/assets\/site\.webmanifest"/);

    for (const path of [
      '/assets/favicon.svg',
      '/assets/favicon-32.png',
      '/favicon.ico',
      '/assets/apple-touch-icon.png',
      '/assets/icon-192.png',
      '/assets/icon-512.png',
      '/assets/site.webmanifest',
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, `${path} должен отдаваться без ошибки`);
    }
  } finally {
    server.close();
    db.close();
  }
});

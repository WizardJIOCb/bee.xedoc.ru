import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db.js';

test('страница будущих партнёров доступна и содержит проверяемые контакты', async () => {
  process.env.NODE_ENV = 'test';
  const { createApp } = await import('../src/server.js');
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/future_partners`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html, /С кем запустить первый пилот рядом с Октябрьским/);
    assert.match(html, /Управление сельского хозяйства Туймазинского района/);
    assert.match(html, /\+7 \(34782\) 2-41-60/);
    assert.match(html, /Бесплатный пилот/);
    assert.match(html, /https:\/\/agro\.tatarstan\.ru/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

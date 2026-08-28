import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db.js';

test('ролевые страницы объясняют сервис и ведут в правильную регистрацию', async () => {
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
    const base = `http://127.0.0.1:${port}`;
    const [supplierResponse, retailResponse] = await Promise.all([
      fetch(`${base}/future_partner_join`),
      fetch(`${base}/future_retail_join`),
    ]);
    const [supplierHtml, retailHtml] = await Promise.all([
      supplierResponse.text(),
      retailResponse.text(),
    ]);

    assert.equal(supplierResponse.status, 200);
    assert.match(supplierHtml, /Ваш мёд должен продаваться по качеству/);
    assert.match(supplierHtml, /href="\/register\?role=supplier"/);
    assert.match(supplierHtml, /href="\/suppliers\/belaya-reka"/);
    assert.match(supplierHtml, /Без комиссии на старте/);
    assert.match(supplierHtml, /Сервис принимает оплату от магазина/);

    assert.equal(retailResponse.status, 200);
    assert.match(retailHtml, /Закупайте мёд по условиям/);
    assert.match(retailHtml, /href="\/register\?role=buyer"/);
    assert.match(retailHtml, /Каталог открыт без регистрации/);
    assert.match(retailHtml, /pchela\.shop гарантирует качество партии/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

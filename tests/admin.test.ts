import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { openDatabase } from '../src/db.js';

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}

test('регистрация административного email открывает защищённую админку', async () => {
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAIL = 'rodion89@list.ru';
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
    const registrationPage = await fetch(`${base}/register?role=buyer`);
    const csrfCookie = cookieValue(registrationPage.headers.get('set-cookie'), 'bee_csrf');
    assert.ok(csrfCookie);

    const csrfToken = decodeURIComponent(csrfCookie.split('=').slice(1).join('='));
    const registration = await fetch(`${base}/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
      body: new URLSearchParams({
        _csrf: csrfToken,
        role: 'buyer',
        next: '/dashboard',
        email: 'rodion89@list.ru',
        password: 'strong-password-89',
        display_name: 'Родион',
        company_name: 'pchela.shop',
        city_code: 'ufa',
      }),
    });

    assert.equal(registration.status, 302);
    assert.match(registration.headers.get('location') || '', /^\/admin\?/);
    const sessionCookie = cookieValue(registration.headers.get('set-cookie'), 'bee_session');
    assert.ok(sessionCookie);

    const user = db.prepare('SELECT is_admin, role, disabled FROM users WHERE email = ?').get('rodion89@list.ru') as { is_admin: number; role: string; disabled: number };
    assert.equal(user.is_admin, 1);
    assert.equal(user.role, 'buyer');
    assert.equal(user.disabled, 0);

    const adminPage = await fetch(`${base}/admin`, { headers: { cookie: `${csrfCookie}; ${sessionCookie}` } });
    const html = await adminPage.text();
    assert.equal(adminPage.status, 200);
    assert.match(html, /Пульс pchela\.shop/);
    assert.match(html, /Пользователи/);
    assert.match(html, /Пасеки и производства/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    delete process.env.ADMIN_EMAIL;
  }
});

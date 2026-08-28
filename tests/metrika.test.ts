import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/db.js';

function cookieValue(setCookie: string | null, name: string) {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}

test('Метрика подключена через CSP-совместимый скрипт и noscript-пиксель', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    const csp = page.headers.get('content-security-policy') || '';

    assert.match(html, /src="\/assets\/app\.js\?v=20260828\.14"/);
    assert.match(html, /https:\/\/mc\.yandex\.ru\/watch\/112046844/);
    assert.match(html, /data-metrika-goal=""/);
    assert.match(csp, /script-src[^;]*https:\/\/mc\.yandex\.ru/);
    assert.match(csp, /connect-src[^;]*wss:\/\/mc\.yandex\.ru/);
    assert.match(csp, /frame-src[^;]*blob:/);
    assert.doesNotMatch(csp, /style-src[^;]*'unsafe-inline'/);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');

    const statusCheck = await fetch(`${base}/?_ym_status-check=112046844&_ym_lang=ru`);
    const statusCsp = statusCheck.headers.get('content-security-policy') || '';
    assert.match(statusCsp, /style-src[^;]*'unsafe-inline'/);
    assert.equal(statusCheck.headers.get('x-frame-options'), null);
    assert.equal(statusCheck.headers.get('cross-origin-opener-policy'), null);

    const debuggerPage = await fetch(`${base}/?_ym_debug=2`);
    assert.match(debuggerPage.headers.get('content-security-policy') || '', /style-src[^;]*'unsafe-inline'/);

    const forgedStatusCheck = await fetch(`${base}/?_ym_status-check=999999`);
    assert.doesNotMatch(forgedStatusCheck.headers.get('content-security-policy') || '', /style-src[^;]*'unsafe-inline'/);
    assert.equal(forgedStatusCheck.headers.get('x-frame-options'), 'SAMEORIGIN');

    const script = await fetch(`${base}/assets/app.js`).then((response) => response.text());
    assert.match(script, /METRIKA_COUNTER_ID = 112046844/);
    assert.match(script, /ym-disable-keys/);
    assert.match(script, /'reachGoal'/);
    assert.match(script, /inquiry_submit/);

    const forged = await fetch(`${base}/?ym_goal=not_a_real_goal`).then((response) => response.text());
    assert.match(forged, /data-metrika-goal=""/);
    assert.doesNotMatch(forged, /data-metrika-goal="not_a_real_goal"/);
  } finally {
    server.close();
    db.close();
  }
});

test('успешная регистрация передаёт одноразовую серверную цель с ролью', async () => {
  const db = openDatabase(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const registrationPage = await fetch(`${base}/register?role=buyer`);
    const csrfCookie = cookieValue(registrationPage.headers.get('set-cookie'), 'bee_csrf');
    const csrfToken = decodeURIComponent(csrfCookie.slice('bee_csrf='.length));
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
      body: new URLSearchParams({
        _csrf: csrfToken,
        role: 'buyer',
        next: '/dashboard',
        display_name: 'Тестовый закупщик',
        company_name: 'Тестовый магазин',
        city_code: 'ufa',
        email: 'metrika-buyer@example.test',
        password: 'strong-password',
      }),
    });

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location') || '', base);
    assert.equal(location.pathname, '/dashboard');
    assert.equal(location.searchParams.get('ym_goal'), 'registration_success');
    assert.equal(location.searchParams.get('ym_role'), 'buyer');
    assert.match(location.searchParams.get('notice') || '', /Аккаунт закупщика создан/);
  } finally {
    server.close();
    db.close();
  }
});

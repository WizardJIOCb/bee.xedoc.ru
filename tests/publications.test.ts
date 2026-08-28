import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { hashPassword } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}

async function login(base: string, email: string, password: string) {
  const page = await fetch(`${base}/login`);
  const csrfCookie = cookieValue(page.headers.get('set-cookie'), 'bee_csrf');
  const csrfToken = decodeURIComponent(csrfCookie.split('=').slice(1).join('='));
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ _csrf: csrfToken, email, password, next: '/dashboard' }),
  });
  assert.equal(response.status, 302);
  const sessionCookie = cookieValue(response.headers.get('set-cookie'), 'bee_session');
  assert.ok(sessionCookie);
  return { csrfToken, cookie: `${csrfCookie}; ${sessionCookie}` };
}

test('пользовательская статья проходит модерацию, сохраняет теги и вложение', async () => {
  process.env.NODE_ENV = 'test';
  const { createApp } = await import('../src/server.js');
  const db = openDatabase(':memory:');
  const buyerPassword = 'buyer-password-89';
  const adminPassword = 'admin-password-89';
  const buyerResult = db.prepare(`INSERT INTO users (email, password_hash, role, display_name, company_name, city_code) VALUES (?, ?, 'buyer', ?, ?, 'ufa')`)
    .run('news-buyer@example.test', hashPassword(buyerPassword), 'Анна', 'Магазин «Соты»');
  const buyerId = Number(buyerResult.lastInsertRowid);
  db.prepare(`INSERT INTO users (email, password_hash, role, display_name, company_name, city_code, is_admin) VALUES (?, ?, 'buyer', ?, ?, 'ufa', 1)`)
    .run('news-admin@example.test', hashPassword(adminPassword), 'Редактор', 'pchela.shop');
  const apiary = db.prepare('SELECT id, name FROM apiaries WHERE published = 1 ORDER BY id LIMIT 1').get() as { id: number; name: string };
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });

  let uploadedPath = '';
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const buyer = await login(base, 'news-buyer@example.test', buyerPassword);
    const editorPage = await fetch(`${base}/dashboard/publications/new`, { headers: { cookie: buyer.cookie } });
    const editorHtml = await editorPage.text();
    assert.equal(editorPage.status, 200);
    assert.match(editorHtml, /Редактор статьи/);
    assert.match(editorHtml, /Магазин «Соты»/);

    const form = new FormData();
    form.set('_csrf', buyer.csrfToken);
    form.set('kind', 'article');
    form.set('title', 'Как магазин выбирает мёд на сезон');
    form.set('excerpt', 'Практический список для первой закупки.');
    form.set('body_html', '<h2>Начните с партии</h2><p>Смотрите на <strong>происхождение</strong>.</p><script>alert(1)</script>');
    form.set('apiary_mentions', String(apiary.id));
    form.set('buyer_mentions', String(buyerId));
    form.set('submit_action', 'submit');
    form.set('attachments', new Blob(['not-a-real-png-but-served-as-an-image'], { type: 'image/png' }), 'checklist.png');
    const created = await fetch(`${base}/dashboard/publications`, { method: 'POST', redirect: 'manual', headers: { cookie: buyer.cookie }, body: form });
    assert.equal(created.status, 302);
    assert.match(created.headers.get('location') || '', /^\/dashboard\/publications\?notice=/);

    const publication = db.prepare('SELECT id, slug, status, body_html FROM publications WHERE author_user_id = ?').get(buyerId) as { id: number; slug: string; status: string; body_html: string };
    assert.equal(publication.status, 'pending');
    assert.match(publication.body_html, /<strong>происхождение<\/strong>/);
    assert.doesNotMatch(publication.body_html, /script|alert/);
    const mentionCount = db.prepare('SELECT COUNT(*) AS count FROM publication_mentions WHERE publication_id = ?').get(publication.id) as { count: number };
    assert.equal(mentionCount.count, 2);
    const attachment = db.prepare('SELECT storage_path, url, media_type FROM publication_attachments WHERE publication_id = ?').get(publication.id) as { storage_path: string; url: string; media_type: string };
    uploadedPath = attachment.storage_path;
    assert.equal(attachment.media_type, 'image');
    assert.ok(existsSync(uploadedPath));

    const hidden = await fetch(`${base}/publications/${publication.slug}`);
    assert.equal(hidden.status, 404);

    const admin = await login(base, 'news-admin@example.test', adminPassword);
    const moderation = await fetch(`${base}/admin/publications/${publication.id}/status`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: admin.cookie },
      body: new URLSearchParams({ _csrf: admin.csrfToken, status: 'published', moderation_note: '' }),
    });
    assert.equal(moderation.status, 302);
    const visible = await fetch(`${base}/publications/${publication.slug}`);
    const html = await visible.text();
    assert.equal(visible.status, 200);
    assert.match(html, /Как магазин выбирает мёд на сезон/);
    assert.match(html, new RegExp(apiary.name));
    assert.match(html, /Магазин «Соты»/);
    const media = await fetch(`${base}${attachment.url}`);
    assert.equal(media.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    if (uploadedPath && existsSync(uploadedPath)) unlinkSync(uploadedPath);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, parseCookies, verifyPassword } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { distanceBetween, haversineKm, safeNext, slugify } from '../src/utils.js';

test('пароль хранится через scrypt и проверяется безопасно', () => {
  const hash = hashPassword('надежный-пароль');
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('надежный-пароль', hash), true);
  assert.equal(verifyPassword('другой-пароль', hash), false);
  assert.equal(verifyPassword('любой', 'disabled'), false);
});

test('slugify делает читаемый URL из русского названия', () => {
  assert.equal(slugify('Пасека «Белая река»'), 'paseka-belaya-reka');
  assert.equal(slugify('  Мёд & Липа  '), 'med-lipa');
});

test('расстояние считается по координатам городов', () => {
  const ufaSterlitamak = distanceBetween('ufa', 'sterlitamak');
  assert.ok(ufaSterlitamak !== null && ufaSterlitamak > 110 && ufaSterlitamak < 140);
  assert.equal(distanceBetween('unknown', 'ufa'), null);
  assert.equal(Math.round(haversineKm(0, 0, 0, 1)), 111);
});

test('redirect next не позволяет внешний URL', () => {
  assert.equal(safeNext('/catalog?from=ufa'), '/catalog?from=ufa');
  assert.equal(safeNext('//evil.example'), '/dashboard');
  assert.equal(safeNext('https://evil.example'), '/dashboard');
});

test('cookie parser сохраняет значения после первого знака равно', () => {
  assert.deepEqual(parseCookies('a=1; bee_session=abc%3Ddef; empty='), {
    a: '1', bee_session: 'abc=def', empty: '',
  });
});

test('база создаёт схему и демонстрационный каталог', () => {
  const db = openDatabase(':memory:');
  const apiaries = db.prepare('SELECT COUNT(*) AS count FROM apiaries WHERE published = 1').get() as { count: number };
  const lots = db.prepare('SELECT COUNT(*) AS count FROM lots WHERE available = 1').get() as { count: number };
  assert.equal(apiaries.count, 3);
  assert.equal(lots.count, 6);
  db.close();
});

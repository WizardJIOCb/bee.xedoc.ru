import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { DatabaseSync } from 'node:sqlite';
import { createSession, destroySession, getCurrentUser, hashPassword, randomToken, verifyPassword, type CurrentUser } from './auth.js';
import { openDatabase } from './db.js';
import { asFloat, asInt, asText, cities, cityMap, distanceBetween, money, number, safeNext, slugify } from './utils.js';

type CatalogItem = Record<string, unknown> & {
  id: number;
  slug: string;
  name: string;
  story: string;
  city_code: string;
  location_detail: string;
  years_experience: number;
  hives_count: number;
  production_type: string;
  delivery: string;
  certifications: string;
  lab_verified: number;
  frame_available: number;
  beeos_connected: number;
  verified: number;
  is_demo: number;
  accent: string;
  min_price: number;
  stock_kg: number;
  lots_count: number;
  varieties: string;
  forms: string;
  cityName?: string;
  regionName?: string;
  distance?: number | null;
};

declare global {
  namespace Express {
    interface Locals {
      currentUser: CurrentUser | null;
      csrfToken: string;
      activePath: string;
      notice: string;
      noticeType: string;
    }
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');
const production = process.env.NODE_ENV === 'production';
const databasePath = process.env.DATABASE_PATH || resolve(projectRoot, 'data', 'medogram.sqlite');
const secureCookies = production;

export function createApp(db: DatabaseSync = openDatabase(databasePath)) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', resolve(projectRoot, 'views'));
  app.locals.money = money;
  app.locals.number = number;
  app.locals.cityMap = cityMap;
  app.locals.year = new Date().getFullYear();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use('/assets', express.static(resolve(projectRoot, 'public'), {
    maxAge: production ? '7d' : 0,
    etag: true,
  }));

  app.use((request, response, next) => {
    response.locals.currentUser = getCurrentUser(db, request);
    response.locals.activePath = request.path;
    response.locals.notice = asText(request.query.notice, 180);
    response.locals.noticeType = asText(request.query.type, 20) === 'error' ? 'error' : 'success';
    response.locals.cities = cities;

    const cookieHeader = request.headers.cookie || '';
    const csrfMatch = cookieHeader.match(/(?:^|;\s*)bee_csrf=([^;]+)/);
    const csrfToken = csrfMatch ? decodeURIComponent(csrfMatch[1] || '') : randomToken(20);
    response.locals.csrfToken = csrfToken;
    if (!csrfMatch) {
      response.cookie('bee_csrf', csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      });
    }
    next();
  });

  app.use((request, response, next) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return next();
    if (asText(request.body?._csrf, 100) !== response.locals.csrfToken) {
      return response.status(403).render('error', {
        title: 'Форма устарела',
        status: 403,
        message: 'Обновите страницу и повторите действие.',
      });
    }
    return next();
  });

  const requireAuth = (request: Request, response: Response, next: NextFunction) => {
    if (!response.locals.currentUser) {
      const nextUrl = encodeURIComponent(request.originalUrl);
      return response.redirect(`/login?next=${nextUrl}&notice=${encodeURIComponent('Войдите, чтобы продолжить')}&type=error`);
    }
    return next();
  };

  const requireRole = (role: 'supplier' | 'buyer') => (request: Request, response: Response, next: NextFunction) => {
    if (!response.locals.currentUser) return requireAuth(request, response, next);
    if (response.locals.currentUser.role !== role) {
      return response.redirect(`/dashboard?notice=${encodeURIComponent('Это действие доступно для другой роли')}&type=error`);
    }
    return next();
  };

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 25,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Слишком много попыток. Подождите несколько минут и попробуйте снова.',
  });
  const inquiryLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Слишком много заявок за короткое время. Попробуйте позже.',
  });

  function catalogItems(query: Request['query'], limit?: number): CatalogItem[] {
    const rows = db.prepare(`
      SELECT a.*,
        MIN(CASE WHEN l.available = 1 THEN l.price_per_kg END) AS min_price,
        COALESCE(SUM(CASE WHEN l.available = 1 THEN l.stock_kg ELSE 0 END), 0) AS stock_kg,
        COUNT(CASE WHEN l.available = 1 THEN 1 END) AS lots_count,
        COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN l.available = 1 THEN l.variety END), '') AS varieties,
        COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN l.available = 1 THEN l.form END), '') AS forms
      FROM apiaries a
      LEFT JOIN lots l ON l.apiary_id = a.id
      WHERE a.published = 1
      GROUP BY a.id
    `).all() as CatalogItem[];

    const origin = asText(query.from, 40);
    const radius = asInt(query.radius, 0, 5000, 0);
    const maxPrice = asFloat(query.max_price, 0, 100000, 0);
    const minStock = asInt(query.min_stock, 0, 10000000, 0);
    const search = asText(query.q, 100).toLocaleLowerCase('ru');
    const variety = asText(query.variety, 100).toLocaleLowerCase('ru');
    const form = asText(query.form, 100).toLocaleLowerCase('ru');
    const labOnly = query.lab === '1';
    const verifiedOnly = query.verified === '1';

    let result = rows.map((item) => {
      const city = cityMap.get(item.city_code);
      return {
        ...item,
        min_price: Number(item.min_price || 0),
        stock_kg: Number(item.stock_kg || 0),
        lots_count: Number(item.lots_count || 0),
        cityName: city?.name || 'Локация уточняется',
        regionName: city?.region || '',
        distance: origin ? distanceBetween(origin, item.city_code) : null,
      };
    }).filter((item) => {
      const haystack = `${item.name} ${item.story} ${item.cityName} ${item.location_detail} ${item.varieties}`.toLocaleLowerCase('ru');
      if (search && !haystack.includes(search)) return false;
      if (variety && !item.varieties.toLocaleLowerCase('ru').includes(variety)) return false;
      if (form && !item.forms.toLocaleLowerCase('ru').includes(form)) return false;
      if (labOnly && !item.lab_verified) return false;
      if (verifiedOnly && !item.verified) return false;
      if (maxPrice && (!item.min_price || item.min_price > maxPrice)) return false;
      if (minStock && item.stock_kg < minStock) return false;
      if (radius && (item.distance === null || item.distance === undefined || item.distance > radius)) return false;
      return true;
    });

    const sort = asText(query.sort, 30);
    result.sort((a, b) => {
      if (sort === 'price') return (a.min_price || Number.MAX_SAFE_INTEGER) - (b.min_price || Number.MAX_SAFE_INTEGER);
      if (sort === 'distance' && origin) return (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER);
      if (sort === 'stock') return b.stock_kg - a.stock_kg;
      return (b.verified * 3 + b.lab_verified * 2 + b.frame_available) - (a.verified * 3 + a.lab_verified * 2 + a.frame_available) || b.stock_kg - a.stock_kg;
    });

    return typeof limit === 'number' ? result.slice(0, limit) : result;
  }

  app.get('/health', (_request, response) => {
    const result = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    response.json({ status: result.ok === 1 ? 'ok' : 'degraded', service: 'medogram' });
  });

  app.get('/', (request, response) => {
    const featured = catalogItems({ from: 'ufa' }, 3);
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM apiaries WHERE published = 1) AS apiaries,
        (SELECT COALESCE(SUM(stock_kg), 0) FROM lots WHERE available = 1) AS stock,
        (SELECT COUNT(*) FROM lots WHERE available = 1) AS lots
    `).get();
    response.render('home', { title: 'Мёдограм — мёд напрямую от пасек', featured, stats });
  });

  app.get('/catalog', (request, response) => {
    const items = catalogItems(request.query);
    response.render('catalog', {
      title: 'Каталог пасек — Мёдограм',
      items,
      filters: request.query,
      varieties: ['Башкирская липа', 'Горное разнотравье', 'Лесное разнотравье', 'Гречишный', 'Цветочный', 'Разнотравье'],
      forms: ['Мёд в таре', 'Запечатанная рамка', 'Фасованный продукт'],
    });
  });

  app.get('/suppliers/:slug', (request, response) => {
    const apiary = db.prepare(`
      SELECT a.*, u.display_name
      FROM apiaries a JOIN users u ON u.id = a.user_id
      WHERE a.slug = ? AND a.published = 1
    `).get(request.params.slug) as Record<string, unknown> | undefined;
    if (!apiary) return response.status(404).render('error', { title: 'Пасека не найдена', status: 404, message: 'Возможно, карточка ещё не опубликована.' });
    const apiaryId = Number(apiary.id);
    const lots = db.prepare('SELECT * FROM lots WHERE apiary_id = ? AND available = 1 ORDER BY price_per_kg ASC').all(apiaryId);
    const city = cityMap.get(String(apiary.city_code));
    let favorited = false;
    if (response.locals.currentUser?.role === 'buyer') {
      favorited = Boolean(db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND apiary_id = ?').get(response.locals.currentUser.id, apiaryId));
    }
    return response.render('supplier', {
      title: `${apiary.name} — поставщик мёда`, apiary, lots, city, favorited,
    });
  });

  app.get('/register', (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    const role = request.query.role === 'buyer' ? 'buyer' : 'supplier';
    return response.render('register', {
      title: 'Создать аккаунт — Мёдограм', role, next: safeNext(request.query.next), error: '', values: {},
    });
  });

  app.post('/register', authLimiter, (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    const role = request.body.role === 'buyer' ? 'buyer' : 'supplier';
    const email = asText(request.body.email, 180).toLocaleLowerCase('ru');
    const password = String(request.body.password || '');
    const displayName = asText(request.body.display_name, 100);
    const companyName = asText(request.body.company_name, 140);
    const cityCode = cityMap.has(asText(request.body.city_code, 40)) ? asText(request.body.city_code, 40) : '';
    const nextUrl = safeNext(request.body.next);
    const values = { email, display_name: displayName, company_name: companyName, city_code: cityCode };

    let error = '';
    if (!/^\S+@\S+\.\S+$/.test(email)) error = 'Укажите рабочий email.';
    else if (password.length < 8) error = 'Пароль должен быть не короче 8 символов.';
    else if (!displayName) error = 'Укажите имя.';
    else if (!cityCode) error = 'Выберите ближайший город.';
    if (error) return response.status(400).render('register', { title: 'Создать аккаунт — Мёдограм', role, next: nextUrl, error, values });

    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare(`
        INSERT INTO users (email, password_hash, role, display_name, company_name, city_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(email, hashPassword(password), role, displayName, companyName, cityCode);
      const userId = Number(result.lastInsertRowid);
      if (role === 'supplier') {
        const baseName = companyName || `Пасека ${displayName}`;
        let slug = slugify(baseName);
        let suffix = 2;
        while (db.prepare('SELECT 1 FROM apiaries WHERE slug = ?').get(slug)) slug = `${slugify(baseName)}-${suffix++}`;
        db.prepare(`
          INSERT INTO apiaries (user_id, slug, name, city_code, location_detail)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, slug, baseName, cityCode, cityMap.get(cityCode)?.name || '');
      }
      db.exec('COMMIT');
      createSession(db, response, userId, secureCookies);
      return response.redirect(`${nextUrl}?notice=${encodeURIComponent(role === 'supplier' ? 'Аккаунт создан. Заполните карточку пасеки и добавьте первую партию.' : 'Аккаунт закупщика создан. Теперь можно отправлять заявки.')}`);
    } catch (errorValue) {
      try { db.exec('ROLLBACK'); } catch { /* transaction was not started */ }
      const duplicate = String(errorValue).includes('UNIQUE');
      return response.status(400).render('register', {
        title: 'Создать аккаунт — Мёдограм', role, next: nextUrl,
        error: duplicate ? 'Аккаунт с таким email уже существует.' : 'Не удалось создать аккаунт. Попробуйте ещё раз.', values,
      });
    }
  });

  app.get('/login', (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    response.render('login', { title: 'Войти — Мёдограм', next: safeNext(request.query.next), error: '', email: '' });
  });

  app.post('/login', authLimiter, (request, response) => {
    const email = asText(request.body.email, 180).toLocaleLowerCase('ru');
    const password = String(request.body.password || '');
    const nextUrl = safeNext(request.body.next);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND disabled = 0').get(email) as { id: number; password_hash: string } | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      return response.status(401).render('login', { title: 'Войти — Мёдограм', next: nextUrl, error: 'Неверный email или пароль.', email });
    }
    createSession(db, response, user.id, secureCookies);
    return response.redirect(nextUrl);
  });

  app.post('/logout', requireAuth, (request, response) => {
    destroySession(db, request, response, secureCookies);
    response.redirect(`/?notice=${encodeURIComponent('Вы вышли из аккаунта')}`);
  });

  app.get('/dashboard', requireAuth, (_request, response) => {
    const user = response.locals.currentUser!;
    if (user.role === 'supplier') {
      const apiary = db.prepare('SELECT * FROM apiaries WHERE user_id = ?').get(user.id) as Record<string, unknown>;
      const apiaryId = Number(apiary.id);
      const lots = db.prepare('SELECT * FROM lots WHERE apiary_id = ? ORDER BY created_at DESC').all(apiaryId);
      const inquiries = db.prepare(`
        SELECT i.*, u.display_name, u.company_name, u.email, l.variety
        FROM inquiries i
        JOIN users u ON u.id = i.buyer_user_id
        LEFT JOIN lots l ON l.id = i.lot_id
        WHERE i.apiary_id = ? ORDER BY i.created_at DESC
      `).all(apiaryId);
      return response.render('dashboard-supplier', { title: 'Кабинет поставщика — Мёдограм', apiary, lots, inquiries });
    }

    const inquiries = db.prepare(`
      SELECT i.*, a.name AS apiary_name, a.slug, l.variety
      FROM inquiries i
      JOIN apiaries a ON a.id = i.apiary_id
      LEFT JOIN lots l ON l.id = i.lot_id
      WHERE i.buyer_user_id = ? ORDER BY i.created_at DESC
    `).all(user.id);
    const favorites = db.prepare(`
      SELECT a.*, MIN(l.price_per_kg) AS min_price, SUM(CASE WHEN l.available = 1 THEN l.stock_kg ELSE 0 END) AS stock_kg
      FROM favorites f JOIN apiaries a ON a.id = f.apiary_id
      LEFT JOIN lots l ON l.apiary_id = a.id AND l.available = 1
      WHERE f.user_id = ? GROUP BY a.id ORDER BY f.created_at DESC
    `).all(user.id);
    return response.render('dashboard-buyer', { title: 'Кабинет закупщика — Мёдограм', inquiries, favorites });
  });

  app.post('/dashboard/profile', requireRole('supplier'), (_request, response) => {
    const request = _request as Request;
    const user = response.locals.currentUser!;
    const cityCode = cityMap.has(asText(request.body.city_code, 40)) ? asText(request.body.city_code, 40) : '';
    const name = asText(request.body.name, 140);
    if (!name || !cityCode) return response.redirect(`/dashboard?notice=${encodeURIComponent('Укажите название и ближайший город')}&type=error`);
    db.prepare(`
      UPDATE apiaries SET
        name = ?, story = ?, city_code = ?, location_detail = ?, years_experience = ?, hives_count = ?,
        production_type = ?, delivery = ?, certifications = ?, lab_verified = ?, frame_available = ?,
        published = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(
      name, asText(request.body.story, 1800), cityCode, asText(request.body.location_detail, 180),
      asInt(request.body.years_experience, 0, 100), asInt(request.body.hives_count, 0, 100000),
      asText(request.body.production_type, 100), asText(request.body.delivery, 500),
      asText(request.body.certifications, 500), request.body.lab_verified === '1' ? 1 : 0,
      request.body.frame_available === '1' ? 1 : 0, request.body.published === '1' ? 1 : 0, user.id,
    );
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Карточка пасеки сохранена')}`);
  });

  app.post('/dashboard/lots', requireRole('supplier'), (request, response) => {
    const apiary = db.prepare('SELECT id FROM apiaries WHERE user_id = ?').get(response.locals.currentUser!.id) as { id: number };
    const variety = asText(request.body.variety, 100);
    const stock = asInt(request.body.stock_kg, 1, 10000000);
    const price = asFloat(request.body.price_per_kg, 1, 1000000);
    if (!variety || !stock || !price) return response.redirect(`/dashboard?notice=${encodeURIComponent('Заполните сорт, объём и цену партии')}&type=error`);
    db.prepare(`
      INSERT INTO lots (apiary_id, variety, form, harvest_year, stock_kg, min_order_kg, price_per_kg, packaging, quality_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      apiary.id, variety, asText(request.body.form, 100) || 'Мёд в таре',
      asInt(request.body.harvest_year, 2020, 2035, new Date().getFullYear()), stock,
      asInt(request.body.min_order_kg, 1, stock, 1), price,
      asText(request.body.packaging, 180), asText(request.body.quality_note, 500),
    );
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Партия добавлена в каталог')}`);
  });

  app.post('/dashboard/lots/:id/toggle', requireRole('supplier'), (request, response) => {
    const lotId = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    db.prepare(`
      UPDATE lots SET available = CASE available WHEN 1 THEN 0 ELSE 1 END
      WHERE id = ? AND apiary_id = (SELECT id FROM apiaries WHERE user_id = ?)
    `).run(lotId, response.locals.currentUser!.id);
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Статус партии изменён')}`);
  });

  app.post('/dashboard/lots/:id/delete', requireRole('supplier'), (request, response) => {
    const lotId = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    db.prepare(`DELETE FROM lots WHERE id = ? AND apiary_id = (SELECT id FROM apiaries WHERE user_id = ?)`).run(lotId, response.locals.currentUser!.id);
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Партия удалена')}`);
  });

  app.post('/favorites/:apiaryId', requireRole('buyer'), (request, response) => {
    const apiaryId = asInt(request.params.apiaryId, 1, Number.MAX_SAFE_INTEGER);
    const existing = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND apiary_id = ?').get(response.locals.currentUser!.id, apiaryId);
    if (existing) db.prepare('DELETE FROM favorites WHERE user_id = ? AND apiary_id = ?').run(response.locals.currentUser!.id, apiaryId);
    else db.prepare('INSERT OR IGNORE INTO favorites (user_id, apiary_id) VALUES (?, ?)').run(response.locals.currentUser!.id, apiaryId);
    const apiary = db.prepare('SELECT slug FROM apiaries WHERE id = ?').get(apiaryId) as { slug: string } | undefined;
    return response.redirect(apiary ? `/suppliers/${apiary.slug}` : '/catalog');
  });

  app.post('/inquiries', inquiryLimiter, requireRole('buyer'), (request, response) => {
    const apiaryId = asInt(request.body.apiary_id, 1, Number.MAX_SAFE_INTEGER);
    const lotId = asInt(request.body.lot_id, 0, Number.MAX_SAFE_INTEGER, 0);
    const volume = asInt(request.body.volume_kg, 1, 10000000);
    const deliveryCity = asText(request.body.delivery_city, 160);
    const apiary = db.prepare('SELECT id, slug FROM apiaries WHERE id = ? AND published = 1').get(apiaryId) as { id: number; slug: string } | undefined;
    if (!apiary || !volume || !deliveryCity) return response.redirect(`/catalog?notice=${encodeURIComponent('Не удалось отправить заявку: проверьте объём и город')}&type=error`);
    if (lotId && !db.prepare('SELECT 1 FROM lots WHERE id = ? AND apiary_id = ? AND available = 1').get(lotId, apiaryId)) {
      return response.redirect(`/suppliers/${apiary.slug}?notice=${encodeURIComponent('Эта партия уже недоступна')}&type=error`);
    }
    db.prepare(`
      INSERT INTO inquiries (buyer_user_id, apiary_id, lot_id, volume_kg, delivery_city, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(response.locals.currentUser!.id, apiaryId, lotId || null, volume, deliveryCity, asText(request.body.message, 1200));
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Заявка отправлена. Поставщик увидит её в кабинете.')}`);
  });

  app.post('/inquiries/:id/status', requireRole('supplier'), (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const status = ['new', 'contacted', 'agreed', 'closed'].includes(request.body.status) ? request.body.status : 'new';
    db.prepare(`
      UPDATE inquiries SET status = ? WHERE id = ?
      AND apiary_id = (SELECT id FROM apiaries WHERE user_id = ?)
    `).run(status, id, response.locals.currentUser!.id);
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Статус заявки обновлён')}`);
  });

  app.use((_request, response) => response.status(404).render('error', {
    title: 'Страница не найдена', status: 404, message: 'Похоже, такой страницы ещё нет.',
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    if (response.headersSent) return;
    response.status(500).render('error', {
      title: 'Что-то пошло не так', status: 500,
      message: 'Мы уже знаем о проблеме. Попробуйте обновить страницу через минуту.',
    });
  });

  return app;
}

if (existsSync(fileURLToPath(import.meta.url)) && process.env.NODE_ENV !== 'test') {
  const port = asInt(process.env.PORT, 1, 65535, 3031);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  app.listen(port, host, () => console.log(`Мёдограм слушает http://${host}:${port}`));
}

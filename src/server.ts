import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { DatabaseSync } from 'node:sqlite';
import { createSession, destroySession, getCurrentUser, hashPassword, randomToken, verifyPassword, type CurrentUser } from './auth.js';
import { openDatabase } from './db.js';
import { futurePartners, partnerPatterns } from './future-partners.js';
import { createPublicationRouter, getFeaturedPublications } from './publications.js';
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
      metrikaGoal: string;
      metrikaGoalRole: string;
    }
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');
const production = process.env.NODE_ENV === 'production';
const databasePath = process.env.DATABASE_PATH || resolve(projectRoot, 'data', 'medogram.sqlite');
const mediaRoot = process.env.MEDIA_ROOT || resolve(dirname(databasePath), 'uploads');
const secureCookies = production;
const configuredAdminEmail = () => String(process.env.ADMIN_EMAIL || '').trim().toLocaleLowerCase('ru');
const metrikaHttpSources = [
  'https://mc.yandex.ru',
  'https://mc.yandex.com',
  'https://mc.webvisor.com',
  'https://mc.webvisor.org',
  'https://yastatic.net',
];
const metrikaSocketSources = [
  'wss://mc.yandex.ru',
  'wss://mc.yandex.com',
  'wss://mc.webvisor.com',
  'wss://mc.webvisor.org',
];
const metrikaFrameAncestors = [
  'https://metrika.yandex.ru',
  'https://analytics.yandex.ru',
  'https://metr.yandex.ru',
  'https://metrica.yandex.ru',
];
const metrikaServerGoals = new Set([
  'registration_success',
  'login_success',
  'inquiry_success',
  'favorite_added',
  'supplier_profile_published',
  'lot_created',
]);

function withMetrikaGoal(destination: string, goal: string, role = '') {
  const url = new URL(destination, 'http://pchela.local');
  url.searchParams.set('ym_goal', goal);
  if (role) url.searchParams.set('ym_role', role);
  return `${url.pathname}${url.search}${url.hash}`;
}

const coverChoices = [
  { value: '', label: 'Фирменная иллюстрация без фотографии' },
  { value: '/assets/apiaries/belaya-reka.webp', label: 'Горная пасека «Белая река»' },
  { value: '/assets/apiaries/bortniki-nugusha.webp', label: 'Лесная пасека у Нугуша' },
  { value: '/assets/apiaries/toratau-med.webp', label: 'Пасека у Торатау' },
] as const;

export function createApp(db: DatabaseSync = openDatabase(databasePath)) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', resolve(projectRoot, 'views'));
  app.locals.money = money;
  app.locals.number = number;
  app.locals.cityMap = cityMap;
  app.locals.coverChoices = coverChoices;
  app.locals.year = new Date().getFullYear();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', ...metrikaHttpSources],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'", ...metrikaHttpSources],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", ...metrikaHttpSources, ...metrikaSocketSources],
        childSrc: ["'self'", 'blob:', ...metrikaHttpSources],
        frameSrc: ["'self'", 'blob:', ...metrikaHttpSources],
        frameAncestors: ["'self'", ...metrikaFrameAncestors],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));
  app.use(express.json({ limit: '512kb' }));
  app.use('/assets', express.static(resolve(projectRoot, 'public'), {
    maxAge: production ? '7d' : 0,
    etag: true,
  }));
  app.use('/media', express.static(mediaRoot, {
    maxAge: production ? '7d' : 0,
    etag: true,
  }));

  app.use((request, response, next) => {
    response.locals.currentUser = getCurrentUser(db, request);
    response.locals.activePath = request.path;
    response.locals.notice = asText(request.query.notice, 180);
    response.locals.noticeType = asText(request.query.type, 20) === 'error' ? 'error' : 'success';
    const requestedMetrikaGoal = asText(request.query.ym_goal, 80);
    response.locals.metrikaGoal = metrikaServerGoals.has(requestedMetrikaGoal) ? requestedMetrikaGoal : '';
    response.locals.metrikaGoalRole = ['supplier', 'buyer', 'admin'].includes(asText(request.query.ym_role, 20))
      ? asText(request.query.ym_role, 20)
      : '';
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
    if (request.is('multipart/form-data')) return next();
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

  const requireAdmin = (request: Request, response: Response, next: NextFunction) => {
    if (!response.locals.currentUser) return requireAuth(request, response, next);
    if (!response.locals.currentUser.is_admin) {
      return response.status(403).render('error', {
        title: 'Нет доступа', status: 403, message: 'Эта страница доступна только администратору pchela.shop.',
      });
    }
    return next();
  };

  const auditAdmin = (adminUserId: number, action: string, entityType: string, entityId: number | null, details = '') => {
    db.prepare(`
      INSERT INTO admin_audit (admin_user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(adminUserId, action, entityType, entityId, details);
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

  app.use(createPublicationRouter(db, { mediaRoot, requireAuth, requireAdmin, auditAdmin }));

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
    response.json({ status: result.ok === 1 ? 'ok' : 'degraded', service: 'pchela.shop' });
  });

  app.get('/', (request, response) => {
    const featured = catalogItems({ from: 'ufa' }, 3);
    const featuredPublications = getFeaturedPublications(db, 3);
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM apiaries WHERE published = 1) AS apiaries,
        (SELECT COALESCE(SUM(stock_kg), 0) FROM lots WHERE available = 1) AS stock,
        (SELECT COUNT(*) FROM lots WHERE available = 1) AS lots
    `).get();
    response.render('home', { title: 'pchela.shop — мёд напрямую от пасек', featured, featuredPublications, stats });
  });

  app.get('/future_partners', (_request, response) => {
    response.render('future-partners', {
      title: 'Будущие партнёры рядом с Октябрьским — pchela.shop',
      partners: futurePartners,
      patterns: partnerPatterns,
    });
  });

  app.get('/future_partner_join', (_request, response) => {
    response.render('future-partner-join', {
      title: 'Продавать мёд магазинам',
    });
  });

  app.get('/future_retail_join', (_request, response) => {
    response.render('future-retail-join', {
      title: 'Закупать мёд напрямую у пасек',
    });
  });

  app.get('/catalog', (request, response) => {
    const items = catalogItems(request.query);
    response.render('catalog', {
      title: 'Каталог пасек — pchela.shop',
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
      title: `${apiary.name} — поставщик мёда | pchela.shop`, apiary, lots, city, favorited,
    });
  });

  app.get('/register', (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    const role = request.query.role === 'buyer' ? 'buyer' : 'supplier';
    return response.render('register', {
      title: 'Создать аккаунт — pchela.shop', role, next: safeNext(request.query.next), error: '', values: {},
    });
  });

  app.post('/register', authLimiter, (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    const role = request.body.role === 'buyer' ? 'buyer' : 'supplier';
    const email = asText(request.body.email, 180).toLocaleLowerCase('ru');
    const adminEmail = configuredAdminEmail();
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
    if (error) return response.status(400).render('register', { title: 'Создать аккаунт — pchela.shop', role, next: nextUrl, error, values });

    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare(`
        INSERT INTO users (email, password_hash, role, display_name, company_name, city_code, is_admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(email, hashPassword(password), role, displayName, companyName, cityCode, adminEmail && email === adminEmail ? 1 : 0);
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
      const destination = adminEmail && email === adminEmail ? '/admin' : nextUrl;
      const notice = adminEmail && email === adminEmail
        ? 'Администратор создан. Добро пожаловать в панель управления.'
        : role === 'supplier'
          ? 'Аккаунт создан. Заполните карточку пасеки и добавьте первую партию.'
          : 'Аккаунт закупщика создан. Теперь можно отправлять заявки.';
      const destinationWithNotice = new URL(destination, 'http://pchela.local');
      destinationWithNotice.searchParams.set('notice', notice);
      return response.redirect(withMetrikaGoal(
        `${destinationWithNotice.pathname}${destinationWithNotice.search}${destinationWithNotice.hash}`,
        'registration_success',
        adminEmail && email === adminEmail ? 'admin' : role,
      ));
    } catch (errorValue) {
      try { db.exec('ROLLBACK'); } catch { /* transaction was not started */ }
      const duplicate = String(errorValue).includes('UNIQUE');
      return response.status(400).render('register', {
        title: 'Создать аккаунт — pchela.shop', role, next: nextUrl,
        error: duplicate ? 'Аккаунт с таким email уже существует.' : 'Не удалось создать аккаунт. Попробуйте ещё раз.', values,
      });
    }
  });

  app.get('/login', (request, response) => {
    if (response.locals.currentUser) return response.redirect('/dashboard');
    response.render('login', { title: 'Войти — pchela.shop', next: safeNext(request.query.next), error: '', email: '' });
  });

  app.post('/login', authLimiter, (request, response) => {
    const email = asText(request.body.email, 180).toLocaleLowerCase('ru');
    const password = String(request.body.password || '');
    const nextUrl = safeNext(request.body.next);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND disabled = 0').get(email) as { id: number; password_hash: string } | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      return response.status(401).render('login', { title: 'Войти — pchela.shop', next: nextUrl, error: 'Неверный email или пароль.', email });
    }
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    createSession(db, response, user.id, secureCookies);
    const userMeta = db.prepare('SELECT is_admin, role FROM users WHERE id = ?').get(user.id) as { is_admin: number; role: string };
    const destination = userMeta.is_admin && nextUrl === '/dashboard' ? '/admin' : nextUrl;
    return response.redirect(withMetrikaGoal(destination, 'login_success', userMeta.is_admin ? 'admin' : userMeta.role));
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
      return response.render('dashboard-supplier', { title: 'Кабинет поставщика — pchela.shop', apiary, lots, inquiries });
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
    return response.render('dashboard-buyer', { title: 'Кабинет закупщика — pchela.shop', inquiries, favorites });
  });

  app.post('/dashboard/account', requireAuth, (request, response) => {
    const user = response.locals.currentUser!;
    const displayName = asText(request.body.display_name, 100);
    const companyName = asText(request.body.company_name, 140);
    const cityCode = cityMap.has(asText(request.body.city_code, 40)) ? asText(request.body.city_code, 40) : '';
    if (!displayName || !cityCode) {
      return response.redirect(`/dashboard?notice=${encodeURIComponent('Укажите имя и ближайший город')}&type=error#account`);
    }
    db.prepare('UPDATE users SET display_name = ?, company_name = ?, city_code = ? WHERE id = ?')
      .run(displayName, companyName, cityCode, user.id);
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Данные аккаунта обновлены')}#account`);
  });

  app.post('/dashboard/password', authLimiter, requireAuth, (request, response) => {
    const user = response.locals.currentUser!;
    const currentPassword = String(request.body.current_password || '');
    const newPassword = String(request.body.new_password || '');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!verifyPassword(currentPassword, row.password_hash)) {
      return response.redirect(`/dashboard?notice=${encodeURIComponent('Текущий пароль указан неверно')}&type=error#account`);
    }
    if (newPassword.length < 8) {
      return response.redirect(`/dashboard?notice=${encodeURIComponent('Новый пароль должен быть не короче 8 символов')}&type=error#account`);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    createSession(db, response, user.id, secureCookies);
    return response.redirect(`/dashboard?notice=${encodeURIComponent('Пароль изменён, остальные сеансы завершены')}#account`);
  });

  app.post('/dashboard/profile', requireRole('supplier'), (_request, response) => {
    const request = _request as Request;
    const user = response.locals.currentUser!;
    const previousProfile = db.prepare('SELECT published FROM apiaries WHERE user_id = ?').get(user.id) as { published: number };
    const cityCode = cityMap.has(asText(request.body.city_code, 40)) ? asText(request.body.city_code, 40) : '';
    const name = asText(request.body.name, 140);
    const requestedCover = asText(request.body.cover_image, 220);
    const coverImage = coverChoices.some((choice) => choice.value === requestedCover) ? requestedCover : '';
    if (!name || !cityCode) return response.redirect(`/dashboard?notice=${encodeURIComponent('Укажите название и ближайший город')}&type=error`);
    db.prepare(`
      UPDATE apiaries SET
        name = ?, story = ?, city_code = ?, location_detail = ?, years_experience = ?, hives_count = ?,
        production_type = ?, delivery = ?, certifications = ?, lab_verified = ?, frame_available = ?,
        published = ?, cover_image = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(
      name, asText(request.body.story, 1800), cityCode, asText(request.body.location_detail, 180),
      asInt(request.body.years_experience, 0, 100), asInt(request.body.hives_count, 0, 100000),
      asText(request.body.production_type, 100), asText(request.body.delivery, 500),
      asText(request.body.certifications, 500), request.body.lab_verified === '1' ? 1 : 0,
      request.body.frame_available === '1' ? 1 : 0, request.body.published === '1' ? 1 : 0, coverImage, user.id,
    );
    const destination = `/dashboard?notice=${encodeURIComponent('Карточка пасеки сохранена')}`;
    return response.redirect(!previousProfile.published && request.body.published === '1'
      ? withMetrikaGoal(destination, 'supplier_profile_published', 'supplier')
      : destination);
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
    return response.redirect(withMetrikaGoal(
      `/dashboard?notice=${encodeURIComponent('Партия добавлена в каталог')}`,
      'lot_created',
      'supplier',
    ));
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
    const destination = apiary ? `/suppliers/${apiary.slug}` : '/catalog';
    return response.redirect(existing ? destination : withMetrikaGoal(destination, 'favorite_added', 'buyer'));
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
    return response.redirect(withMetrikaGoal(
      `/dashboard?notice=${encodeURIComponent('Заявка отправлена. Поставщик увидит её в кабинете.')}`,
      'inquiry_success',
      'buyer',
    ));
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

  app.get('/admin', requireAdmin, (request, response) => {
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE disabled = 0) AS active_users,
        (SELECT COUNT(*) FROM users WHERE role = 'supplier' AND disabled = 0) AS suppliers,
        (SELECT COUNT(*) FROM users WHERE role = 'buyer' AND disabled = 0) AS buyers,
        (SELECT COUNT(*) FROM apiaries WHERE published = 1) AS published_apiaries,
        (SELECT COUNT(*) FROM lots WHERE available = 1) AS active_lots,
        (SELECT COALESCE(SUM(stock_kg), 0) FROM lots WHERE available = 1) AS stock_kg,
        (SELECT COUNT(*) FROM inquiries) AS inquiries,
        (SELECT COUNT(*) FROM inquiries WHERE status = 'new') AS new_inquiries,
        (SELECT COUNT(*) FROM inquiries WHERE status = 'agreed') AS agreed_inquiries,
        (SELECT COUNT(*) FROM publications) AS publications,
        (SELECT COUNT(*) FROM publications WHERE status = 'pending') AS pending_publications
    `).get() as Record<string, number>;

    const q = asText(request.query.q, 100);
    const role = ['supplier', 'buyer'].includes(String(request.query.role)) ? String(request.query.role) : '';
    const like = `%${q}%`;
    const users = db.prepare(`
      SELECT u.*, a.id AS apiary_id, a.name AS apiary_name, a.published,
        (SELECT COUNT(*) FROM inquiries i WHERE i.buyer_user_id = u.id) AS buyer_inquiries,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions
      FROM users u
      LEFT JOIN apiaries a ON a.user_id = u.id
      WHERE (? = '' OR u.role = ?)
        AND (? = '' OR u.email LIKE ? OR u.display_name LIKE ? OR u.company_name LIKE ?)
      ORDER BY u.is_admin DESC, u.disabled ASC, u.created_at DESC
      LIMIT 150
    `).all(role, role, q, like, like, like);

    const apiaries = db.prepare(`
      SELECT a.*, u.email AS owner_email, u.display_name AS owner_name, u.disabled AS owner_disabled,
        (SELECT COUNT(*) FROM lots l WHERE l.apiary_id = a.id) AS lots_count,
        (SELECT COALESCE(SUM(l.stock_kg), 0) FROM lots l WHERE l.apiary_id = a.id AND l.available = 1) AS stock_kg,
        (SELECT COUNT(*) FROM inquiries i WHERE i.apiary_id = a.id) AS inquiries_count
      FROM apiaries a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.is_demo ASC, a.published DESC, a.updated_at DESC
    `).all();

    const inquiries = db.prepare(`
      SELECT i.*, buyer.email AS buyer_email, buyer.company_name AS buyer_company, buyer.display_name AS buyer_name,
        a.name AS apiary_name, l.variety
      FROM inquiries i
      JOIN users buyer ON buyer.id = i.buyer_user_id
      JOIN apiaries a ON a.id = i.apiary_id
      LEFT JOIN lots l ON l.id = i.lot_id
      ORDER BY i.created_at DESC LIMIT 80
    `).all();

    const rawTrend = db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) AS count
      FROM users WHERE created_at >= date('now', '-13 days')
      GROUP BY date(created_at) ORDER BY day
    `).all() as Array<{ day: string; count: number }>;
    const trendMap = new Map(rawTrend.map((item) => [item.day, Number(item.count)]));
    const registrationTrend = Array.from({ length: 14 }, (_, index) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - (13 - index));
      const day = date.toISOString().slice(0, 10);
      return { day, label: new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(date), count: trendMap.get(day) || 0 };
    });
    const trendMax = Math.max(1, ...registrationTrend.map((item) => item.count));

    const supplyLeaders = db.prepare(`
      SELECT a.name, COALESCE(SUM(CASE WHEN l.available = 1 THEN l.stock_kg ELSE 0 END), 0) AS stock_kg
      FROM apiaries a LEFT JOIN lots l ON l.apiary_id = a.id
      GROUP BY a.id ORDER BY stock_kg DESC LIMIT 5
    `).all() as Array<{ name: string; stock_kg: number }>;
    const supplyMax = Math.max(1, ...supplyLeaders.map((item) => Number(item.stock_kg)));

    const audit = db.prepare(`
      SELECT aa.*, u.email AS admin_email
      FROM admin_audit aa JOIN users u ON u.id = aa.admin_user_id
      ORDER BY aa.created_at DESC LIMIT 30
    `).all();

    return response.render('admin', {
      title: 'Админ-панель — pchela.shop', stats, users, apiaries, inquiries, registrationTrend,
      trendMax, supplyLeaders, supplyMax, audit, filters: { q, role },
    });
  });

  app.post('/admin/users/:id/toggle', requireAdmin, (request, response) => {
    const admin = response.locals.currentUser!;
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const action = asText(request.body.action, 30);
    const target = db.prepare('SELECT id, email, disabled, is_admin FROM users WHERE id = ?').get(id) as { id: number; email: string; disabled: number; is_admin: number } | undefined;
    if (!target) return response.redirect(`/admin?notice=${encodeURIComponent('Пользователь не найден')}&type=error#users`);
    if (target.id === admin.id && (action === 'disabled' || (action === 'admin' && target.is_admin))) {
      return response.redirect(`/admin?notice=${encodeURIComponent('Нельзя отключить собственный административный доступ')}&type=error#users`);
    }
    if (action === 'disabled') {
      const nextValue = target.disabled ? 0 : 1;
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(nextValue, id);
      if (nextValue) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      auditAdmin(admin.id, nextValue ? 'user_disabled' : 'user_enabled', 'user', id, target.email);
      return response.redirect(`/admin?notice=${encodeURIComponent(nextValue ? 'Пользователь отключён' : 'Пользователь включён')}#users`);
    }
    if (action === 'admin') {
      const nextValue = target.is_admin ? 0 : 1;
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(nextValue, id);
      auditAdmin(admin.id, nextValue ? 'admin_granted' : 'admin_revoked', 'user', id, target.email);
      return response.redirect(`/admin?notice=${encodeURIComponent(nextValue ? 'Доступ администратора выдан' : 'Доступ администратора отозван')}#users`);
    }
    return response.redirect(`/admin?notice=${encodeURIComponent('Неизвестное действие')}&type=error#users`);
  });

  app.post('/admin/apiaries/:id/toggle', requireAdmin, (request, response) => {
    const admin = response.locals.currentUser!;
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const action = asText(request.body.action, 30);
    const column = action === 'published' ? 'published' : action === 'verified' ? 'verified' : '';
    if (!column) return response.redirect(`/admin?notice=${encodeURIComponent('Неизвестное действие')}&type=error#apiaries`);
    const apiary = db.prepare(`SELECT id, name, ${column} AS value FROM apiaries WHERE id = ?`).get(id) as { id: number; name: string; value: number } | undefined;
    if (!apiary) return response.redirect(`/admin?notice=${encodeURIComponent('Пасека не найдена')}&type=error#apiaries`);
    const nextValue = apiary.value ? 0 : 1;
    db.prepare(`UPDATE apiaries SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextValue, id);
    auditAdmin(admin.id, `${column}_${nextValue ? 'enabled' : 'disabled'}`, 'apiary', id, apiary.name);
    return response.redirect(`/admin?notice=${encodeURIComponent(column === 'published' ? (nextValue ? 'Пасека опубликована' : 'Пасека снята с публикации') : (nextValue ? 'Пасека подтверждена' : 'Подтверждение снято'))}#apiaries`);
  });

  app.get('/admin/apiaries/:id/edit', requireAdmin, (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const apiary = db.prepare(`
      SELECT a.*, u.email AS owner_email, u.display_name AS owner_name, u.company_name AS owner_company
      FROM apiaries a JOIN users u ON u.id = a.user_id WHERE a.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!apiary) return response.status(404).render('error', { title: 'Пасека не найдена', status: 404, message: 'Карточка была удалена или не существует.' });
    const lots = db.prepare('SELECT * FROM lots WHERE apiary_id = ? ORDER BY created_at DESC').all(id);
    return response.render('admin-apiary', { title: `Редактирование ${apiary.name} — pchela.shop`, apiary, lots });
  });

  app.post('/admin/apiaries/:id', requireAdmin, (request, response) => {
    const admin = response.locals.currentUser!;
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const cityCode = cityMap.has(asText(request.body.city_code, 40)) ? asText(request.body.city_code, 40) : '';
    const name = asText(request.body.name, 140);
    const requestedCover = asText(request.body.cover_image, 220);
    const coverImage = coverChoices.some((choice) => choice.value === requestedCover) ? requestedCover : '';
    if (!name || !cityCode) return response.redirect(`/admin/apiaries/${id}/edit?notice=${encodeURIComponent('Укажите название и город')}&type=error`);
    const result = db.prepare(`
      UPDATE apiaries SET name = ?, story = ?, city_code = ?, location_detail = ?, years_experience = ?, hives_count = ?,
        production_type = ?, delivery = ?, certifications = ?, lab_verified = ?, frame_available = ?, verified = ?,
        published = ?, cover_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(
      name, asText(request.body.story, 1800), cityCode, asText(request.body.location_detail, 180),
      asInt(request.body.years_experience, 0, 100), asInt(request.body.hives_count, 0, 100000),
      asText(request.body.production_type, 100), asText(request.body.delivery, 500), asText(request.body.certifications, 500),
      request.body.lab_verified === '1' ? 1 : 0, request.body.frame_available === '1' ? 1 : 0,
      request.body.verified === '1' ? 1 : 0, request.body.published === '1' ? 1 : 0, coverImage, id,
    );
    if (!result.changes) return response.redirect(`/admin?notice=${encodeURIComponent('Пасека не найдена')}&type=error#apiaries`);
    auditAdmin(admin.id, 'apiary_updated', 'apiary', id, name);
    return response.redirect(`/admin/apiaries/${id}/edit?notice=${encodeURIComponent('Карточка пасеки сохранена')}`);
  });

  app.post('/admin/lots/:id/toggle', requireAdmin, (request, response) => {
    const admin = response.locals.currentUser!;
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const lot = db.prepare('SELECT l.id, l.apiary_id, l.variety, l.available FROM lots l WHERE l.id = ?').get(id) as { id: number; apiary_id: number; variety: string; available: number } | undefined;
    if (!lot) return response.redirect(`/admin?notice=${encodeURIComponent('Партия не найдена')}&type=error#apiaries`);
    const nextValue = lot.available ? 0 : 1;
    db.prepare('UPDATE lots SET available = ? WHERE id = ?').run(nextValue, id);
    auditAdmin(admin.id, nextValue ? 'lot_enabled' : 'lot_disabled', 'lot', id, lot.variety);
    return response.redirect(`/admin/apiaries/${lot.apiary_id}/edit?notice=${encodeURIComponent('Доступность партии изменена')}#lots`);
  });

  app.post('/admin/inquiries/:id/status', requireAdmin, (request, response) => {
    const admin = response.locals.currentUser!;
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const status = ['new', 'contacted', 'agreed', 'closed'].includes(request.body.status) ? request.body.status : 'new';
    const result = db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(status, id);
    if (result.changes) auditAdmin(admin.id, 'inquiry_status_updated', 'inquiry', id, status);
    return response.redirect(`/admin?notice=${encodeURIComponent(result.changes ? 'Статус заявки обновлён' : 'Заявка не найдена')}${result.changes ? '' : '&type=error'}#inquiries`);
  });

  app.use((_request, response) => response.status(404).render('error', {
    title: 'Страница не найдена', status: 404, message: 'Похоже, такой страницы ещё нет.',
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    if (response.headersSent) return;
    const uploadCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const uploadMessage = error instanceof Error ? error.message : '';
    if (uploadCode.startsWith('LIMIT_') || uploadMessage.startsWith('Поддерживаются ')) {
      response.status(400).render('error', {
        title: 'Не удалось загрузить файл', status: 400,
        message: uploadCode === 'LIMIT_FILE_SIZE' ? 'Один файл не должен быть больше 60 МБ.' : uploadMessage || 'Проверьте количество и формат вложений.',
      });
      return;
    }
    response.status(500).render('error', {
      title: 'Что-то пошло не так', status: 500,
      message: 'Мы уже знаем о проблеме. Попробуйте обновить страницу через минуту.',
    });
  });

  return app;
}

const executablePath = process.env.pm_exec_path || process.argv[1] || '';
if (executablePath && resolve(executablePath) === fileURLToPath(import.meta.url) && process.env.NODE_ENV !== 'test') {
  const port = asInt(process.env.PORT, 1, 65535, 3031);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  app.listen(port, host, () => console.log(`pchela.shop слушает http://${host}:${port}`));
}

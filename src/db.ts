import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cityMap, slugify } from './utils.js';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedDemo(db);
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('supplier', 'buyer')),
      display_name TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      city_code TEXT NOT NULL DEFAULT '',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apiaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      story TEXT NOT NULL DEFAULT '',
      city_code TEXT NOT NULL DEFAULT '',
      location_detail TEXT NOT NULL DEFAULT '',
      years_experience INTEGER NOT NULL DEFAULT 0,
      hives_count INTEGER NOT NULL DEFAULT 0,
      production_type TEXT NOT NULL DEFAULT 'Семейная пасека',
      delivery TEXT NOT NULL DEFAULT '',
      certifications TEXT NOT NULL DEFAULT '',
      lab_verified INTEGER NOT NULL DEFAULT 0,
      frame_available INTEGER NOT NULL DEFAULT 0,
      beeos_connected INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      accent TEXT NOT NULL DEFAULT 'amber',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      apiary_id INTEGER NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
      variety TEXT NOT NULL,
      form TEXT NOT NULL DEFAULT 'Мёд в таре',
      harvest_year INTEGER NOT NULL,
      stock_kg INTEGER NOT NULL,
      min_order_kg INTEGER NOT NULL,
      price_per_kg REAL NOT NULL,
      packaging TEXT NOT NULL DEFAULT '',
      quality_note TEXT NOT NULL DEFAULT '',
      available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      apiary_id INTEGER NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
      lot_id INTEGER REFERENCES lots(id) ON DELETE SET NULL,
      volume_kg INTEGER NOT NULL,
      delivery_city TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'agreed', 'closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      apiary_id INTEGER NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, apiary_id)
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('news', 'event', 'article')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'published', 'rejected')),
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      city_code TEXT NOT NULL DEFAULT '',
      event_location TEXT NOT NULL DEFAULT '',
      event_starts_at TEXT,
      event_ends_at TEXT,
      moderation_note TEXT NOT NULL DEFAULT '',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS publication_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
      url TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      caption TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS publication_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      apiary_id INTEGER REFERENCES apiaries(id) ON DELETE CASCADE,
      buyer_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((apiary_id IS NOT NULL AND buyer_user_id IS NULL) OR (apiary_id IS NULL AND buyer_user_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS lots_apiary_available_idx ON lots(apiary_id, available);
    CREATE INDEX IF NOT EXISTS inquiries_apiary_idx ON inquiries(apiary_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS publications_public_idx ON publications(status, kind, published_at DESC);
    CREATE INDEX IF NOT EXISTS publications_author_idx ON publications(author_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS publication_attachments_publication_idx ON publication_attachments(publication_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS publication_mentions_publication_idx ON publication_mentions(publication_id);
    CREATE UNIQUE INDEX IF NOT EXISTS publication_mentions_apiary_unique ON publication_mentions(publication_id, apiary_id) WHERE apiary_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS publication_mentions_buyer_unique ON publication_mentions(publication_id, buyer_user_id) WHERE buyer_user_id IS NOT NULL;
  `);

  ensureColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'last_login_at', 'TEXT');
  ensureColumn(db, 'apiaries', 'cover_image', "TEXT NOT NULL DEFAULT ''");

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLocaleLowerCase('ru');
  if (adminEmail) db.prepare('UPDATE users SET is_admin = 1 WHERE email = ? COLLATE NOCASE').run(adminEmail);

  const demoUpdates = [
    ['belaya-reka', '/assets/apiaries/belaya-reka.webp', 'Семейная кочевая пасека в предгорьях Южного Урала. Идём вслед за цветением липы и горного разнотравья, не смешиваем точки и фиксируем происхождение каждой партии. Для магазина подготовим образец, протокол и график поставок на сезон.'],
    ['bortniki-nugusha', '/assets/apiaries/bortniki-nugusha.webp', 'Лесная пасека у Нугуша вдали от интенсивных полей. Работаем небольшими однородными партиями, контролируем влажность перед отгрузкой и можем фасовать мёд под маркой хозяйства для локальной розницы.'],
    ['toratau-med', '/assets/apiaries/toratau-med.webp', 'Растущее хозяйство у шиханов с понятным запасом и гибкими условиями для первой закупки. Согласуем тару, минимальный объём и график отгрузки; сезонные партии держим отдельно, чтобы закупщик мог повторить удачный заказ.'],
  ] as const;
  const updateDemo = db.prepare('UPDATE apiaries SET cover_image = ?, story = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND is_demo = 1');
  for (const [slug, image, story] of demoUpdates) updateDemo.run(image, story, slug);
}

function seedDemo(db: DatabaseSync): void {
  const count = db.prepare('SELECT COUNT(*) AS count FROM apiaries').get() as { count: number };
  if (count.count > 0) return;

  const apiaries = [
    {
      name: 'Белая река', city: 'beloretsk', detail: 'Предгорья Южного Урала', years: 14, hives: 180,
      type: 'Семейная кочевая пасека', delivery: 'Самовывоз, доставка по Башкортостану от 300 кг',
      certs: 'Ветеринарное свидетельство, протокол партии', lab: 1, frame: 1, accent: 'forest', verified: 1,
      cover: '/assets/apiaries/belaya-reka.webp',
      story: 'Семейная кочевая пасека в предгорьях Южного Урала. Идём вслед за цветением липы и горного разнотравья, не смешиваем точки и фиксируем происхождение каждой партии. Для магазина подготовим образец, протокол и график поставок на сезон.',
      lots: [
        ['Горное разнотравье', 'Запечатанная рамка', 2026, 420, 20, 920, 'Рамка Дадан', 'Можно принять партию до распечатки'],
        ['Башкирская липа', 'Мёд в таре', 2026, 1350, 100, 610, 'Куботейнер 23 кг', 'Свежая качка, партия с единым происхождением'],
      ],
    },
    {
      name: 'Бортники Нугуша', city: 'nugush', detail: 'Национальный парк «Башкирия»', years: 9, hives: 96,
      type: 'Стационарная лесная пасека', delivery: 'Доставка до Уфы и Стерлитамака, транспортная компания',
      certs: 'Паспорт пасеки, лабораторный анализ', lab: 1, frame: 0, accent: 'blue', verified: 1,
      cover: '/assets/apiaries/bortniki-nugusha.webp',
      story: 'Лесная пасека у Нугуша вдали от интенсивных полей. Работаем небольшими однородными партиями, контролируем влажность перед отгрузкой и можем фасовать мёд под маркой хозяйства для локальной розницы.',
      lots: [
        ['Лесное разнотравье', 'Мёд в таре', 2026, 780, 50, 680, 'Куботейнер 23 кг', 'Влажность партии указана в протоколе'],
        ['Цветочный', 'Фасованный продукт', 2026, 320, 30, 760, 'Стекло 500 г, короб 12 шт.', 'Готово для полки под маркой производителя'],
      ],
    },
    {
      name: 'Торатау мёд', city: 'ishimbay', detail: 'Ишимбайский район', years: 7, hives: 74,
      type: 'Фермерское хозяйство', delivery: 'Самовывоз или доставка от 150 кг',
      certs: 'Паспорт пасеки', lab: 0, frame: 1, accent: 'clay', verified: 0,
      cover: '/assets/apiaries/toratau-med.webp',
      story: 'Растущее хозяйство у шиханов с понятным запасом и гибкими условиями для первой закупки. Согласуем тару, минимальный объём и график отгрузки; сезонные партии держим отдельно, чтобы закупщик мог повторить удачный заказ.',
      lots: [
        ['Гречишный', 'Запечатанная рамка', 2026, 210, 10, 840, 'Полурамка', 'Доступно ограниченное количество до качки'],
        ['Разнотравье', 'Мёд в таре', 2026, 560, 50, 540, 'Ведро 12 кг', 'Образец партии по запросу'],
      ],
    },
  ] as const;

  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, role, display_name, company_name, city_code, disabled)
    VALUES (?, 'disabled', 'supplier', ?, ?, ?, 1)
  `);
  const insertApiary = db.prepare(`
    INSERT INTO apiaries (
      user_id, slug, name, story, city_code, location_detail, years_experience, hives_count,
      production_type, delivery, certifications, lab_verified, frame_available, verified,
      published, is_demo, accent, cover_image
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `);
  const insertLot = db.prepare(`
    INSERT INTO lots (apiary_id, variety, form, harvest_year, stock_kg, min_order_kg, price_per_kg, packaging, quality_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [index, apiary] of apiaries.entries()) {
    const city = cityMap.get(apiary.city);
    const userResult = insertUser.run(
      `demo-${index + 1}@example.invalid`,
      `Пасечник ${index + 1}`,
      apiary.name,
      apiary.city,
    );
    const userId = Number(userResult.lastInsertRowid);
    const apiaryResult = insertApiary.run(
      userId, slugify(apiary.name), apiary.name, apiary.story, apiary.city,
      apiary.detail || city?.name || '', apiary.years, apiary.hives, apiary.type,
      apiary.delivery, apiary.certs, apiary.lab, apiary.frame, apiary.verified, apiary.accent, apiary.cover,
    );
    const apiaryId = Number(apiaryResult.lastInsertRowid);
    for (const lot of apiary.lots) insertLot.run(apiaryId, ...lot);
  }
}

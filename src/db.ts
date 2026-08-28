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

    CREATE INDEX IF NOT EXISTS lots_apiary_available_idx ON lots(apiary_id, available);
    CREATE INDEX IF NOT EXISTS inquiries_apiary_idx ON inquiries(apiary_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);
}

function seedDemo(db: DatabaseSync): void {
  const count = db.prepare('SELECT COUNT(*) AS count FROM apiaries').get() as { count: number };
  if (count.count > 0) return;

  const apiaries = [
    {
      name: 'Белая река', city: 'beloretsk', detail: 'Предгорья Южного Урала', years: 14, hives: 180,
      type: 'Семейная кочевая пасека', delivery: 'Самовывоз, доставка по Башкортостану от 300 кг',
      certs: 'Ветеринарное свидетельство, протокол партии', lab: 1, frame: 1, accent: 'forest', verified: 1,
      story: 'Кочуем вслед за цветением липы и горного разнотравья. Каждая партия хранится отдельно: можно выбрать происхождение, дату качки и формат поставки.',
      lots: [
        ['Горное разнотравье', 'Запечатанная рамка', 2026, 420, 20, 920, 'Рамка Дадан', 'Можно принять партию до распечатки'],
        ['Башкирская липа', 'Мёд в таре', 2026, 1350, 100, 610, 'Куботейнер 23 кг', 'Свежая качка, партия с единым происхождением'],
      ],
    },
    {
      name: 'Бортники Нугуша', city: 'nugush', detail: 'Национальный парк «Башкирия»', years: 9, hives: 96,
      type: 'Стационарная лесная пасека', delivery: 'Доставка до Уфы и Стерлитамака, транспортная компания',
      certs: 'Паспорт пасеки, лабораторный анализ', lab: 1, frame: 0, accent: 'blue', verified: 1,
      story: 'Лесная пасека вдали от интенсивных полей. Работаем небольшими партиями и не смешиваем урожай разных точков.',
      lots: [
        ['Лесное разнотравье', 'Мёд в таре', 2026, 780, 50, 680, 'Куботейнер 23 кг', 'Влажность партии указана в протоколе'],
        ['Цветочный', 'Фасованный продукт', 2026, 320, 30, 760, 'Стекло 500 г, короб 12 шт.', 'Готово для полки под маркой производителя'],
      ],
    },
    {
      name: 'Торатау мёд', city: 'ishimbay', detail: 'Ишимбайский район', years: 7, hives: 74,
      type: 'Фермерское хозяйство', delivery: 'Самовывоз или доставка от 150 кг',
      certs: 'Паспорт пасеки', lab: 0, frame: 1, accent: 'clay', verified: 0,
      story: 'Молодое хозяйство у шиханов. Открыты к контракту на сезон и готовы согласовывать тару, объём и график отгрузки с магазинами.',
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
      published, is_demo, accent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
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
      apiary.delivery, apiary.certs, apiary.lab, apiary.frame, apiary.verified, apiary.accent,
    );
    const apiaryId = Number(apiaryResult.lastInsertRowid);
    for (const lot of apiary.lots) insertLot.run(apiaryId, ...lot);
  }
}

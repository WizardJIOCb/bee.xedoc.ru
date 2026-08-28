import { mkdirSync, unlinkSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import sanitizeHtml from 'sanitize-html';
import type { DatabaseSync } from 'node:sqlite';
import { asInt, asText, cityMap, slugify } from './utils.js';

type PublicationKind = 'news' | 'event' | 'article';
type PublicationStatus = 'draft' | 'pending' | 'published' | 'rejected';
type PublicationRow = Record<string, unknown> & {
  id: number;
  author_user_id: number;
  kind: PublicationKind;
  status: PublicationStatus;
  slug: string;
  title: string;
  body_html: string;
  published_at: string | null;
};

type PublicationRouteOptions = {
  mediaRoot: string;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  auditAdmin: (adminUserId: number, action: string, entityType: string, entityId: number | null, details?: string) => void;
};

const kinds = new Set<PublicationKind>(['news', 'event', 'article']);
const statuses = new Set<PublicationStatus>(['draft', 'pending', 'published', 'rejected']);
const mimeExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);

const publicationSelect = `
  SELECT p.*, u.display_name AS author_name, u.company_name AS author_company, u.role AS author_role,
    (SELECT pa.url FROM publication_attachments pa WHERE pa.publication_id = p.id AND pa.media_type = 'image' ORDER BY pa.sort_order, pa.id LIMIT 1) AS cover_url,
    (SELECT COUNT(*) FROM publication_attachments pa WHERE pa.publication_id = p.id) AS attachments_count,
    (SELECT COUNT(*) FROM publication_mentions pm WHERE pm.publication_id = p.id) AS mentions_count
  FROM publications p JOIN users u ON u.id = p.author_user_id
`;

export function sanitizePublicationBody(value: unknown): string {
  return sanitizeHtml(String(value ?? ''), {
    allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      b: 'strong',
      i: 'em',
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          ...(attribs.target === '_blank' ? { rel: 'noopener noreferrer' } : {}),
        },
      }),
    },
  }).trim();
}

function plainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function kindFrom(value: unknown): PublicationKind {
  const kind = asText(value, 20) as PublicationKind;
  return kinds.has(kind) ? kind : 'article';
}

function statusFrom(value: unknown, fallback: PublicationStatus): PublicationStatus {
  const status = asText(value, 20) as PublicationStatus;
  return statuses.has(status) ? status : fallback;
}

function idsFrom(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(values.map((item) => asInt(item, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean))];
}

function dateTimeFrom(value: unknown): string | null {
  const result = asText(value, 24);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(result) ? result : null;
}

function safeUnlink(storagePath: string, mediaRoot: string): void {
  const root = resolve(mediaRoot);
  const target = resolve(storagePath);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    try { unlinkSync(target); } catch { /* already removed */ }
  }
}

function uniqueSlug(db: DatabaseSync, title: string): string {
  const base = slugify(title) || 'publication';
  let slug = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM publications WHERE slug = ?').get(slug)) slug = `${base}-${suffix++}`;
  return slug;
}

function candidatesFor(db: DatabaseSync, user: Express.Locals['currentUser']) {
  if (!user) return { apiaries: [], buyers: [] };
  const apiaries = db.prepare(`
    SELECT a.id, a.name, a.slug, a.published, u.display_name AS owner_name
    FROM apiaries a JOIN users u ON u.id = a.user_id
    WHERE a.published = 1 OR a.user_id = ? OR ? = 1
    ORDER BY a.name COLLATE NOCASE
  `).all(user.id, user.is_admin);

  const buyers = user.is_admin
    ? db.prepare(`SELECT id, display_name, company_name, city_code FROM users WHERE role = 'buyer' AND disabled = 0 ORDER BY company_name COLLATE NOCASE, display_name COLLATE NOCASE`).all()
    : user.role === 'buyer'
      ? db.prepare(`SELECT id, display_name, company_name, city_code FROM users WHERE id = ?`).all(user.id)
      : db.prepare(`
          SELECT DISTINCT u.id, u.display_name, u.company_name, u.city_code
          FROM users u JOIN inquiries i ON i.buyer_user_id = u.id
          JOIN apiaries a ON a.id = i.apiary_id
          WHERE a.user_id = ? AND u.disabled = 0
          ORDER BY u.company_name COLLATE NOCASE, u.display_name COLLATE NOCASE
        `).all(user.id);
  return { apiaries, buyers };
}

function selectedMentions(db: DatabaseSync, publicationId: number) {
  const rows = db.prepare('SELECT apiary_id, buyer_user_id FROM publication_mentions WHERE publication_id = ?').all(publicationId) as Array<{ apiary_id: number | null; buyer_user_id: number | null }>;
  return {
    selectedApiaryIds: rows.flatMap((item) => item.apiary_id ? [item.apiary_id] : []),
    selectedBuyerIds: rows.flatMap((item) => item.buyer_user_id ? [item.buyer_user_id] : []),
  };
}

function replaceMentions(db: DatabaseSync, publicationId: number, requestedApiaries: number[], requestedBuyers: number[], candidates: ReturnType<typeof candidatesFor>): void {
  const allowedApiaries = new Set((candidates.apiaries as Array<{ id: number }>).map((item) => Number(item.id)));
  const allowedBuyers = new Set((candidates.buyers as Array<{ id: number }>).map((item) => Number(item.id)));
  db.prepare('DELETE FROM publication_mentions WHERE publication_id = ?').run(publicationId);
  const insertApiary = db.prepare('INSERT INTO publication_mentions (publication_id, apiary_id) VALUES (?, ?)');
  const insertBuyer = db.prepare('INSERT INTO publication_mentions (publication_id, buyer_user_id) VALUES (?, ?)');
  for (const id of requestedApiaries) if (allowedApiaries.has(id)) insertApiary.run(publicationId, id);
  for (const id of requestedBuyers) if (allowedBuyers.has(id)) insertBuyer.run(publicationId, id);
}

function loadPublication(db: DatabaseSync, id: number): PublicationRow | undefined {
  return db.prepare(`${publicationSelect} WHERE p.id = ?`).get(id) as PublicationRow | undefined;
}

function loadPublicationDetails(db: DatabaseSync, publication: PublicationRow) {
  const attachments = db.prepare('SELECT * FROM publication_attachments WHERE publication_id = ? ORDER BY sort_order, id').all(publication.id);
  const mentions = db.prepare(`
    SELECT pm.apiary_id, pm.buyer_user_id, a.name AS apiary_name, a.slug AS apiary_slug,
      COALESCE(b.company_name, b.display_name) AS buyer_name, b.city_code AS buyer_city_code
    FROM publication_mentions pm
    LEFT JOIN apiaries a ON a.id = pm.apiary_id
    LEFT JOIN users b ON b.id = pm.buyer_user_id
    WHERE pm.publication_id = ? ORDER BY a.name, buyer_name
  `).all(publication.id);
  return { attachments, mentions };
}

function publicationValues(body: Record<string, unknown>) {
  const title = asText(body.title, 180);
  const bodyHtml = sanitizePublicationBody(body.body_html);
  const suppliedExcerpt = asText(body.excerpt, 360);
  return {
    kind: kindFrom(body.kind),
    title,
    excerpt: suppliedExcerpt || plainText(bodyHtml).slice(0, 280),
    body_html: bodyHtml,
    city_code: cityMap.has(asText(body.city_code, 40)) ? asText(body.city_code, 40) : '',
    event_location: asText(body.event_location, 240),
    event_starts_at: dateTimeFrom(body.event_starts_at),
    event_ends_at: dateTimeFrom(body.event_ends_at),
  };
}

function desiredStatus(request: Request, isAdmin: boolean, previous: PublicationStatus = 'draft'): PublicationStatus {
  if (request.body.submit_action === 'save_draft') return 'draft';
  if (isAdmin) return statusFrom(request.body.status, previous === 'published' ? 'published' : 'pending');
  return 'pending';
}

function validateValues(values: ReturnType<typeof publicationValues>): string {
  if (!values.title) return 'Укажите заголовок публикации.';
  if (!plainText(values.body_html)) return 'Добавьте текст публикации.';
  if (values.kind === 'event' && !values.event_starts_at) return 'Для события укажите дату и время начала.';
  if (values.event_ends_at && values.event_starts_at && values.event_ends_at < values.event_starts_at) return 'Окончание события не может быть раньше начала.';
  return '';
}

function editorModel(db: DatabaseSync, response: Response, publication: Record<string, unknown>, error = '') {
  const id = Number(publication.id || 0);
  const details = id ? loadPublicationDetails(db, publication as PublicationRow) : { attachments: [], mentions: [] };
  const selected = id ? selectedMentions(db, id) : { selectedApiaryIds: [], selectedBuyerIds: [] };
  return {
    title: `${id ? 'Редактирование' : 'Новая публикация'} — pchela.shop`,
    publication,
    error,
    ...details,
    ...selected,
    candidates: candidatesFor(db, response.locals.currentUser),
    isAdminEditor: Boolean(response.locals.currentUser?.is_admin),
  };
}

export function getFeaturedPublications(db: DatabaseSync, limit = 3) {
  return db.prepare(`${publicationSelect}
    WHERE p.status = 'published'
    ORDER BY CASE WHEN p.kind = 'event' AND datetime(p.event_starts_at) >= datetime('now') THEN 0 ELSE 1 END,
      CASE WHEN p.kind = 'event' THEN datetime(p.event_starts_at) END ASC, datetime(p.published_at) DESC
    LIMIT ?
  `).all(limit);
}

export function createPublicationRouter(db: DatabaseSync, options: PublicationRouteOptions): Router {
  const router = Router();
  const uploadDir = resolve(options.mediaRoot, 'publications');
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_request, file, callback) => {
        const extension = mimeExtensions.get(file.mimetype) || extname(file.originalname).toLowerCase();
        callback(null, `${Date.now()}-${randomBytes(10).toString('hex')}${extension}`);
      },
    }),
    limits: { files: 8, fileSize: 60 * 1024 * 1024, fields: 80, fieldSize: 512 * 1024 },
    fileFilter: (_request, file, callback) => {
      if (!mimeExtensions.has(file.mimetype)) return callback(new Error('Поддерживаются JPG, PNG, WebP, GIF, MP4, WebM и MOV.'));
      return callback(null, true);
    },
  });
  const attachmentsUpload = upload.array('attachments', 8);
  const parseAttachments: RequestHandler = (request, response, next) => {
    attachmentsUpload(request, response, (error) => {
      if (error) for (const file of (request.files as Express.Multer.File[] | undefined) || []) safeUnlink(file.path, options.mediaRoot);
      next(error);
    });
  };
  const multipartCsrf = (request: Request, response: Response, next: NextFunction) => {
    if (asText(request.body?._csrf, 100) !== response.locals.csrfToken) {
      for (const file of (request.files as Express.Multer.File[] | undefined) || []) safeUnlink(file.path, options.mediaRoot);
      return response.status(403).render('error', { title: 'Форма устарела', status: 403, message: 'Обновите страницу и повторите действие.' });
    }
    return next();
  };
  const withUpload: RequestHandler[] = [parseAttachments, multipartCsrf];

  const renderNew = (_request: Request, response: Response) => response.render('publication-editor', editorModel(db, response, {
    id: 0, kind: 'article', status: response.locals.currentUser?.is_admin ? 'published' : 'draft', title: '', excerpt: '', body_html: '', city_code: '', event_location: '', event_starts_at: '', event_ends_at: '',
  }));

  router.get('/publications', (request, response) => {
    const filterKind = kinds.has(request.query.kind as PublicationKind) ? request.query.kind as PublicationKind : null;
    const q = asText(request.query.q, 100);
    const like = `%${q}%`;
    const items = db.prepare(`${publicationSelect}
      WHERE p.status = 'published' AND (? IS NULL OR p.kind = ?) AND (? = '' OR p.title LIKE ? OR p.excerpt LIKE ?)
      ORDER BY CASE WHEN p.kind = 'event' AND datetime(p.event_starts_at) >= datetime('now') THEN 0 WHEN p.kind = 'event' THEN 2 ELSE 1 END,
        CASE WHEN p.kind = 'event' THEN datetime(p.event_starts_at) END ASC, datetime(p.published_at) DESC
    `).all(filterKind, filterKind, q, like, like);
    return response.render('publications', { title: 'Новости, события и статьи — pchela.shop', items, filterKind, q });
  });

  for (const [path, kind, title] of [
    ['/news', 'news', 'Новости пчеловодства и рынка мёда'],
    ['/events', 'event', 'Предстоящие события'],
    ['/articles', 'article', 'Статьи участников сообщества'],
  ] as const) {
    router.get(path, (request, response) => {
      const q = asText(request.query.q, 100);
      const like = `%${q}%`;
      const items = db.prepare(`${publicationSelect}
        WHERE p.status = 'published' AND p.kind = ? AND (? = '' OR p.title LIKE ? OR p.excerpt LIKE ?)
        ORDER BY ${kind === 'event' ? "CASE WHEN datetime(p.event_starts_at) >= datetime('now') THEN 0 ELSE 1 END, datetime(p.event_starts_at) ASC" : 'datetime(p.published_at) DESC'}
      `).all(kind, q, like, like);
      return response.render('publications', { title: `${title} — pchela.shop`, items, filterKind: kind, q });
    });
  }

  router.get('/publications/:slug', (request, response) => {
    const publication = db.prepare(`${publicationSelect} WHERE p.slug = ?`).get(request.params.slug) as PublicationRow | undefined;
    if (!publication) return response.status(404).render('error', { title: 'Публикация не найдена', status: 404, message: 'Возможно, материал был удалён.' });
    const canPreview = response.locals.currentUser && (response.locals.currentUser.is_admin || response.locals.currentUser.id === publication.author_user_id);
    if (publication.status !== 'published' && !canPreview) return response.status(404).render('error', { title: 'Публикация не найдена', status: 404, message: 'Материал ещё не опубликован.' });
    return response.render('publication', {
      title: `${publication.title} — pchela.shop`, publication, ...loadPublicationDetails(db, publication), isPreview: publication.status !== 'published',
    });
  });

  router.get('/dashboard/publications', options.requireAuth, (_request, response) => {
    const user = response.locals.currentUser!;
    const items = db.prepare(`${publicationSelect} WHERE p.author_user_id = ? ORDER BY datetime(p.updated_at) DESC`).all(user.id);
    return response.render('my-publications', { title: 'Мои публикации — pchela.shop', items });
  });
  router.get('/dashboard/publications/new', options.requireAuth, renderNew);
  router.get('/admin/publications/new', options.requireAdmin, renderNew);

  router.post('/dashboard/publications', options.requireAuth, ...withUpload, (request, response) => {
    const user = response.locals.currentUser!;
    const files = (request.files as Express.Multer.File[] | undefined) || [];
    const values = publicationValues(request.body);
    const error = validateValues(values);
    if (error) {
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      return response.status(400).render('publication-editor', editorModel(db, response, { id: 0, status: 'draft', ...values }, error));
    }
    const status = desiredStatus(request, Boolean(user.is_admin));
    let id = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare(`
        INSERT INTO publications (author_user_id, kind, status, slug, title, excerpt, body_html, city_code, event_location, event_starts_at, event_ends_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP END)
      `).run(user.id, values.kind, status, uniqueSlug(db, values.title), values.title, values.excerpt, values.body_html, values.city_code, values.event_location, values.event_starts_at, values.event_ends_at, status);
      id = Number(result.lastInsertRowid);
      replaceMentions(db, id, idsFrom(request.body.apiary_mentions), idsFrom(request.body.buyer_mentions), candidatesFor(db, user));
      const insertAttachment = db.prepare(`INSERT INTO publication_attachments (publication_id, media_type, url, storage_path, original_name, mime_type, size_bytes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      files.forEach((file, index) => insertAttachment.run(id, file.mimetype.startsWith('image/') ? 'image' : 'video', `/media/publications/${file.filename}`, file.path, file.originalname, file.mimetype, file.size, index));
      db.exec('COMMIT');
    } catch (failure) {
      try { db.exec('ROLLBACK'); } catch { /* transaction not active */ }
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      throw failure;
    }
    if (user.is_admin) options.auditAdmin(user.id, 'publication_created', 'publication', id, values.title);
    const destination = user.is_admin ? '/admin/publications' : '/dashboard/publications';
    const notice = status === 'published' ? 'Публикация вышла на сайте.' : status === 'pending' ? 'Материал отправлен на модерацию.' : 'Черновик сохранён.';
    return response.redirect(`${destination}?notice=${encodeURIComponent(notice)}`);
  });

  const renderEdit = (request: Request, response: Response) => {
    const publication = loadPublication(db, asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER));
    if (!publication) return response.status(404).render('error', { title: 'Публикация не найдена', status: 404, message: 'Материал был удалён.' });
    const user = response.locals.currentUser!;
    if (!user.is_admin && publication.author_user_id !== user.id) return response.status(403).render('error', { title: 'Нет доступа', status: 403, message: 'Редактировать публикацию может только её автор.' });
    return response.render('publication-editor', editorModel(db, response, publication));
  };
  router.get('/dashboard/publications/:id/edit', options.requireAuth, renderEdit);
  router.get('/admin/publications/:id/edit', options.requireAdmin, renderEdit);

  router.post('/dashboard/publications/:id', options.requireAuth, ...withUpload, (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const publication = loadPublication(db, id);
    const files = (request.files as Express.Multer.File[] | undefined) || [];
    if (!publication) {
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      return response.status(404).render('error', { title: 'Публикация не найдена', status: 404, message: 'Материал был удалён.' });
    }
    const user = response.locals.currentUser!;
    if (!user.is_admin && publication.author_user_id !== user.id) {
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      return response.status(403).render('error', { title: 'Нет доступа', status: 403, message: 'Редактировать публикацию может только её автор.' });
    }
    const existingAttachments = db.prepare('SELECT id, storage_path FROM publication_attachments WHERE publication_id = ?').all(id) as Array<{ id: number; storage_path: string }>;
    const requestedRemovalIds = new Set(idsFrom(request.body.remove_attachments));
    const removals = existingAttachments.filter((item) => requestedRemovalIds.has(item.id));
    const existingCount = existingAttachments.length - removals.length;
    const values = publicationValues(request.body);
    const error = existingCount + files.length > 8 ? 'В одной публикации может быть не больше 8 вложений.' : validateValues(values);
    if (error) {
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      return response.status(400).render('publication-editor', editorModel(db, response, { ...publication, ...values }, error));
    }
    const status = desiredStatus(request, Boolean(user.is_admin), publication.status);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE publications SET kind = ?, status = ?, title = ?, excerpt = ?, body_html = ?, city_code = ?, event_location = ?, event_starts_at = ?, event_ends_at = ?,
          moderation_note = CASE WHEN ? = 'pending' THEN '' ELSE moderation_note END,
          published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(values.kind, status, values.title, values.excerpt, values.body_html, values.city_code, values.event_location, values.event_starts_at, values.event_ends_at, status, status, id);
      replaceMentions(db, id, idsFrom(request.body.apiary_mentions), idsFrom(request.body.buyer_mentions), candidatesFor(db, user));
      const attachments = db.prepare('SELECT id FROM publication_attachments WHERE publication_id = ?').all(id) as Array<{ id: number }>;
      const updateCaption = db.prepare('UPDATE publication_attachments SET caption = ? WHERE id = ? AND publication_id = ?');
      for (const attachment of attachments) updateCaption.run(asText(request.body[`attachment_caption_${attachment.id}`], 240), attachment.id, id);
      const deleteAttachment = db.prepare('DELETE FROM publication_attachments WHERE id = ? AND publication_id = ?');
      for (const attachment of removals) deleteAttachment.run(attachment.id, id);
      const insertAttachment = db.prepare(`INSERT INTO publication_attachments (publication_id, media_type, url, storage_path, original_name, mime_type, size_bytes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      files.forEach((file, index) => insertAttachment.run(id, file.mimetype.startsWith('image/') ? 'image' : 'video', `/media/publications/${file.filename}`, file.path, file.originalname, file.mimetype, file.size, existingCount + index));
      db.exec('COMMIT');
    } catch (failure) {
      try { db.exec('ROLLBACK'); } catch { /* transaction not active */ }
      for (const file of files) safeUnlink(file.path, options.mediaRoot);
      throw failure;
    }
    for (const attachment of removals) safeUnlink(attachment.storage_path, options.mediaRoot);
    if (user.is_admin) options.auditAdmin(user.id, 'publication_updated', 'publication', id, values.title);
    const destination = user.is_admin ? '/admin/publications' : '/dashboard/publications';
    return response.redirect(`${destination}?notice=${encodeURIComponent(status === 'published' ? 'Публикация обновлена.' : status === 'pending' ? 'Изменения отправлены на модерацию.' : 'Черновик сохранён.')}`);
  });

  router.post('/dashboard/publications/:id/attachments/:attachmentId/delete', options.requireAuth, (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const attachmentId = asInt(request.params.attachmentId, 1, Number.MAX_SAFE_INTEGER);
    const publication = loadPublication(db, id);
    const user = response.locals.currentUser!;
    if (!publication || (!user.is_admin && publication.author_user_id !== user.id)) return response.status(403).render('error', { title: 'Нет доступа', status: 403, message: 'Вложение недоступно.' });
    const attachment = db.prepare('SELECT storage_path FROM publication_attachments WHERE id = ? AND publication_id = ?').get(attachmentId, id) as { storage_path: string } | undefined;
    if (attachment) {
      db.prepare('DELETE FROM publication_attachments WHERE id = ?').run(attachmentId);
      safeUnlink(attachment.storage_path, options.mediaRoot);
    }
    const prefix = user.is_admin ? '/admin' : '/dashboard';
    return response.redirect(`${prefix}/publications/${id}/edit?notice=${encodeURIComponent(attachment ? 'Вложение удалено.' : 'Вложение не найдено.')}`);
  });

  router.post('/dashboard/publications/:id/delete', options.requireAuth, (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const publication = loadPublication(db, id);
    const user = response.locals.currentUser!;
    if (!publication || (!user.is_admin && publication.author_user_id !== user.id)) return response.status(403).render('error', { title: 'Нет доступа', status: 403, message: 'Удалить публикацию может только её автор.' });
    const paths = db.prepare('SELECT storage_path FROM publication_attachments WHERE publication_id = ?').all(id) as Array<{ storage_path: string }>;
    db.prepare('DELETE FROM publications WHERE id = ?').run(id);
    for (const item of paths) safeUnlink(item.storage_path, options.mediaRoot);
    if (user.is_admin) options.auditAdmin(user.id, 'publication_deleted', 'publication', id, publication.title);
    const destination = user.is_admin ? '/admin/publications' : '/dashboard/publications';
    return response.redirect(`${destination}?notice=${encodeURIComponent('Публикация удалена.')}`);
  });

  router.get('/admin/publications', options.requireAdmin, (request, response) => {
    const kind = kinds.has(request.query.kind as PublicationKind) ? request.query.kind as PublicationKind : '';
    const status = statuses.has(request.query.status as PublicationStatus) ? request.query.status as PublicationStatus : '';
    const q = asText(request.query.q, 100);
    const like = `%${q}%`;
    const items = db.prepare(`${publicationSelect}
      WHERE (? = '' OR p.kind = ?) AND (? = '' OR p.status = ?) AND (? = '' OR p.title LIKE ? OR u.display_name LIKE ? OR u.company_name LIKE ?)
      ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END, datetime(p.updated_at) DESC
    `).all(kind, kind, status, status, q, like, like, like);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'published') AS published, SUM(kind = 'event' AND status = 'published' AND datetime(event_starts_at) >= datetime('now')) AS upcoming FROM publications`).get();
    return response.render('admin-publications', { title: 'Управление публикациями — pchela.shop', items, stats, filters: { kind, status, q } });
  });

  router.post('/admin/publications/:id/status', options.requireAdmin, (request, response) => {
    const id = asInt(request.params.id, 1, Number.MAX_SAFE_INTEGER);
    const status = statusFrom(request.body.status, 'pending');
    const note = asText(request.body.moderation_note, 500);
    const publication = loadPublication(db, id);
    if (!publication) return response.redirect(`/admin/publications?notice=${encodeURIComponent('Публикация не найдена.')}&type=error`);
    db.prepare(`UPDATE publications SET status = ?, moderation_note = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, note, status, id);
    options.auditAdmin(response.locals.currentUser!.id, `publication_${status}`, 'publication', id, publication.title);
    return response.redirect(`/admin/publications?notice=${encodeURIComponent(status === 'published' ? 'Публикация вышла на сайте.' : 'Статус публикации обновлён.')}`);
  });

  return router;
}

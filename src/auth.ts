import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';

export type CurrentUser = {
  id: number;
  email: string;
  role: 'supplier' | 'buyer';
  display_name: string;
  company_name: string;
  city_code: string;
  is_admin: number;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expectedHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      if (index === -1) return [part.trim(), ''];
      const key = part.slice(0, index).trim();
      const rawValue = part.slice(index + 1).trim();
      try {
        return [key, decodeURIComponent(rawValue)];
      } catch {
        return [key, rawValue];
      }
    }),
  );
}

export function getCurrentUser(db: DatabaseSync, request: Request): CurrentUser | null {
  const token = parseCookies(request.headers.cookie).bee_session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.role, u.display_name, u.company_name, u.city_code, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.disabled = 0
  `).get(token) as CurrentUser | undefined;
  return row ?? null;
}

export function createSession(db: DatabaseSync, response: Response, userId: number, secure: boolean): void {
  const token = randomToken();
  db.prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')').run();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, datetime('now', '+30 days'), datetime('now'))
  `).run(token, userId);
  response.cookie('bee_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function destroySession(db: DatabaseSync, request: Request, response: Response, secure: boolean): void {
  const token = parseCookies(request.headers.cookie).bee_session;
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
  response.clearCookie('bee_session', { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

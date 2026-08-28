export type City = {
  code: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
};

export const cities: City[] = [
  { code: 'ufa', name: 'Уфа', region: 'Башкортостан', lat: 54.7351, lng: 55.9587 },
  { code: 'sterlitamak', name: 'Стерлитамак', region: 'Башкортостан', lat: 53.6304, lng: 55.9308 },
  { code: 'salavat', name: 'Салават', region: 'Башкортостан', lat: 53.3616, lng: 55.9247 },
  { code: 'ishimbay', name: 'Ишимбай', region: 'Башкортостан', lat: 53.4546, lng: 56.0439 },
  { code: 'meleuz', name: 'Мелеуз', region: 'Башкортостан', lat: 52.9591, lng: 55.9285 },
  { code: 'kumertau', name: 'Кумертау', region: 'Башкортостан', lat: 52.7565, lng: 55.7968 },
  { code: 'beloretsk', name: 'Белорецк', region: 'Башкортостан', lat: 53.9676, lng: 58.4098 },
  { code: 'sibay', name: 'Сибай', region: 'Башкортостан', lat: 52.7207, lng: 58.6664 },
  { code: 'baymak', name: 'Баймак', region: 'Башкортостан', lat: 52.5919, lng: 58.3112 },
  { code: 'mrakovo', name: 'Мраково', region: 'Башкортостан', lat: 52.7161, lng: 56.6244 },
  { code: 'nugush', name: 'Нугуш', region: 'Башкортостан', lat: 53.0505, lng: 56.4457 },
  { code: 'birsk', name: 'Бирск', region: 'Башкортостан', lat: 55.4175, lng: 55.5307 },
  { code: 'chishmy', name: 'Чишмы', region: 'Башкортостан', lat: 54.5922, lng: 55.3754 },
  { code: 'oktyabrsky', name: 'Октябрьский', region: 'Башкортостан', lat: 54.4815, lng: 53.4710 },
  { code: 'orenburg', name: 'Оренбург', region: 'Оренбургская область', lat: 51.7682, lng: 55.0969 },
  { code: 'kazan', name: 'Казань', region: 'Татарстан', lat: 55.7961, lng: 49.1064 },
  { code: 'chelyabinsk', name: 'Челябинск', region: 'Челябинская область', lat: 55.1644, lng: 61.4368 },
  { code: 'ekaterinburg', name: 'Екатеринбург', region: 'Свердловская область', lat: 56.8389, lng: 60.6057 },
  { code: 'samara', name: 'Самара', region: 'Самарская область', lat: 53.1959, lng: 50.1002 },
  { code: 'moscow', name: 'Москва', region: 'Москва', lat: 55.7558, lng: 37.6173 },
];

export const cityMap = new Map(cities.map((city) => [city.code, city]));

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function distanceBetween(cityCodeA: string, cityCodeB: string): number | null {
  const cityA = cityMap.get(cityCodeA);
  const cityB = cityMap.get(cityCodeB);
  if (!cityA || !cityB) return null;
  return Math.round(haversineKm(cityA.lat, cityA.lng, cityB.lat, cityB.lng));
}

export function slugify(value: string): string {
  const transliteration: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };

  return value
    .toLowerCase()
    .split('')
    .map((char) => transliteration[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'paseka';
}

export function asText(value: unknown, max = 500): string {
  return String(value ?? '').trim().slice(0, max);
}

export function asInt(value: unknown, min: number, max: number, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function asFloat(value: unknown, min: number, max: number, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function money(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value) + ' ₽';
}

export function number(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
}

export function safeNext(value: unknown): string {
  const next = asText(value, 300);
  return next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

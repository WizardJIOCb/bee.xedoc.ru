import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  cp('views', 'dist/views', { recursive: true }),
  cp('public', 'dist/public', { recursive: true }),
]);

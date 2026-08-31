// tsc only emits JavaScript, so the server's static page is copied separately.
import { cp } from 'node:fs/promises';

await cp(
  new URL('../src/server/public', import.meta.url),
  new URL('../dist/server/public', import.meta.url),
  { recursive: true, force: true },
);

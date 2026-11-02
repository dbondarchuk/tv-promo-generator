import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

let loaded = false;

/** Load .env from project root (and cwd) once, before reading settings. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(here, '../../../.env'),
    path.resolve(here, '../../.env'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, override: false });
      return;
    }
  }

  // Still call dotenv so it checks default cwd/.env if created later in odd setups
  dotenv.config({ override: false });
}

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('.env already exists; no changes made.');
} else {
  mkdirSync('.local', { recursive: true });
  const secret = () => randomBytes(24).toString('hex');
  const text = [
    'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=4310', 'PUBLIC_ORIGIN=http://127.0.0.1:4310',
    'DATABASE_URL=postgresql://neo@127.0.0.1:55436/dayflow', 'ADMIN_USERNAME=neo',
    `ADMIN_PASSWORD=${secret()}`, `SYNC_TOKEN=${secret()}`, `READ_API_TOKEN=${secret()}`,
    'STORAGE_DIR=.local/storage', 'TRUST_PROXY=false', '',
  ].join('\n');
  writeFileSync('.env', text, { mode: 0o600 });
  console.log('Created .env with random local credentials.');
}

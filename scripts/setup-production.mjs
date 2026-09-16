import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const domain = process.argv[2];
const username = process.argv[3] || 'neo';
if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) throw new Error('Usage: node scripts/setup-production.mjs dayflow.example.com [username]');
if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(username)) throw new Error('Invalid username');
const secret = () => randomBytes(24).toString('hex');
const databasePassword = secret();
writeFileSync('.env.production', [
  'NODE_ENV=production', `DOMAIN=${domain}`, `PUBLIC_ORIGIN=https://${domain}`,
  `POSTGRES_PASSWORD=${databasePassword}`, `DATABASE_URL=postgresql://dayflow:${databasePassword}@db:5432/dayflow`,
  `ADMIN_USERNAME=${username}`, `ADMIN_PASSWORD=${secret()}`, `SYNC_TOKEN=${secret()}`, `READ_API_TOKEN=${secret()}`, '',
].join('\n'), { mode: 0o600, flag: 'wx' });
console.log('Created .env.production with independent random credentials. Existing files are never overwritten.');

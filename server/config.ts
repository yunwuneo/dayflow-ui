import path from 'node:path';

export interface Config {
  databaseUrl: string; storageDir: string; adminUsername: string; adminPassword: string;
  syncToken: string; readToken?: string; publicOrigin: string; production: boolean;
  trustProxy: boolean; logger: boolean;
}

export function configuration(): Config {
  const required = (key: string, minimum = 1) => {
    const value = process.env[key];
    if (!value || value.length < minimum || value.startsWith('replace-')) throw new Error(`${key} is missing or insecure`);
    return value;
  };
  const production = process.env.NODE_ENV === 'production';
  const publicOrigin = new URL(required('PUBLIC_ORIGIN')).origin;
  if (production && !publicOrigin.startsWith('https://')) throw new Error('Production requires an HTTPS PUBLIC_ORIGIN');
  if (process.env.READ_API_TOKEN && process.env.READ_API_TOKEN.length < 32) throw new Error('READ_API_TOKEN must contain at least 32 characters');
  if (process.env.READ_API_TOKEN && process.env.READ_API_TOKEN === process.env.SYNC_TOKEN) throw new Error('Read and sync tokens must be different');
  return {
    databaseUrl: required('DATABASE_URL'), storageDir: path.resolve(process.env.STORAGE_DIR || '.local/storage'),
    adminUsername: required('ADMIN_USERNAME'), adminPassword: required('ADMIN_PASSWORD', 12),
    syncToken: required('SYNC_TOKEN', 32), readToken: process.env.READ_API_TOKEN,
    publicOrigin, production, trustProxy: process.env.TRUST_PROXY === 'true', logger: true,
  };
}

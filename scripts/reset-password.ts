import { Pool } from 'pg';
import { hashPassword } from '../server/security.ts';

const { DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) throw new Error('Set DATABASE_URL, ADMIN_USERNAME, and ADMIN_PASSWORD (12+ characters)');
const pool = new Pool({ connectionString: DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const updated = await client.query('UPDATE users SET password_hash=$2 WHERE username=$1', [ADMIN_USERNAME, await hashPassword(ADMIN_PASSWORD)]);
  if (updated.rowCount !== 1) throw new Error('Administrator does not exist');
  await client.query('DELETE FROM sessions WHERE username=$1', [ADMIN_USERNAME]);
  await client.query('COMMIT');
  console.log('Password updated and existing browser sessions revoked.');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { client.release(); await pool.end(); }

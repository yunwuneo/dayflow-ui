import { Pool } from 'pg';
import { resetPassword } from '../server/password.ts';

const { DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) throw new Error('Set DATABASE_URL, ADMIN_USERNAME, and ADMIN_PASSWORD (12+ characters)');
const pool = new Pool({ connectionString: DATABASE_URL });
try {
  await resetPassword(pool, ADMIN_USERNAME, ADMIN_PASSWORD);
  console.log('Password updated; browser sessions and OAuth authorizations revoked.');
} finally { await pool.end(); }

import type { Pool } from 'pg';
import { hashPassword } from './security.ts';

export async function resetPassword(pool: Pool, username: string, password: string) {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');
  const hash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE users SET password_hash=$2 WHERE username=$1', [username, hash]);
    if (updated.rowCount !== 1) throw new Error('Account does not exist');
    await client.query('DELETE FROM sessions WHERE username=$1', [username]);
    // Compatible with an old database before the additive OAuth migration.
    const exists = await client.query("SELECT to_regclass('mcp_oauth_grants') AS name");
    if (exists.rows[0].name) await client.query('UPDATE mcp_oauth_grants SET revoked_at=now() WHERE username=$1 AND revoked_at IS NULL', [username]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

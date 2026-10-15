import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { digest, verifyPassword } from './security.ts';

declare module 'fastify' { interface FastifyRequest { sessionUsername: string | null } }
export const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function nativeAuth(pool: Pool, config: Config, dummyHash: string) {
  const secure = new URL(config.publicOrigin).protocol === 'https:';
  const establish = async (username: string, reply: FastifyReply, db: Pool | PoolClient = pool) => {
    const token = randomBytes(32).toString('hex');
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')", [digest(token), username]);
    reply.setCookie('dayflow_session', token, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 604800 });
    return { username };
  };
  return {
    establish,
    async session(request: FastifyRequest, db: Pool | PoolClient = pool, lock = false): Promise<string | null> {
      const token = request.cookies.dayflow_session;
      if (!token) return null;
      const result = await db.query(`SELECT s.username FROM sessions s JOIN users u USING(username)
        WHERE s.token_hash=$1 AND s.expires_at>now() ${lock ? 'FOR SHARE OF u, s' : ''}`, [digest(token)]);
      return result.rows[0]?.username || null;
    },
    async login(username: string, password: string, reply: FastifyReply) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        // Hold the account lock until the session is committed, so password reset
        // cannot leave a new session authenticated with the old password.
        const result = await db.query('SELECT username,password_hash FROM users WHERE username=$1 FOR SHARE', [username]);
        const valid = await verifyPassword(password, result.rows[0]?.password_hash || dummyHash);
        if (!valid || !result.rowCount) throw failure(401, '用户名或密码不正确');
        const identity = await establish(result.rows[0].username, reply, db);
        await db.query('COMMIT');
        return identity;
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      finally { db.release(); }
    },
  };
}
export type NativeAuth = ReturnType<typeof nativeAuth>;

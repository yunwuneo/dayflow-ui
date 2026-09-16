import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z, ZodError } from 'zod';
import type { Config } from './config.ts';
import { batch as batchSchema, date as dateSchema } from './contracts.ts';
import { constantEquals, digest, hashPassword, verifyPassword } from './security.ts';

export function todayInZone(zone: string, boundary: number, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  const day = new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
  if (Number(get('hour')) < boundary) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
function monday(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const uuidQuery = z.object({ device_id: z.uuid() });
const activityParams = z.object({ device: z.uuid(), record: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const rowActivity = (row: any) => ({ ...row.payload, device_id: row.device_id, day: row.day,
  source_deleted: row.source_deleted, has_screenshot: Boolean(row.screenshot_hash), updated_at: row.updated_at });

export async function createApp(config: Config) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const existing = await pool.query('SELECT username FROM users WHERE username=$1', [config.adminUsername]);
  if (!existing.rowCount) await pool.query('INSERT INTO users VALUES($1,$2) ON CONFLICT DO NOTHING', [config.adminUsername, await hashPassword(config.adminPassword)]);
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  await mkdir(config.storageDir, { recursive: true });
  const app = Fastify({ logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] } : false,
    trustProxy: config.trustProxy ? (_address, hop) => hop === 0 : false, bodyLimit: 16 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 3 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addHook('onClose', async () => { await pool.end(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: '请求格式不正确', details: error.issues.map(i => i.path.join('.') + ': ' + i.message) });
    const typed = error as Error & { statusCode?: number };
    const status = typed.statusCode || 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? '服务暂时不可用，请稍后重试' : typed.message });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const url = request.routeOptions.url || request.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (url.startsWith('/api/v1/sync/')) {
      if (!bearer || !constantEquals(bearer, config.syncToken)) throw failure(401, '设备令牌无效');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.headers['x-dayflow-request'] !== '1') throw failure(403, '缺少请求校验标记');
      const origin = request.headers.origin;
      if (origin && origin !== config.publicOrigin) throw failure(403, '请求来源不受信任');
    }
    if (url === '/api/v1/auth/login') return;
    if (['GET', 'HEAD'].includes(request.method) && config.readToken && bearer && constantEquals(bearer, config.readToken)) return;
    const token = request.cookies.dayflow_session;
    if (!token) throw failure(401, '请先登录');
    const session = await pool.query('SELECT username FROM sessions WHERE token_hash=$1 AND expires_at>now()', [digest(token)]);
    if (!session.rowCount) throw failure(401, '登录已过期');
  });

  app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password } = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(request.body);
    const result = await pool.query('SELECT password_hash FROM users WHERE username=$1', [username]);
    const valid = await verifyPassword(password, result.rows[0]?.password_hash || dummyHash);
    if (!valid || !result.rowCount) throw failure(401, '用户名或密码不正确');
    const token = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    await pool.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')", [digest(token), username]);
    reply.setCookie('dayflow_session', token, { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/', maxAge: 604800 });
    return { username };
  });
  app.get('/api/v1/auth/session', async () => ({ username: config.adminUsername }));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.cookies.dayflow_session) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(request.cookies.dayflow_session)]);
    reply.clearCookie('dayflow_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/sync/state', async request => {
    const { device_id } = uuidQuery.parse(request.query);
    const [device, days, documents, activities] = await Promise.all([
      pool.query('SELECT revision FROM devices WHERE id=$1', [device_id]),
      pool.query('SELECT day::text,source_hash FROM source_days WHERE device_id=$1', [device_id]),
      pool.query('SELECT kind,day::text,source_hash FROM documents WHERE device_id=$1', [device_id]),
      pool.query('SELECT record_id::float8,day::text,content_hash,source_deleted,screenshot_hash IS NOT NULL AS has_screenshot FROM activities WHERE device_id=$1', [device_id]),
    ]);
    return { revision: device.rows[0]?.revision || 0, days: days.rows, documents: documents.rows, activities: activities.rows };
  });
  app.post('/api/v1/sync/batch', async request => {
    const data = batchSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO devices(id,name,time_zone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [data.device_id, data.device_name, data.time_zone]);
      const device = await client.query('SELECT revision FROM devices WHERE id=$1 FOR UPDATE', [data.device_id]);
      const previous = await client.query('SELECT revision FROM sync_batches WHERE device_id=$1 AND batch_id=$2', [data.device_id, data.batch_id]);
      if (previous.rowCount) { await client.query('COMMIT'); return { revision: previous.rows[0].revision, replayed: true }; }
      if (device.rows[0].revision !== data.expected_revision) throw failure(409, '同步版本已变化，请重新获取同步清单');
      // Apply all upserts before reconciliation so a record can safely move between days.
      for (const day of data.days) for (const item of day.activities) {
        await client.query(`INSERT INTO activities(device_id,record_id,day,start_at,end_at,content_hash,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id,record_id) DO UPDATE SET
          day=EXCLUDED.day,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,content_hash=EXCLUDED.content_hash,
          payload=EXCLUDED.payload,source_deleted=false,deleted_at=NULL,updated_at=now()`,
        [data.device_id, item.data.record_id, day.date, item.data.start, item.data.end, item.content_hash, item.data]);
      }
      for (const day of data.days) {
        const known = await client.query('SELECT record_id FROM activities WHERE device_id=$1 AND day=$2 AND record_id=ANY($3::bigint[])', [data.device_id, day.date, day.active_ids]);
        if (known.rowCount !== day.active_ids.length) throw failure(400, '同步清单包含缺少内容的活动');
        await client.query(`UPDATE activities SET source_deleted=true,deleted_at=now(),updated_at=now()
          WHERE device_id=$1 AND day=$2 AND NOT source_deleted AND NOT(record_id=ANY($3::bigint[]))`, [data.device_id, day.date, day.active_ids]);
        await client.query(`UPDATE activities SET source_deleted=false,deleted_at=NULL,updated_at=now()
          WHERE device_id=$1 AND day=$2 AND source_deleted AND record_id=ANY($3::bigint[])`, [data.device_id, day.date, day.active_ids]);
        await client.query('INSERT INTO source_days VALUES($1,$2,$3) ON CONFLICT(device_id,day) DO UPDATE SET source_hash=EXCLUDED.source_hash', [data.device_id, day.date, day.source_hash]);
      }
      for (const [kind, docs] of [['daily', data.dailies], ['weekly', data.weeks]] as const) for (const doc of docs) {
        await client.query(`INSERT INTO documents(device_id,kind,day,source_hash,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(device_id,kind,day) DO UPDATE SET source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,updated_at=now()`,
        [data.device_id, kind, doc.date, doc.source_hash, doc.document]);
      }
      const revision = data.expected_revision + 1;
      await client.query(`UPDATE devices SET name=$2,revision=$3,time_zone=$4,day_boundary_hour=$5,
        status=$6,categories=$7,last_sync_at=now() WHERE id=$1`,
      [data.device_id, data.device_name, revision, data.time_zone, data.day_boundary_hour, data.status, JSON.stringify(data.categories)]);
      await client.query('INSERT INTO sync_batches(device_id,batch_id,revision) VALUES($1,$2,$3)', [data.device_id, data.batch_id, revision]);
      await client.query('COMMIT');
      return { revision, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.put('/api/v1/sync/activities/:device/:record/screenshot', async (request, reply) => {
    const { device, record } = activityParams.parse(request.params);
    if (!Buffer.isBuffer(request.body)) throw failure(415, '截图必须为 JPEG');
    const exists = await pool.query('SELECT screenshot_hash FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
    if (!exists.rowCount) throw failure(404, '活动不存在');
    if (exists.rows[0].screenshot_hash) return { ok: true };
    let image: Buffer;
    try {
      image = await sharp(request.body, { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1440, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    } catch { throw failure(400, '截图文件无法解码'); }
    const hash = digest(image);
    const target = path.join(config.storageDir, `${hash}.jpg`);
    if (!existsSync(target)) {
      const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      try { await writeFile(temporary, image, { mode: 0o600 }); await rename(temporary, target); }
      finally { await unlink(temporary).catch(() => {}); }
    }
    // The first successful screenshot is retained with the archived activity.
    await pool.query('UPDATE activities SET screenshot_hash=$3 WHERE device_id=$1 AND record_id=$2 AND screenshot_hash IS NULL', [device, record, hash]);
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/v1/overview', async request => {
    const query = z.object({ date: dateSchema.optional() }).parse(request.query);
    const devices = (await pool.query('SELECT * FROM devices ORDER BY last_sync_at DESC NULLS LAST')).rows;
    const primary = devices[0];
    const today = todayInZone(primary?.time_zone || 'Asia/Shanghai', primary?.day_boundary_hour ?? 4);
    const day = query.date || today;
    const [days, totals, docs] = await Promise.all([
      pool.query('SELECT DISTINCT day::text FROM activities WHERE NOT source_deleted ORDER BY day DESC'),
      pool.query(`SELECT payload->>'category' AS category, sum((payload->>'duration_minutes')::numeric)::float8 AS minutes,
        count(*)::integer AS count FROM activities WHERE day=$1 AND NOT source_deleted GROUP BY payload->>'category' ORDER BY minutes DESC`, [day]),
      pool.query(`SELECT kind,payload FROM documents WHERE device_id=$1 AND ((kind='daily' AND day=$2) OR (kind='weekly' AND day=$3))`, [primary?.id || '00000000-0000-0000-0000-000000000000', day, monday(day)]),
    ]);
    return { date: day, today, time_zone: primary?.time_zone || 'Asia/Shanghai', day_boundary_hour: primary?.day_boundary_hour ?? 4,
      available_days: days.rows.map(r => r.day), devices, categories: primary?.categories || [],
      totals: totals.rows, daily: docs.rows.find(r => r.kind === 'daily')?.payload || null,
      weekly: docs.rows.find(r => r.kind === 'weekly')?.payload || null };
  });
  app.get('/api/v1/activities', async request => {
    const query = z.object({ date: dateSchema.optional(), from: dateSchema.optional(), to: dateSchema.optional(),
      q: z.string().max(500).optional(), category: z.string().max(500).optional(),
      include_deleted: z.enum(['true', 'false']).default('false'),
      page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(request.query);
    const values: unknown[] = []; const clauses = ['TRUE'];
    const condition = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
    if (query.date) condition('day=?', query.date);
    if (query.from) condition('day>=?', query.from);
    if (query.to) condition('day<=?', query.to);
    if (query.category) condition("payload->>'category'=?", query.category);
    if (query.include_deleted !== 'true') clauses.push('NOT source_deleted');
    if (query.q?.trim()) {
      const escaped = query.q.trim().replace(/[\\%_]/g, '\\$&');
      condition("concat_ws(' ',payload->>'title',payload->>'summary',payload->>'detailed_summary',payload->>'apps') ILIKE ?", `%${escaped}%`);
    }
    const where = clauses.join(' AND ');
    const total = await pool.query(`SELECT count(*)::integer AS total FROM activities WHERE ${where}`, values);
    values.push(query.limit, (query.page - 1) * query.limit);
    const result = await pool.query(`SELECT *,day::text FROM activities WHERE ${where}
      ORDER BY start_at ${query.date ? 'ASC' : 'DESC'},record_id ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { activities: result.rows.map(rowActivity), total: total.rows[0].total, page: query.page, limit: query.limit };
  });
  app.get('/api/v1/activities/:device/:record', async request => {
    const { device, record } = activityParams.parse(request.params);
    const result = await pool.query('SELECT *,day::text FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
    if (!result.rowCount) throw failure(404, '活动不存在');
    return rowActivity(result.rows[0]);
  });
  app.get('/api/v1/activities/:device/:record/screenshot', async (request, reply) => {
    const { device, record } = activityParams.parse(request.params);
    const result = await pool.query('SELECT screenshot_hash FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
    const hash = result.rows[0]?.screenshot_hash;
    if (!hash) throw failure(404, '截图尚未同步');
    try { return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=300').send(await readFile(path.join(config.storageDir, `${hash}.jpg`))); }
    catch { throw failure(404, '截图文件不可用'); }
  });

  const webRoot = path.resolve('dist/web');
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)) return reply.code(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z, ZodError } from 'zod';
import { validateOAuth, validateNotion, type Config } from './config.ts';
import { registerNotion } from './notion.ts';
import { enqueueBatch, preferences } from './notion-sync.ts';
import { NotionAPI, NotionError } from './notion-api.ts';
import { nativeAuth, failure } from './auth.ts';
import { createOAuth } from './oauth.ts';
import { batch as batchSchema, date as dateSchema } from './contracts.ts';
import { registerMcp } from './mcp.ts';
import { activityFilters, getActivity, getOverview, getScreenshotHash, searchActivities } from './queries.ts';
import { constantEquals, digest, hashPassword, verifyPassword } from './security.ts';
import { prepareScreenshotStorage, ScreenshotStorageError, storeScreenshot } from './storage.ts';

export { todayInZone } from './queries.ts';

const uuidQuery = z.object({ device_id: z.uuid() });
const activityParams = z.object({ device: z.uuid(), record: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export async function createApp(config: Config, options: { notionApi?: NotionAPI; startNotionWorker?: boolean } = {}) {
  validateOAuth(config);
  validateNotion(config);
  await prepareScreenshotStorage(config.storageDir);
  const secureCookies = config.production && new URL(config.publicOrigin).protocol === 'https:';
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('./oauth-schema.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('./notion-schema.sql', import.meta.url), 'utf8'));
  const existing = await pool.query('SELECT username FROM users WHERE username=$1', [config.adminUsername]);
  if (!existing.rowCount) await pool.query('INSERT INTO users VALUES($1,$2) ON CONFLICT DO NOTHING', [config.adminUsername, await hashPassword(config.adminPassword)]);
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  const app = Fastify({ logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
    serializers: { req: req => ({ method: req.method, url: req.url?.split('?')[0], remoteAddress: req.ip }) } } : false,
    trustProxy: config.trustProxy ? (_address, hop) => hop === 0 : false, bodyLimit: 16 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.decorateRequest('sessionUsername', null);
  const auth = nativeAuth(pool, config, dummyHash);
  const oauth = createOAuth(app, pool, config, auth);
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 3 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  let notion: ReturnType<typeof registerNotion>;
  app.addHook('onClose', async () => { await notion?.stop(); await pool.end(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NotionError) return reply.code(502).send({ error: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ error: '请求格式不正确', details: error.issues.map(i => i.path.join('.') + ': ' + i.message) });
    const typed = error as Error & { statusCode?: number };
    const status = typed.statusCode || 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 && !(error instanceof ScreenshotStorageError)
      ? '服务暂时不可用，请稍后重试' : typed.message });
  });
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url || request.url.split('?')[0];
    // Chrome applies form-action to a form's redirect chain as well. Allow only
    // configured HTTPS callback origins on the login/consent documents; the
    // authorization server still validates the full exact redirect URI.
    const callbackOrigins = config.oauth && ['/oauth/authorize', '/oauth/login'].includes(route)
      ? [...new Set(config.oauth.redirectUris.map(uri => new URL(uri).origin))].join(' ') : '';
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${callbackOrigins}`.trim());
    if (route.startsWith('/oauth/') || route.startsWith('/.well-known/oauth')) reply.header('Referrer-Policy', 'same-origin');
    const url = request.routeOptions.url || request.url.split('?')[0];
    if (!url.startsWith('/api/') && url !== '/mcp') return;
    reply.header('Cache-Control', 'no-store');
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    // MCP accepts only an Authorization header; cookies and sync credentials never authorize it.
    if (url === '/mcp') {
      if (!config.readToken && !oauth) throw failure(404, '接口不存在');
      if (bearer && config.readToken && constantEquals(bearer, config.readToken)) return;
      if (bearer && oauth && !constantEquals(bearer, config.syncToken) && await oauth.authenticate(bearer)) return;
      reply.header('WWW-Authenticate', oauth ? oauth.challenge : 'Bearer realm="dayflow-mcp"');
      throw failure(401, '只读令牌无效');
    }
    if (url.startsWith('/api/v1/sync/')) {
      if (!bearer || !constantEquals(bearer, config.syncToken)) throw failure(401, '设备令牌无效');
      return;
    }
    // The callback validates a one-use state bound to a live owner session and a
    // separate SameSite=Lax browser nonce; the login cookie remains Strict.
    if (url === '/api/v1/integrations/notion/callback' && request.method === 'GET') return;
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.headers['x-dayflow-request'] !== '1') throw failure(403, '缺少请求校验标记');
      const origin = request.headers.origin;
      if (origin && origin !== config.publicOrigin) throw failure(403, '请求来源不受信任');
    }
    if (['/api/v1/auth/login', '/api/v1/auth/casdoor/start', '/api/v1/auth/casdoor/callback', '/api/v1/auth/casdoor/config', '/api/v1/auth/casdoor/pending', '/api/v1/auth/casdoor/bind'].includes(url)) return;
    if (!url.startsWith('/api/v1/auth/') && !url.startsWith('/api/v1/integrations/') && ['GET', 'HEAD'].includes(request.method) && config.readToken && bearer && constantEquals(bearer, config.readToken)) return;
    request.sessionUsername = await auth.session(request);
    if (!request.sessionUsername) throw failure(401, '请先登录或登录已过期');
    if (config.oauth && !url.startsWith('/api/v1/auth/') && request.sessionUsername !== config.oauth.ownerUsername) throw failure(403, '只有档案所有者可以读取');
  });

  notion = registerNotion(app, pool, config, options.notionApi);
  app.addHook('onReady', async () => { if (options.startNotionWorker !== false) notion.start(); });

  app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
  const establishSession = auth.establish;
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password } = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(request.body);
    return auth.login(username, password, reply);
  });
  app.get('/api/v1/auth/casdoor/config', async () => ({ enabled: Boolean(config.casdoor) }));
  app.get('/api/v1/auth/casdoor/start', async (_request, reply) => {
    if (!config.casdoor) throw failure(503, 'Casdoor 登录尚未配置');
    const state = randomBytes(32).toString('hex');
    reply.setCookie('casdoor_oauth_state', state, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge: 600 });
    const authorize = new URL('/login/oauth/authorize', config.casdoor.origin);
    authorize.search = new URLSearchParams({ client_id: config.casdoor.clientId, response_type: 'code', redirect_uri: config.casdoor.redirectUri, scope: 'openid profile email', state }).toString();
    return reply.redirect(authorize.toString());
  });
  app.get('/api/v1/auth/casdoor/callback', async (request, reply) => {
    if (!config.casdoor) throw failure(503, 'Casdoor 登录尚未配置');
    const query = z.object({ code: z.string().min(1).optional(), state: z.string().min(1).optional(), error: z.string().optional() }).parse(request.query);
    const state = request.cookies.casdoor_oauth_state;
    reply.clearCookie('casdoor_oauth_state', { path: '/' });
    if (query.error) throw failure(401, 'Casdoor 登录已取消');
    if (!query.code || !query.state || !state || !constantEquals(query.state, state)) throw failure(400, 'Casdoor 登录状态无效');
    const tokenResponse = await fetch(new URL('/api/login/oauth/access_token', config.casdoor.origin), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.casdoor.clientId, client_secret: config.casdoor.clientSecret, code: query.code, redirect_uri: config.casdoor.redirectUri }),
    });
    if (!tokenResponse.ok) throw failure(502, 'Casdoor 令牌交换失败');
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw failure(502, 'Casdoor 未返回访问令牌');
    const userResponse = await fetch(new URL('/api/userinfo', config.casdoor.origin), { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } });
    if (!userResponse.ok) throw failure(502, 'Casdoor 用户信息获取失败');
    const profile = await userResponse.json() as Record<string, unknown>;
    const subject = String(profile.sub ?? profile.id ?? profile.name ?? '').trim();
    if (!subject) throw failure(502, 'Casdoor 用户信息缺少稳定身份标识');
    const linked = await pool.query('SELECT username FROM casdoor_accounts WHERE subject=$1', [subject]);
    if (linked.rowCount) { await establishSession(linked.rows[0].username, reply); return reply.redirect('/'); }
    const pending = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM casdoor_link_intents WHERE expires_at < now()');
    await pool.query("INSERT INTO casdoor_link_intents(token_hash,subject,profile,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [digest(pending), subject, JSON.stringify({ displayName: profile.displayName, email: profile.email })]);
    reply.setCookie('casdoor_pending', pending, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge: 600 });
    return reply.redirect('/?casdoor=bind');
  });
  app.get('/api/v1/auth/casdoor/pending', async request => {
    const pending = request.cookies.casdoor_pending;
    if (!pending) throw failure(401, '没有待绑定的 Casdoor 身份');
    const result = await pool.query('SELECT profile FROM casdoor_link_intents WHERE token_hash=$1 AND expires_at>now()', [digest(pending)]);
    if (!result.rowCount) throw failure(401, 'Casdoor 绑定已过期');
    return { displayName: result.rows[0].profile?.displayName || '', email: result.rows[0].profile?.email || '' };
  });
  app.post('/api/v1/auth/casdoor/bind', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const pending = request.cookies.casdoor_pending;
    if (!pending) throw failure(401, '没有待绑定的 Casdoor 身份');
    const { username, password } = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(request.body);
    const intent = await pool.query('SELECT subject FROM casdoor_link_intents WHERE token_hash=$1 AND expires_at>now()', [digest(pending)]);
    if (!intent.rowCount) throw failure(401, 'Casdoor 绑定已过期');
    const user = await pool.query('SELECT password_hash FROM users WHERE username=$1', [username]);
    const valid = await verifyPassword(password, user.rows[0]?.password_hash || dummyHash);
    if (!valid || !user.rowCount) throw failure(401, 'Dayflow 用户名或密码不正确');
    try {
      await pool.query('INSERT INTO casdoor_accounts(subject,username) VALUES($1,$2)', [intent.rows[0].subject, username]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw failure(409, '该 Dayflow 账号或 Casdoor 身份已完成绑定');
      throw error;
    }
    await pool.query('DELETE FROM casdoor_link_intents WHERE token_hash=$1', [digest(pending)]);
    reply.clearCookie('casdoor_pending', { path: '/' });
    return establishSession(username, reply);
  });
  app.get('/api/v1/auth/session', async request => ({ username: request.sessionUsername }));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.cookies.dayflow_session) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(request.cookies.dayflow_session)]);
    reply.clearCookie('dayflow_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/sync/state', async request => {
    const { device_id } = uuidQuery.parse(request.query);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const prefs = await preferences(client);
      if (!prefs.cloud_enabled) {
        const device = await client.query('SELECT revision FROM devices WHERE id=$1', [device_id]);
        const days = await client.query('SELECT day::text,source_hash FROM notion_days WHERE device_id=$1', [device_id]);
        const items = await client.query('SELECT key,kind,day::text,source_hash,source_deleted FROM notion_items WHERE device_id=$1', [device_id]);
        return { revision: device.rows[0]?.revision || 0, ...prefs, paused: !prefs.notion_enabled,
          days: days.rows, documents: items.rows.filter(i => i.kind !== 'activity').map(i => ({ kind: i.kind, day: i.day, source_hash: i.source_hash })),
          activities: items.rows.filter(i => i.kind === 'activity').map(i => ({ record_id: Number(i.key.split(':').at(-1)), day: i.day,
            content_hash: i.source_hash, source_deleted: i.source_deleted, has_screenshot: true })),
        };
      }
      const device = await client.query('SELECT revision FROM devices WHERE id=$1', [device_id]);
      const days = await client.query('SELECT day::text,source_hash FROM source_days WHERE device_id=$1', [device_id]);
      const documents = await client.query('SELECT kind,day::text,source_hash FROM documents WHERE device_id=$1', [device_id]);
      const activities = await client.query('SELECT record_id::float8,day::text,content_hash,source_deleted,screenshot_hash IS NOT NULL AS has_screenshot FROM activities WHERE device_id=$1', [device_id]);
      return { revision: device.rows[0]?.revision || 0, ...prefs, paused: false, days: days.rows, documents: documents.rows, activities: activities.rows };
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  app.post('/api/v1/sync/batch', async request => {
    const data = batchSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prefs = await preferences(client, true);
      if (!prefs.cloud_enabled && !prefs.notion_enabled) throw failure(423, '所有同步方式均已关闭，请在网页同步设置中开启');
      if (!prefs.cloud_enabled && !(await notion.settings.get(client))) throw failure(503, 'Notion 服务端配置缺失，暂时无法接收中转数据');
      await client.query('INSERT INTO devices(id,name,time_zone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [data.device_id, data.device_name, data.time_zone]);
      const device = await client.query('SELECT revision FROM devices WHERE id=$1 FOR UPDATE', [data.device_id]);
      const previous = await client.query('SELECT revision FROM sync_batches WHERE device_id=$1 AND batch_id=$2', [data.device_id, data.batch_id]);
      if (previous.rowCount) { await client.query('COMMIT'); return { revision: previous.rows[0].revision, replayed: true }; }
      if (device.rows[0].revision !== data.expected_revision) throw failure(409, '同步版本已变化，请重新获取同步清单');
      if (prefs.notion_enabled) await enqueueBatch(client, data);
      if (prefs.cloud_enabled) {
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
      }
      const revision = data.expected_revision + 1;
      await client.query(`UPDATE devices SET name=$2,revision=$3,time_zone=$4,day_boundary_hour=$5,
        status=CASE WHEN $8::boolean THEN $6::jsonb ELSE status END,
        categories=CASE WHEN $8::boolean THEN $7::jsonb ELSE categories END,last_sync_at=now() WHERE id=$1`,
      [data.device_id, data.device_name, revision, data.time_zone, data.day_boundary_hour,
        prefs.cloud_enabled ? data.status : {}, JSON.stringify(prefs.cloud_enabled ? data.categories : []), prefs.cloud_enabled]);
      await client.query('INSERT INTO sync_batches(device_id,batch_id,revision) VALUES($1,$2,$3)', [data.device_id, data.batch_id, revision]);
      await client.query('COMMIT');
      return { revision, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.put('/api/v1/sync/activities/:device/:record/screenshot', async (request, reply) => {
    const { device, record } = activityParams.parse(request.params);
    if (!(await preferences(pool)).cloud_enabled) return { ok: true, skipped: true };
    if (!Buffer.isBuffer(request.body)) throw failure(415, '截图必须为 JPEG');
    const exists = await pool.query('SELECT screenshot_hash FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
    if (!exists.rowCount) throw failure(404, '活动不存在');
    if (exists.rows[0].screenshot_hash) return { ok: true };
    let image: Buffer;
    try {
      image = await sharp(request.body, { limitInputPixels: 20_000_000 }).rotate().resize({ width: 1440, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    } catch { throw failure(400, '截图文件无法解码'); }
    const hash = digest(image);
    await storeScreenshot(config.storageDir, hash, image);
    // The first successful screenshot is retained with the archived activity.
    await pool.query('UPDATE activities SET screenshot_hash=$3 WHERE device_id=$1 AND record_id=$2 AND screenshot_hash IS NULL', [device, record, hash]);
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/v1/overview', async request => {
    const query = z.object({ date: dateSchema.optional() }).parse(request.query);
    return getOverview(pool, query.date);
  });
  app.get('/api/v1/activities', async request => {
    const query = z.object({ ...activityFilters, include_deleted: z.enum(['true', 'false']).default('false') }).parse(request.query);
    return searchActivities(pool, { ...query, include_deleted: query.include_deleted === 'true' });
  });
  app.get('/api/v1/activities/:device/:record', async request => {
    const { device, record } = activityParams.parse(request.params);
    const activity = await getActivity(pool, device, record);
    if (!activity) throw failure(404, '活动不存在');
    return activity;
  });
  app.get('/api/v1/activities/:device/:record/screenshot', async (request, reply) => {
    const { device, record } = activityParams.parse(request.params);
    const hash = await getScreenshotHash(pool, device, record);
    if (!hash) throw failure(404, '截图尚未同步');
    try { return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=300').send(await readFile(path.join(config.storageDir, `${hash}.jpg`))); }
    catch { throw failure(404, '截图文件不可用'); }
  });
  registerMcp(app, pool, config);

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

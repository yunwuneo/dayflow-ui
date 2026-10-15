import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.ts';
import { failure } from './auth.ts';
import { constantEquals, digest } from './security.ts';
import { encryptTokens, decryptTokens, ensureTemplateDatabase, NotionAPI, NotionError } from './notion-api.ts';
import { backfill, createNotionSync, NOTION_LOCK, preferences } from './notion-sync.ts';

export function registerNotion(app: FastifyInstance, pool: Pool, config: Config, api?: NotionAPI) {
  const sync = createNotionSync(pool, config, api);
  const owner = config.oauth?.ownerUsername || config.adminUsername;
  const requireOwner = (request: FastifyRequest) => {
    if (request.sessionUsername !== owner) throw failure(403, '只有档案所有者可以管理同步方式');
  };
  const configured = () => { if (!config.notion) throw failure(503, '服务器尚未配置 Notion 公开连接，请联系管理员'); return config.notion; };
  async function locked<T>(action: (db: PoolClient) => Promise<T>) {
    const db = await pool.connect();
    try { await db.query('SELECT pg_advisory_lock($1)', [NOTION_LOCK]); return await action(db); }
    finally { await db.query('SELECT pg_advisory_unlock($1)', [NOTION_LOCK]); db.release(); }
  }
  async function status() {
    const [prefs, connection, counts, devices] = await Promise.all([
      preferences(pool), pool.query(`SELECT workspace_id,workspace_name,page_id,data_source_id,connected_at,last_success_at,last_error,retry_at FROM notion_connection WHERE id=1`),
      pool.query(`SELECT count(*) FILTER(WHERE dirty)::int AS pending,count(*) FILTER(WHERE dirty AND last_error IS NOT NULL)::int AS failed,
        count(*) FILTER(WHERE synced_at IS NOT NULL)::int AS synced FROM notion_items`),
      pool.query('SELECT max(last_sync_at) AS last_upload_at FROM devices'),
    ]);
    return { ...prefs, configured: Boolean(config.notion), template_url: config.notion?.templateUrl || null,
      connection: connection.rows[0] || null, ...counts.rows[0], ...devices.rows[0] };
  }
  app.get('/api/v1/integrations/sync', async request => { requireOwner(request); return status(); });
  app.patch('/api/v1/integrations/sync', async request => {
    requireOwner(request);
    const change = z.object({ cloud_enabled: z.boolean().optional(), notion_enabled: z.boolean().optional() }).strict().parse(request.body);
    await locked(async db => {
      await db.query('BEGIN');
      try {
        const old = (await db.query('SELECT * FROM sync_preferences WHERE id=1 FOR UPDATE')).rows[0];
        const next = { ...old, ...change };
        if (next.notion_enabled) {
          configured();
          if (!(await db.query('SELECT data_source_id FROM notion_connection WHERE id=1')).rows[0]?.data_source_id) throw failure(409, '请先完成 Notion 授权并确认目标页面');
        }
        if (!old.notion_enabled && next.notion_enabled && old.cloud_enabled) await backfill(db);
        // Mode changes invalidate an in-flight client batch, preserving the existing
        // revision conflict recovery protocol and forcing a fresh manifest.
        if (old.cloud_enabled !== next.cloud_enabled || old.notion_enabled !== next.notion_enabled) await db.query('UPDATE devices SET revision=revision+1');
        if (!old.cloud_enabled && next.cloud_enabled) await db.query('DELETE FROM source_days');
        await db.query('UPDATE sync_preferences SET cloud_enabled=$1,notion_enabled=$2 WHERE id=1', [next.cloud_enabled, next.notion_enabled]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    });
    return status();
  });
  app.post('/api/v1/integrations/notion/authorize', async (request, reply) => {
    requireOwner(request); const n = configured();
    const state = randomBytes(32).toString('hex'); const browser = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM notion_auth_states WHERE expires_at<now() OR username=$1', [owner]);
    await pool.query(`INSERT INTO notion_auth_states VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [digest(state), digest(browser), digest(request.cookies.dayflow_session!), owner]);
    reply.setCookie('notion_oauth_browser', browser, { httpOnly: true, secure: new URL(config.publicOrigin).protocol === 'https:', sameSite: 'lax', path: '/api/v1/integrations/notion/callback', maxAge: 600 });
    const url = new URL('https://api.notion.com/v1/oauth/authorize');
    url.search = new URLSearchParams({ client_id: n.clientId, redirect_uri: n.redirectUri, response_type: 'code', owner: 'user', state }).toString();
    return { url: url.toString() };
  });
  app.get('/api/v1/integrations/notion/callback', async (request, reply) => {
    const n = configured();
    reply.header('Referrer-Policy', 'no-referrer');
    const query = z.object({ state: z.string().length(64), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }).parse(request.query);
    const nonce = request.cookies.notion_oauth_browser;
    const state = (await pool.query(`SELECT a.* FROM notion_auth_states a JOIN sessions s ON a.session_hash=s.token_hash
      WHERE a.state_hash=$1 AND a.expires_at>now() AND s.expires_at>now() AND a.username=s.username`, [digest(query.state)])).rows[0];
    if (!nonce || !state || state.username !== owner || !constantEquals(state.browser_hash, digest(nonce))) throw failure(400, 'Notion 授权已过期或浏览器不匹配，请重新发起授权');
    const consumed = await pool.query('DELETE FROM notion_auth_states WHERE state_hash=$1 RETURNING state_hash', [digest(query.state)]);
    if (!consumed.rowCount) throw failure(400, 'Notion 授权已使用，请重新发起授权');
    reply.clearCookie('notion_oauth_browser', { path: '/api/v1/integrations/notion/callback' });
    if (query.error || !query.code) return reply.redirect('/?view=status&notion=denied');
    try {
      await locked(async db => {
        const token = await sync.oauth({ grant_type: 'authorization_code', code: query.code, redirect_uri: n.redirectUri });
        if (typeof token.access_token !== 'string' || typeof token.workspace_id !== 'string' || typeof token.bot_id !== 'string') throw new NotionError(503);
        const previous = (await db.query('SELECT workspace_id,page_id,data_source_id FROM notion_connection WHERE id=1')).rows[0];
        if (previous && previous.workspace_id !== token.workspace_id) throw failure(409, '请先断开当前工作区，再授权新的工作区');
        await db.query(`INSERT INTO notion_connection(id,credentials,workspace_id,workspace_name,bot_id,page_id)
          VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET credentials=EXCLUDED.credentials,
          workspace_name=EXCLUDED.workspace_name,bot_id=EXCLUDED.bot_id,connected_at=now(),last_error=NULL,retry_at=NULL,
          page_id=COALESCE(notion_connection.page_id,EXCLUDED.page_id)`,
        [encryptTokens({ access_token: token.access_token, refresh_token: token.refresh_token }, n.encryptionKey), token.workspace_id,
          token.workspace_name || 'Notion 工作区', token.bot_id, token.duplicated_template_id || null]);
      });
      return reply.redirect('/?view=status&notion=connected');
    } catch (error) {
      // Do not include OAuth codes, tokens, Notion response bodies or secret-bearing errors in logs/URLs.
      return reply.redirect(`/?view=status&notion=${(error as { statusCode?: number }).statusCode === 409 ? 'workspace_mismatch' : 'failed'}`);
    }
  });
  app.get('/api/v1/integrations/notion/pages', async request => {
    requireOwner(request); configured();
    const { cursor } = z.object({ cursor: z.string().max(200).optional() }).parse(request.query);
    return locked(async db => {
      const result = await sync.call(db, 'search', 'POST', { filter: { value: 'page', property: 'object' }, page_size: 50, ...(cursor ? { start_cursor: cursor } : {}) });
      return { pages: result.results.filter((p: any) => !p.in_trash && p.parent?.type !== 'data_source_id').map((p: any) => ({ id: p.id,
        title: (Object.values(p.properties || {}).find((p: any) => p.type === 'title') as any)?.title?.map((t: any) => t.plain_text || t.text?.content || '').join('') || '未命名页面' })),
        next_cursor: result.has_more ? result.next_cursor : null };
    });
  });
  app.post('/api/v1/integrations/notion/target', async request => {
    requireOwner(request); configured();
    const { page_id } = z.object({ page_id: z.uuid() }).strict().parse(request.body);
    await locked(async db => {
      const current = (await db.query('SELECT page_id,data_source_id FROM notion_connection WHERE id=1')).rows[0];
      if (current?.data_source_id && current.page_id !== page_id) throw failure(409, '更换目标前请先断开连接，避免把已有同步队列写入另一页面');
      const page = await sync.call(db, `pages/${page_id}`);
      if (page.in_trash) throw failure(400, '目标页面已在回收站');
      const sourceId = await ensureTemplateDatabase((path, method, body) => sync.call(db, path, method, body), page_id);
      await db.query('UPDATE notion_connection SET page_id=$1,data_source_id=$2,last_error=NULL,retry_at=NULL WHERE id=1', [page_id, sourceId]);
    });
    return status();
  });
  app.post('/api/v1/integrations/notion/retry', async request => {
    requireOwner(request); configured();
    await locked(async db => {
      if (!(await preferences(db)).notion_enabled) throw failure(409, '请先开启 Notion 同步');
      await db.query('UPDATE notion_items SET next_attempt_at=now() WHERE dirty');
      await db.query('UPDATE notion_connection SET retry_at=NULL WHERE id=1');
    });
    return status();
  });
  app.delete('/api/v1/integrations/notion', async request => {
    requireOwner(request); configured();
    await locked(async db => {
      // Stop dispatch first. If revocation fails, retain credentials for a retry.
      await db.query('UPDATE sync_preferences SET notion_enabled=false WHERE id=1');
      const row = (await db.query('SELECT credentials FROM notion_connection WHERE id=1')).rows[0];
      if (row) {
        const tokens = decryptTokens(row.credentials, config.notion!.encryptionKey);
        await sync.oauth({ token: tokens.access_token }, 'revoke');
      }
      await db.query('BEGIN');
      try {
        await db.query('DELETE FROM notion_connection'); await db.query('DELETE FROM notion_items');
        await db.query('DELETE FROM notion_days'); await db.query('DELETE FROM notion_auth_states');
        await db.query('UPDATE devices SET revision=revision+1');
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    });
    return status();
  });
  return sync;
}

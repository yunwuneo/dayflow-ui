import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type { batch } from './contracts.ts';
import type { Config } from './config.ts';
import { failure } from './auth.ts';
import { notionSettings } from './notion-settings.ts';
import { decryptTokens, encryptTokens, formatDocument, NotionAPI, NotionError, richText, splitText } from './notion-api.ts';

export const NOTION_LOCK = 431017; // Per database: workers, target changes and disconnect serialize.
export type Preferences = { cloud_enabled: boolean; notion_enabled: boolean };
export async function preferences(db: Pool | PoolClient, lock = false): Promise<Preferences> {
  return (await db.query(`SELECT cloud_enabled,notion_enabled FROM sync_preferences WHERE id=1${lock ? ' FOR SHARE' : ''}`)).rows[0];
}
export async function enqueue(db: PoolClient, key: string, device: string, kind: string, day: string, hash: string, payload: unknown, deleted = false) {
  await db.query(`INSERT INTO notion_items(key,device_id,kind,day,source_hash,payload,source_deleted)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(key) DO UPDATE SET
    day=EXCLUDED.day,source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,source_deleted=EXCLUDED.source_deleted,
    dirty=true,version=notion_items.version+1,attempts=0,next_attempt_at=now(),last_error=NULL,source_updated_at=now()
    WHERE notion_items.source_hash<>EXCLUDED.source_hash OR notion_items.source_deleted<>EXCLUDED.source_deleted`,
  [key, device, kind, day, hash, payload, deleted]);
}
export async function enqueueBatch(db: PoolClient, data: z.infer<typeof batch>) {
  for (const day of data.days) for (const item of day.activities) {
    await enqueue(db, `${data.device_id}:activity:${item.data.record_id}`, data.device_id, 'activity', day.date, item.content_hash, item.data);
  }
  for (const day of data.days) {
    const keys = day.active_ids.map(id => `${data.device_id}:activity:${id}`);
    const known = await db.query("SELECT key FROM notion_items WHERE device_id=$1 AND day=$2 AND kind='activity' AND key=ANY($3::text[])", [data.device_id, day.date, keys]);
    if (known.rowCount !== keys.length) throw failure(409, 'Notion 同步清单已变化，请重新获取同步清单');
    await db.query(`UPDATE notion_items SET source_deleted=true,dirty=true,version=version+1,next_attempt_at=now(),attempts=0,last_error=NULL,source_updated_at=now()
      WHERE device_id=$1 AND day=$2 AND kind='activity' AND NOT source_deleted AND NOT(key=ANY($3::text[]))`, [data.device_id, day.date, keys]);
    // A restored activity must include its content; the manifest marks deleted items.
    await db.query('INSERT INTO notion_days VALUES($1,$2,$3) ON CONFLICT(device_id,day) DO UPDATE SET source_hash=EXCLUDED.source_hash', [data.device_id, day.date, day.source_hash]);
  }
  for (const [kind, docs] of [['daily', data.dailies], ['weekly', data.weeks]] as const) for (const doc of docs)
    await enqueue(db, `${data.device_id}:${kind}:${doc.date}`, data.device_id, kind, doc.date, doc.source_hash, doc.document, doc.document === null);
}
export async function backfill(db: PoolClient) {
  // SQL avoids loading an entire archive into process memory. Preserve newer relay data.
  await db.query(`INSERT INTO notion_items(key,device_id,kind,day,source_hash,payload,source_deleted,source_updated_at)
    SELECT device_id::text||':activity:'||record_id,device_id,'activity',day,content_hash,payload,source_deleted,updated_at FROM activities
    ON CONFLICT(key) DO UPDATE SET day=EXCLUDED.day,source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,
      source_deleted=EXCLUDED.source_deleted,dirty=true,version=notion_items.version+1,attempts=0,next_attempt_at=now(),last_error=NULL,source_updated_at=EXCLUDED.source_updated_at
    WHERE notion_items.source_updated_at<=EXCLUDED.source_updated_at AND (notion_items.source_hash<>EXCLUDED.source_hash OR notion_items.source_deleted<>EXCLUDED.source_deleted)`);
  await db.query(`INSERT INTO notion_items(key,device_id,kind,day,source_hash,payload,source_deleted,source_updated_at)
    SELECT device_id::text||':'||kind||':'||day,device_id,kind,day,source_hash,payload,payload IS NULL,updated_at FROM documents
    ON CONFLICT(key) DO UPDATE SET source_hash=EXCLUDED.source_hash,payload=EXCLUDED.payload,source_deleted=EXCLUDED.source_deleted,
      dirty=true,version=notion_items.version+1,attempts=0,next_attempt_at=now(),last_error=NULL,source_updated_at=EXCLUDED.source_updated_at
    WHERE notion_items.source_updated_at<=EXCLUDED.source_updated_at AND (notion_items.source_hash<>EXCLUDED.source_hash OR notion_items.source_deleted<>EXCLUDED.source_deleted)`);
  await db.query(`INSERT INTO notion_days SELECT * FROM source_days ON CONFLICT(device_id,day) DO UPDATE SET source_hash=EXCLUDED.source_hash`);
}

export function createNotionSync(pool: Pool, config: Config, api = new NotionAPI()) {
  let running: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const settings = notionSettings(config);
  const oauth = async (db: Pool | PoolClient, body: unknown, path = 'token') => {
    const n = await settings.get(db);
    if (!n) throw failure(409, '请先在网页填写 Notion 连接信息');
    return api.request(`oauth/${path}`, `Basic ${Buffer.from(`${n.clientId}:${n.clientSecret}`).toString('base64')}`, 'POST', body);
  };
  async function call(db: PoolClient, path: string, method = 'GET', body?: unknown) {
    const n = await settings.get(db);
    if (!n) throw failure(409, '请先在网页填写 Notion 连接信息');
    const connection = (await db.query('SELECT credentials FROM notion_connection WHERE id=1')).rows[0];
    if (!connection) throw failure(409, '请先授权 Notion');
    const tokens = decryptTokens(connection.credentials, n.encryptionKey);
    try { return await api.request(path, `Bearer ${tokens.access_token}`, method, body); }
    catch (error) {
      if (!(error instanceof NotionError) || error.status !== 401 || !tokens.refresh_token) throw error;
      const refreshed = await oauth(db, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      if (!refreshed.access_token || !refreshed.refresh_token) throw new NotionError(401);
      await db.query('UPDATE notion_connection SET credentials=$1 WHERE id=1', [encryptTokens({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token }, n.encryptionKey)]);
      return api.request(path, `Bearer ${refreshed.access_token}`, method, body);
    }
  }
  async function run() {
    if (stopped) return;
    const db = await pool.connect(); let locked = false;
    try {
      locked = (await db.query('SELECT pg_try_advisory_lock($1) AS locked', [NOTION_LOCK])).rows[0].locked;
      if (!locked) return;
      const prefs = await preferences(db);
      const connection = (await db.query('SELECT * FROM notion_connection WHERE id=1')).rows[0];
      if (!prefs.notion_enabled || !connection?.data_source_id || (connection.retry_at && new Date(connection.retry_at).getTime() > Date.now())) return;
      const item = (await db.query(`SELECT n.*,n.day::text AS day,d.name AS device_name FROM notion_items n JOIN devices d ON n.device_id=d.id
        WHERE dirty AND next_attempt_at<=now() ORDER BY next_attempt_at,key LIMIT 1`)).rows[0];
      if (!item) return;
      try {
        let pageId = item.page_id;
        if (!pageId) {
          // Recover a create whose response or local acknowledgement was lost.
          const found = await call(db, `data_sources/${connection.data_source_id}/query`, 'POST', {
            filter: { property: 'Dayflow ID', rich_text: { equals: item.key } }, page_size: 2,
          });
          pageId = found.results?.[0]?.id;
          if (!pageId && item.payload !== null) {
            const created = await call(db, 'pages', 'POST', { parent: { type: 'data_source_id', data_source_id: connection.data_source_id },
              properties: { Name: { title: richText(item.payload.title || `${item.kind === 'daily' ? '日报' : item.kind === 'weekly' ? '周报' : '活动'} · ${item.day}`) },
                'Dayflow ID': { rich_text: richText(item.key) } } });
            pageId = created.id;
            if (!pageId) throw new NotionError(503);
          }
          if (pageId) await db.query('UPDATE notion_items SET page_id=$2 WHERE key=$1', [item.key, pageId]);
        }
        if (pageId) {
          const p = item.payload;
          const properties: Record<string, unknown> = { 源端已删除: { checkbox: item.source_deleted } };
          if (p !== null) Object.assign(properties, {
            Name: { title: richText(p.title || `${item.kind === 'daily' ? '日报' : item.kind === 'weekly' ? '周报' : '活动'} · ${item.day}`) },
            类型: { select: { name: item.kind === 'activity' ? '活动' : item.kind === 'daily' ? '日报' : '周报' } },
            日期: { date: { start: item.day } }, 设备: { rich_text: richText(item.device_name) },
            分类: { rich_text: richText(p.category || '') }, 时长: { number: p.duration_minutes ?? p.tracked_minutes ?? null },
          });
          await call(db, `pages/${pageId}`, 'PATCH', { properties });
          if (p !== null) {
            const content = item.kind === 'activity'
              ? `${p.title}\n\n${p.start} → ${p.end}\n${p.category}${p.subcategory ? ` / ${p.subcategory}` : ''} · ${p.duration_minutes} 分钟\n应用：${p.apps.join('、')}\n\n摘要\n${p.summary}\n\n详细记录\n${p.detailed_summary}`
              : formatDocument(p);
            // Deterministic paragraph replacement is safe to replay, preserves long
            // source bodies and bounds every request well below Notion's 500 KB limit.
            const chunks = splitText(content, 12000);
            const blocks: any[] = []; let cursor: string | undefined;
            do {
              const result = await call(db, `blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
              blocks.push(...result.results); cursor = result.has_more ? result.next_cursor : undefined;
            } while (cursor);
            // These pages are explicitly managed by the sync. User notes belong outside them.
            for (let i = 0; i < chunks.length; i++) {
              const paragraph = { rich_text: richText(chunks[i]) };
              if (blocks[i]?.type === 'paragraph') await call(db, `blocks/${blocks[i].id}`, 'PATCH', { paragraph });
              else {
                if (blocks[i]) throw new NotionError(400); // Avoid destroying manually added structures.
                await call(db, `blocks/${pageId}/children`, 'PATCH', { children: [{ object: 'block', type: 'paragraph', paragraph }] });
              }
            }
            for (const block of blocks.slice(chunks.length)) {
              if (block.type !== 'paragraph') throw new NotionError(400);
              await call(db, `blocks/${block.id}`, 'DELETE');
            }
          }
        }
        // New uploads may have superseded this snapshot while network I/O ran.
        await db.query(`UPDATE notion_items SET payload=NULL,dirty=false,attempts=0,last_error=NULL,synced_at=now() WHERE key=$1 AND version=$2`, [item.key, item.version]);
        await db.query('UPDATE notion_connection SET last_success_at=now(),last_error=NULL,retry_at=NULL WHERE id=1');
      } catch (error) {
        const safe = error instanceof NotionError ? error : new NotionError(503);
        const seconds = Math.max(safe.retryAfter, Math.min(3600, 30 * 2 ** Math.min(item.attempts, 7)));
        await db.query(`UPDATE notion_items SET attempts=attempts+1,last_error=$3,next_attempt_at=now()+($4*interval '1 second') WHERE key=$1 AND version=$2`, [item.key, item.version, safe.message, seconds]);
        await db.query(`UPDATE notion_connection SET last_error=$1,retry_at=now()+($2*interval '1 second') WHERE id=1`, [safe.message, seconds]);
      }
    } finally { if (locked) await db.query('SELECT pg_advisory_unlock($1)', [NOTION_LOCK]); db.release(); }
  }
  const tick = () => {
    if (running) return running;
    running = run().finally(() => { running = undefined; });
    return running;
  };
  return { call, oauth, tick, settings,
    start() { if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, 2000); timer.unref(); } },
    async stop() { stopped = true; if (timer) clearInterval(timer); await running; },
  };
}

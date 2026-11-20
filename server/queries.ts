import type { Pool } from 'pg';
import { z } from 'zod';
import { date as dateSchema, lobehubSettingsInput } from './contracts.ts';

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
export const rowActivity = (row: any) => ({ ...row.payload, device_id: row.device_id, day: row.day,
  source_deleted: row.source_deleted, has_screenshot: Boolean(row.screenshot_hash), updated_at: row.updated_at });

export async function getOverview(pool: Pool, date?: string) {
  const devices = (await pool.query('SELECT * FROM devices ORDER BY last_sync_at DESC NULLS LAST')).rows;
  const primary = devices[0];
  const today = todayInZone(primary?.time_zone || 'Asia/Shanghai', primary?.day_boundary_hour ?? 4);
  const day = date || today;
  const [days, totals, docs, briefExists] = await Promise.all([
    pool.query('SELECT DISTINCT day::text FROM activities WHERE NOT source_deleted ORDER BY day DESC'),
    pool.query(`SELECT payload->>'category' AS category, sum((payload->>'duration_minutes')::numeric)::float8 AS minutes,
      count(*)::integer AS count FROM activities WHERE day=$1 AND NOT source_deleted GROUP BY payload->>'category' ORDER BY minutes DESC`, [day]),
    pool.query(`SELECT kind,payload FROM documents WHERE device_id=$1 AND ((kind='daily' AND day=$2) OR (kind='weekly' AND day=$3))`, [primary?.id || '00000000-0000-0000-0000-000000000000', day, monday(day)]),
    pool.query('SELECT EXISTS(SELECT 1 FROM daily_briefs WHERE day=$1) AS has_brief', [day]),
  ]);
  return { date: day, today, time_zone: primary?.time_zone || 'Asia/Shanghai', day_boundary_hour: primary?.day_boundary_hour ?? 4,
    available_days: days.rows.map(r => r.day), devices, categories: primary?.categories || [],
    totals: totals.rows, daily: docs.rows.find(r => r.kind === 'daily')?.payload || null,
    weekly: docs.rows.find(r => r.kind === 'weekly')?.payload || null,
    has_daily_brief: Boolean(briefExists.rows[0]?.has_brief) };
}

export const activityFilters = {
  date: dateSchema.optional(), from: dateSchema.optional(), to: dateSchema.optional(),
  q: z.string().max(500).optional(), category: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30),
};
export type ActivityQuery = z.infer<z.ZodObject<typeof activityFilters>> & { include_deleted: boolean };

export async function searchActivities(pool: Pool, query: ActivityQuery) {
  const values: unknown[] = []; const clauses = ['TRUE'];
  const condition = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
  if (query.date) condition('day=?', query.date);
  if (query.from) condition('day>=?', query.from);
  if (query.to) condition('day<=?', query.to);
  if (query.category) condition("payload->>'category'=?", query.category);
  if (!query.include_deleted) clauses.push('NOT source_deleted');
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
}

export async function getActivity(pool: Pool, device: string, record: number) {
  const result = await pool.query('SELECT *,day::text FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
  return result.rowCount ? rowActivity(result.rows[0]) : null;
}

export async function getScreenshotHash(pool: Pool, device: string, record: number): Promise<string | undefined> {
  const result = await pool.query('SELECT screenshot_hash FROM activities WHERE device_id=$1 AND record_id=$2', [device, record]);
  return result.rows[0]?.screenshot_hash || undefined;
}

export async function summarizeTime(pool: Pool, from: string, to: string, groupBy: 'day' | 'category') {
  const key = groupBy === 'day' ? 'day::text' : "payload->>'category'";
  const result = await pool.query(`SELECT ${key} AS ${groupBy}, sum((payload->>'duration_minutes')::numeric)::float8 AS minutes,
    count(*)::integer AS count FROM activities WHERE day>=$1 AND day<=$2 AND NOT source_deleted
    GROUP BY 1 ORDER BY ${groupBy === 'day' ? '1 ASC' : 'minutes DESC'}`, [from, to]);
  return { from, to, group_by: groupBy, groups: result.rows,
    total_minutes: result.rows.reduce((sum, row) => sum + row.minutes, 0) };
}

export async function getDailyBrief(pool: Pool, date?: string) {
  const devices = (await pool.query('SELECT time_zone, day_boundary_hour FROM devices ORDER BY last_sync_at DESC NULLS LAST LIMIT 1')).rows;
  const primary = devices[0];
  const today = todayInZone(primary?.time_zone || 'Asia/Shanghai', primary?.day_boundary_hour ?? 4);
  const day = date || today;
  const [days, briefs] = await Promise.all([
    pool.query('SELECT DISTINCT day::text FROM daily_briefs ORDER BY day DESC'),
    pool.query(`SELECT device_id, day::text, source_day::text, source, generated_at, content, user_state, stats, updated_at
      FROM daily_briefs WHERE day=$1 ORDER BY updated_at DESC LIMIT 1`, [day]),
  ]);
  const row = briefs.rows[0];
  let brief = null;
  if (row) {
    const imgs = await pool.query('SELECT file_name FROM daily_brief_images WHERE device_id=$1 AND day=$2 ORDER BY file_name', [row.device_id, row.day]);
    brief = { ...row, images: imgs.rows.map(r => r.file_name) };
  }
  return {
    date: day,
    today,
    time_zone: primary?.time_zone || 'Asia/Shanghai',
    day_boundary_hour: primary?.day_boundary_hour ?? 4,
    available_days: days.rows.map(r => r.day),
    brief,
  };
}

export async function listDailyBriefs(pool: Pool, options: { from?: string; to?: string; limit: number }) {
  const values: unknown[] = [];
  const clauses = ['TRUE'];
  const condition = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
  if (options.from) condition('day>=?', options.from);
  if (options.to) condition('day<=?', options.to);
  values.push(options.limit);
  const result = await pool.query(`SELECT DISTINCT ON (day) device_id, day::text, source_day::text, source, generated_at, content, user_state
    FROM daily_briefs WHERE ${clauses.join(' AND ')} ORDER BY day DESC, updated_at DESC LIMIT $${values.length}`, values);
  return result.rows.map(row => {
    const content = row.content || {};
    const docket: { title?: string }[] = Array.isArray(content.docket) ? content.docket : [];
    const handoffs: { title?: string; dismissed?: boolean; reviewed?: boolean; failed?: boolean; method?: string; finishedAt?: string }[] =
      Array.isArray(row.user_state?.handoffs) ? row.user_state.handoffs : [];
    const statuses: Record<string, number> = {};
    for (const item of docket) {
      const last = [...handoffs].reverse().find(h => h.title === item.title);
      const status = !last ? 'new'
        : last.dismissed ? 'dismissed'
        : last.reviewed ? 'reviewed'
        : last.failed ? 'failed'
        : last.method === 'run' && last.finishedAt ? 'ready'
        : 'in_progress';
      statuses[status] = (statuses[status] || 0) + 1;
    }
    const order: string[] = Array.isArray(content.order) ? content.order : [];
    return {
      device_id: row.device_id,
      day: row.day,
      source_day: row.source_day,
      source: row.source,
      generated_at: row.generated_at,
      sections: order,
      docket_count: docket.length,
      docket_statuses: statuses,
    };
  });
}

export async function getDailyBriefImageHash(pool: Pool, device: string, day: string, fileName: string): Promise<string | undefined> {
  const result = await pool.query('SELECT image_hash FROM daily_brief_images WHERE device_id=$1 AND day=$2 AND file_name=$3', [device, day, fileName]);
  return result.rows[0]?.image_hash || undefined;
}

export async function getLobehubSettings(pool: Pool) {
  const result = await pool.query('SELECT base_url, default_assistant_id, handoff_mode, assistants FROM lobehub_settings WHERE id=1');
  const row = result.rows[0];
  return row ? {
    base_url: row.base_url,
    default_assistant_id: row.default_assistant_id,
    handoff_mode: row.handoff_mode,
    assistants: Array.isArray(row.assistants) ? row.assistants : [],
  } : { base_url: 'https://chat.neo7.cn', default_assistant_id: '', handoff_mode: 'auto_send', assistants: [] };
}

export async function saveLobehubSettings(pool: Pool, input: z.infer<typeof lobehubSettingsInput>) {
  await pool.query(`INSERT INTO lobehub_settings(id, base_url, default_assistant_id, handoff_mode, assistants, updated_at)
    VALUES(1, $1, $2, $3, $4, now())
    ON CONFLICT(id) DO UPDATE SET base_url=EXCLUDED.base_url, default_assistant_id=EXCLUDED.default_assistant_id,
      handoff_mode=EXCLUDED.handoff_mode, assistants=EXCLUDED.assistants, updated_at=now()`,
  [input.base_url, input.default_assistant_id, input.handoff_mode, JSON.stringify(input.assistants)]);
  return getLobehubSettings(pool);
}

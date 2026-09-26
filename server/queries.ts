import type { Pool } from 'pg';
import { z } from 'zod';
import { date as dateSchema } from './contracts.ts';

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

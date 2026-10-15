import { z } from 'zod';

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, 'Invalid date');
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const activity = z.object({
  record_id: identifier, title: z.string().max(10000), summary: z.string().max(100000).default(''),
  detailed_summary: z.string().max(500000).default(''), category: z.string().max(500),
  subcategory: z.string().max(500).default(''), apps: z.array(z.string().max(2000)).max(100).default([]),
  start: timestamp, end: timestamp, duration_minutes: z.number().nonnegative(),
}).refine(value => new Date(value.end) >= new Date(value.start), 'End precedes start');
const category = z.object({ name: z.string().max(500), color_hex: z.string().regex(/^#[a-fA-F0-9]{6}$/), is_idle: z.boolean(), is_system: z.boolean() });
const document = z.object({ date, source_hash: hash, document: z.record(z.string(), z.unknown()).nullable() });
export const batch = z.object({
  device_id: z.uuid().toLowerCase(), device_name: z.string().min(1).max(200), batch_id: z.uuid(),
  expected_revision: z.number().int().nonnegative(),
  time_zone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  day_boundary_hour: z.number().int().min(0).max(23),
  status: z.record(z.string(), z.unknown()), categories: z.array(category).max(500),
  days: z.array(z.object({
    date, source_hash: hash, active_ids: z.array(identifier).max(10000),
    activities: z.array(z.object({ content_hash: hash, data: activity })).max(10000),
  })).max(31),
  dailies: z.array(document).max(31), weeks: z.array(document).max(31),
}).superRefine((value, ctx) => {
  const days = new Set<string>(); const records = new Set<number>();
  for (const day of value.days) {
    if (days.has(day.date)) ctx.addIssue({ code: 'custom', message: 'Duplicate day' });
    days.add(day.date);
    const active = new Set(day.active_ids);
    if (active.size !== day.active_ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate active ID' });
    for (const id of active) {
      if (records.has(id)) ctx.addIssue({ code: 'custom', message: 'Record appears in multiple days' });
      records.add(id);
    }
    const changed = new Set<number>();
    for (const item of day.activities) {
      if (!active.has(item.data.record_id) || changed.has(item.data.record_id)) ctx.addIssue({ code: 'custom', message: 'Invalid changed record ID' });
      changed.add(item.data.record_id);
    }
  }
});

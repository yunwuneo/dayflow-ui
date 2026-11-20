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
export const briefFileName = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(value => !value.includes('..'), 'Invalid file name');
export const dailyBriefSyncItem = z.object({
  date,
  source_day: date,
  generated_at: timestamp,
  source_hash: hash,
  content: z.record(z.string(), z.unknown()),
  user_state: z.record(z.string(), z.unknown()).default({}),
  stats: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const lobehubAssistant = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  agent_id: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, '助理标识仅支持字母、数字、点、下划线和连字符'),
});
export const lobehubSettingsInput = z.object({
  base_url: z.string().trim().min(1).max(500).refine(value => {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.host);
    } catch { return false; }
  }, 'LobeHub 地址须为有效的 HTTP/HTTPS 地址').transform(value => {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }),
  default_assistant_id: z.string().trim().max(100).default(''),
  handoff_mode: z.enum(['auto_send', 'copy_open']).default('auto_send'),
  assistants: z.array(lobehubAssistant).max(50).default([]),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const item of value.assistants) {
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', message: '助理 ID 不能重复' });
    ids.add(item.id);
  }
  if (value.default_assistant_id && !ids.has(value.default_assistant_id)) {
    ctx.addIssue({ code: 'custom', message: '默认助理必须存在于助理列表中' });
  }
});
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
  daily_briefs: z.array(dailyBriefSyncItem).max(31).default([]),
}).superRefine((value, ctx) => {
  const days = new Set<string>(); const records = new Set<number>();
  const briefDays = new Set<string>();
  for (const item of value.daily_briefs) {
    if (briefDays.has(item.date)) ctx.addIssue({ code: 'custom', message: 'Duplicate brief day' });
    briefDays.add(item.date);
  }
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

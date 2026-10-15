import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { digest } from '../server/security.ts';
import { fixtureConfig } from '../tests/isolation.ts';
import sharp from 'sharp';

const storage = `${process.env.DAYFLOW_TEST_ROOT}/screenshots`;
await mkdir(storage);
const app = await createApp(fixtureConfig(storage));
// Select a free local port before setting the canonical origin. The fixture never uses .env.
const address = await app.listen({ host: '127.0.0.1', port: 0 });
await app.close();
const config = fixtureConfig(storage, undefined, address);
const server = await createApp(config);
const device = randomUUID(); const day = '2026-09-16';
const card = { record_id: 42, title: '虚构项目演示', category: '编程', start: `${day}T09:00:00+08:00`, end: `${day}T10:00:00+08:00`,
  summary: '虚构项目完成', detailed_summary: '隔离测试数据', subcategory: '', apps: ['Fictional App'], duration_minutes: 60 };
const batch = { device_id: device, device_name: 'Fictional Mac', expected_revision: 0, batch_id: randomUUID(), time_zone: 'Asia/Shanghai', day_boundary_hour: 4,
  status: { last_capture_at: card.end, pending_batches: 0 }, categories: [{ name: '编程', color_hex: '#449977', is_idle: false, is_system: false }],
  days: [{ date: day, source_hash: digest('fictional-day'), active_ids: [42], activities: [{ content_hash: digest(JSON.stringify(card)), data: card }] }],
  dailies: [{ date: day, source_hash: digest('fictional-daily'), document: { date: day, highlights: ['虚构项目完成'], tasks: [], blockers: '' } }], weeks: [{ date: '2026-09-14', source_hash: digest('fictional-weekly'), document: {
    week_start: '2026-09-14', week_end: '2026-09-21', tracked_minutes: 60, focus_minutes: 60,
    categories: [{ name: '编程', minutes: 60, share: 1 }], days: [],
  } }] };
const uploaded = await server.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: { authorization: `Bearer ${config.syncToken}` }, payload: batch });
if (uploaded.statusCode !== 200) throw new Error(uploaded.body);
const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#449977' } }).jpeg().toBuffer();
const screenshot = await server.inject({ method: 'PUT', url: `/api/v1/sync/activities/${device}/42/screenshot`, headers: { authorization: `Bearer ${config.syncToken}`, 'content-type': 'image/jpeg' }, payload: image });
if (screenshot.statusCode !== 200) throw new Error(screenshot.body);
await server.listen({ host: '127.0.0.1', port: Number(new URL(address).port) });
console.log(`ISOLATED_ORIGIN=${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await server.close(); process.exit(0); });

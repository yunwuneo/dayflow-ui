import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createApp, todayInZone } from '../server/app.ts';
import { digest } from '../server/security.ts';

test('Dayflow day boundary respects local calendar and DST', () => {
  assert.equal(todayInZone('Asia/Shanghai', 4, new Date('2026-09-16T19:59:00Z')), '2026-09-16');
  assert.equal(todayInZone('Asia/Shanghai', 4, new Date('2026-09-16T20:00:00Z')), '2026-09-17');
  assert.equal(todayInZone('America/New_York', 4, new Date('2026-03-08T07:30:00Z')), '2026-03-07');
});

test('Authenticated sync, reconciliation, archive and screenshot lifecycle', async t => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('options', `-c search_path=${schema}`);
  const storage = await mkdtemp(path.join(tmpdir(), 'dayflow-tests-'));
  const config = { databaseUrl: url.toString(), storageDir: storage, adminUsername: 'test', adminPassword: 'a-long-test-password',
    syncToken: 's'.repeat(48), readToken: 'r'.repeat(48), publicOrigin: 'http://127.0.0.1:4310', production: false, trustProxy: false, logger: false };
  const app = await createApp(config);
  t.after(async () => { await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true }); });
  const device = randomUUID(); const day = '2026-09-16';
  const syncHeaders = { authorization: `Bearer ${config.syncToken}` };
  const readHeaders = { authorization: `Bearer ${config.readToken}` };
  const card = { record_id: 42, title: '设计同步服务', category: '编程', start: `${day}T09:00:00+08:00`, end: `${day}T10:00:00+08:00`,
    summary: '完成 Dayflow 接入', detailed_summary: '中文全文检索详情 100%_complete', subcategory: '', apps: ['Terminal'], duration_minutes: 60 };
  const base = { device_id: device, device_name: 'Test Mac', expected_revision: 0, batch_id: randomUUID(), time_zone: 'Asia/Shanghai', day_boundary_hour: 4,
    status: { last_capture_at: card.end, pending_batches: 0 }, categories: [{ name: '编程', color_hex: '#449977', is_idle: false, is_system: false }],
    days: [{ date: day, source_hash: digest('source-v1'), active_ids: [42], activities: [{ content_hash: digest(JSON.stringify(card)), data: card }] }],
    dailies: [{ date: day, source_hash: digest('daily'), document: { date: day, highlights: ['完成同步'], tasks: [], blockers: '' } }], weeks: [] };

  await t.test('No unauthenticated data or screenshots; separate token scopes', async () => {
    assert.equal((await app.inject('/api/v1/overview')).statusCode, 401);
    assert.equal((await app.inject(`/api/v1/activities/${device}/42/screenshot`)).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/overview', headers: syncHeaders })).statusCode, 401);
    assert.equal((await app.inject({ url: `/api/v1/sync/state?device_id=${device}`, headers: readHeaders })).statusCode, 401);
  });
  let session = '';
  await t.test('Login requires CSRF header and trusted origin; cookie is HttpOnly', async () => {
    const payload = { username: 'test', password: config.adminPassword };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers: { 'x-dayflow-request': '1', origin: 'https://attacker.example' } })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload, headers: { 'x-dayflow-request': '1', origin: config.publicOrigin } });
    assert.equal(response.statusCode, 200);
    const cookie = String(response.headers['set-cookie']); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    session = cookie.split(';')[0];
    assert.equal((await app.inject({ url: '/api/v1/overview', headers: { cookie: session } })).statusCode, 200);
  });
  await t.test('Production HTTP cookies support internal login; HTTPS cookies stay Secure', async t => {
    t.mock.method(globalThis, 'fetch', async (input: string | URL) => new Response(JSON.stringify(
      new URL(input).pathname === '/api/login/oauth/access_token'
        ? { access_token: 'test-access-token' } : { sub: 'test-casdoor-subject', displayName: 'Test' },
    ), { headers: { 'content-type': 'application/json' } }));
    for (const publicOrigin of ['http://192.168.1.10:4310', 'http://100.64.1.10:4310', 'https://dayflow.example.com']) {
      const productionApp = await createApp({ ...config, production: true, publicOrigin,
        casdoor: { origin: 'https://auth.example.com', clientId: 'test', clientSecret: 'test-secret',
          redirectUri: `${publicOrigin}/api/v1/auth/casdoor/callback` } });
      try {
        const login = await productionApp.inject({ method: 'POST', url: '/api/v1/auth/login',
          payload: { username: config.adminUsername, password: config.adminPassword },
          headers: { 'x-dayflow-request': '1', origin: publicOrigin, host: 'attacker.example' } });
        assert.equal(login.statusCode, 200, login.body);
        const loginCookie = String(login.headers['set-cookie']);
        const secure = publicOrigin.startsWith('https://');
        assert.equal(/; Secure(?:;|$)/.test(loginCookie), secure);
        assert.match(loginCookie, /HttpOnly/);
        assert.match(loginCookie, /SameSite=Strict/);
        assert.equal((await productionApp.inject({ url: '/api/v1/auth/session',
          headers: { cookie: loginCookie.split(';')[0] } })).statusCode, 200);
        const oauth = await productionApp.inject('/api/v1/auth/casdoor/start');
        assert.equal(oauth.statusCode, 302);
        assert.equal(/; Secure(?:;|$)/.test(String(oauth.headers['set-cookie'])), secure);
        const state = new URL(String(oauth.headers.location)).searchParams.get('state');
        const callback = await productionApp.inject({ url: `/api/v1/auth/casdoor/callback?code=test-code&state=${state}`,
          headers: { cookie: String(oauth.headers['set-cookie']).split(';')[0] } });
        assert.equal(callback.statusCode, 302, callback.body);
        const pendingCookie = String(callback.headers['set-cookie']);
        assert.match(pendingCookie, /casdoor_pending=/);
        assert.equal(/casdoor_pending=[^,]*; Secure(?:;|$)/.test(pendingCookie), secure);
      } finally { await productionApp.close(); }
    }
  });
  await t.test('First batch and replay are idempotent; old revisions conflict', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: base });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().revision, 1);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: base });
    assert.equal(replay.json().replayed, true);
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: { ...base, batch_id: randomUUID() } });
    assert.equal(conflict.statusCode, 409);
    const activities = (await app.inject({ url: `/api/v1/activities?date=${day}`, headers: readHeaders })).json();
    assert.equal(activities.total, 1);
  });
  await t.test('Missing active records roll back the entire batch', async () => {
    const invalid = { ...base, batch_id: randomUUID(), expected_revision: 1, days: [{ ...base.days[0], active_ids: [42, 999], activities: [] }] };
    const response = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: invalid });
    assert.equal(response.statusCode, 400);
    assert.equal((await app.inject({ url: `/api/v1/sync/state?device_id=${device}`, headers: syncHeaders })).json().revision, 1);
  });
  await t.test('Startup rejects an existing unwritable screenshot directory', { skip: process.getuid?.() === 0 }, async () => {
    await chmod(storage, 0o500);
    try {
      await assert.rejects(createApp(config), /截图存储目录不可写.*EACCES/);
    } finally { await chmod(storage, 0o700); }
    assert.equal((await readdir(storage)).length, 0, 'Storage checks must not leave probe files');
  });
  await t.test('Unwritable screenshot storage reports the cause and leaves uploads retryable', { skip: process.getuid?.() === 0 }, async () => {
    const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#558866' } }).jpeg().toBuffer();
    await chmod(storage, 0o500);
    try {
      const response = await app.inject({ method: 'PUT', url: `/api/v1/sync/activities/${device}/42/screenshot`,
        headers: { ...syncHeaders, 'content-type': 'image/jpeg' }, payload: image });
      assert.equal(response.statusCode, 503, response.body);
      assert.match(response.json().error, /截图存储目录不可写/);
      assert.match(response.json().error, /EACCES/);
      assert.ok(!response.body.includes(storage), 'Do not expose server filesystem paths');
      const state = (await app.inject({ url: `/api/v1/sync/state?device_id=${device}`, headers: syncHeaders })).json();
      assert.equal(state.activities[0].has_screenshot, false);
      assert.equal((await readdir(storage)).length, 0);
    } finally { await chmod(storage, 0o700); }
  });
  await t.test('Screenshot is decoded, protected, and retained once', async () => {
    const route = `/api/v1/sync/activities/${device}/42/screenshot`;
    const invalid = await app.inject({ method: 'PUT', url: route, headers: { ...syncHeaders, 'content-type': 'image/jpeg' }, payload: Buffer.from('bad') });
    assert.equal(invalid.statusCode, 400);
    const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#558866' } }).jpeg().toBuffer();
    assert.equal((await app.inject({ method: 'PUT', url: route, headers: { ...syncHeaders, 'content-type': 'image/jpeg' }, payload: image })).statusCode, 200);
    const read = await app.inject({ url: `/api/v1/activities/${device}/42/screenshot`, headers: { cookie: session } });
    assert.equal(read.statusCode, 200); assert.match(String(read.headers['content-type']), /image\/jpeg/);
    await app.inject({ method: 'PUT', url: route, headers: { ...syncHeaders, 'content-type': 'image/jpeg' }, payload: image });
    assert.equal((await readdir(storage)).length, 1);
  });
  await t.test('Only changed content is upserted; unchanged day can carry no cards', async () => {
    const update = { ...base, batch_id: randomUUID(), expected_revision: 1, days: [{ ...base.days[0], activities: [] }], dailies: [] };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: update })).statusCode, 200);
    const overview = (await app.inject({ url: `/api/v1/overview?date=${day}`, headers: readHeaders })).json();
    assert.equal(overview.totals[0].minutes, 60); assert.equal(overview.daily.highlights[0], '完成同步');
  });
  await t.test('MCP endpoint accepts only the read token and exposes read-only tools', async () => {
    const mcpHeaders = { ...readHeaders, accept: 'application/json, text/event-stream' };
    const rpc = async (method: string, params: object, headers: Record<string, string> = mcpHeaders) =>
      app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method, params } });
    const call = async (name: string, args: object) => (await rpc('tools/call', { name, arguments: args })).json().result;
    assert.equal((await rpc('tools/list', {}, { accept: mcpHeaders.accept })).statusCode, 401);
    assert.equal((await rpc('tools/list', {}, { ...syncHeaders, accept: mcpHeaders.accept })).statusCode, 401);
    assert.equal((await rpc('tools/list', {}, { cookie: session, accept: mcpHeaders.accept })).statusCode, 401);
    assert.equal((await app.inject({ url: '/mcp', headers: readHeaders })).statusCode, 405);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.statusCode, 200, init.body); assert.equal(init.json().result.serverInfo.name, 'dayflow');
    const tools = (await rpc('tools/list', {})).json().result.tools;
    assert.deepEqual(tools.map((tool: any) => tool.name).sort(), ['get_activity', 'get_overview', 'get_screenshot', 'search_activities', 'summarize_time']);
    assert.ok(tools.every((tool: any) => tool.annotations.readOnlyHint));
    const overview = JSON.parse((await call('get_overview', { date: day })).content[0].text);
    assert.equal(overview.daily.highlights[0], '完成同步');
    const found = JSON.parse((await call('search_activities', { q: '全文检索' })).content[0].text);
    assert.equal(found.total, 1); assert.equal(found.activities[0].title, card.title); assert.equal(found.activities[0].detailed_summary, undefined);
    const detail = JSON.parse((await call('get_activity', { device_id: device, record_id: 42 })).content[0].text);
    assert.equal(detail.detailed_summary, card.detailed_summary);
    assert.equal((await call('get_activity', { device_id: device, record_id: 7 })).isError, true);
    const screenshot = (await call('get_screenshot', { device_id: device, record_id: 42 })).content[0];
    assert.equal(screenshot.type, 'image'); assert.equal(screenshot.mimeType, 'image/jpeg');
    assert.ok((await sharp(Buffer.from(screenshot.data, 'base64')).metadata()).width);
    const summary = JSON.parse((await call('summarize_time', { from: day, to: day, group_by: 'day' })).content[0].text);
    assert.deepEqual(summary.groups, [{ day, minutes: 60, count: 1 }]);
    assert.equal((await call('summarize_time', { from: day, to: '2026-09-01' })).isError, true);
    assert.equal((await call('search_activities', { date: '2026-02-30' })).isError, true);
  });
  await t.test('Source deletion hides active data, keeps archive and screenshot searchable', async () => {
    const deletion = { ...base, batch_id: randomUUID(), expected_revision: 2, days: [{ date: day, source_hash: digest('empty'), active_ids: [], activities: [] }], dailies: [] };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: syncHeaders, payload: deletion })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/v1/activities?date=${day}`, headers: readHeaders })).json().total, 0);
    const archive = (await app.inject({ url: '/api/v1/activities?q=' + encodeURIComponent('全文检索') + '&include_deleted=true', headers: readHeaders })).json();
    assert.equal(archive.total, 1); assert.equal(archive.activities[0].source_deleted, true); assert.equal(archive.activities[0].has_screenshot, true);
    const totals = (await app.inject({ url: `/api/v1/overview?date=${day}`, headers: readHeaders })).json().totals;
    assert.equal(totals.length, 0);
    assert.equal((await app.inject({ url: `/api/v1/activities/${device}/42/screenshot`, headers: readHeaders })).statusCode, 200);
  });
  await t.test('Search treats wildcard characters literally and validates dates', async () => {
    const found = (await app.inject({ url: '/api/v1/activities?include_deleted=true&q=' + encodeURIComponent('100%_complete'), headers: readHeaders })).json();
    assert.equal(found.total, 1);
    assert.equal((await app.inject({ url: '/api/v1/activities?date=2026-02-30', headers: readHeaders })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/activities?page=-1', headers: readHeaders })).statusCode, 400);
  });
  await t.test('Logout revokes the session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: session, 'x-dayflow-request': '1' } });
    assert.equal(response.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/overview', headers: { cookie: session } })).statusCode, 401);
  });
});

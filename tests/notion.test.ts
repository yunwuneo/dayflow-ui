import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../server/app.ts';
import { validateNotion } from '../server/config.ts';
import { digest } from '../server/security.ts';
import { NotionAPI, NotionError, NOTION_VERSION, TEMPLATE_PROPERTIES, decryptTokens, encryptTokens, richText } from '../server/notion-api.ts';
import { createNotionSync } from '../server/notion-sync.ts';
import { fixtureConfig, testDatabaseUrl, verifyTestDatabase } from './isolation.ts';

class FakeNotion extends NotionAPI {
  root = randomUUID(); source = randomUUID(); database = randomUUID();
  pages = new Map<string, { id: string; properties: any; blocks: any[] }>();
  calls: { path: string; method: string; body: any }[] = [];
  databaseCreated = false; loseCreate = false; failNext = 0; expired = false;
  onPageUpdate?: () => Promise<void>;
  override async request(path: string, auth: string, method = 'GET', body?: any): Promise<any> {
    this.calls.push({ path, method, body });
    if (path === 'oauth/token') {
      if (body.grant_type === 'refresh_token') { this.expired = false; return { access_token: 'refreshed-secret', refresh_token: 'rotated-refresh' }; }
      return { access_token: 'fictional-secret', refresh_token: 'fictional-refresh', workspace_id: 'workspace', workspace_name: '虚构工作区', bot_id: 'bot', duplicated_template_id: this.root };
    }
    if (path === 'oauth/revoke') return {};
    if (this.expired && auth === 'Bearer fictional-secret') throw new NotionError(401);
    if (this.failNext) { const status = this.failNext; this.failNext = 0; throw new NotionError(status, 120); }
    if (path === 'search') return { results: [{ id: this.root, properties: { title: { type: 'title', title: [{ plain_text: '开发者模板' }] } } }], has_more: false };
    if (path === `pages/${this.root}`) return { id: this.root, in_trash: false };
    if (path.startsWith(`blocks/${this.root}/children`)) return { results: this.databaseCreated ? [{ id: this.database, type: 'child_database', child_database: { title: 'Dayflow 同步记录' } }] : [], has_more: false };
    if (path === 'databases') { this.databaseCreated = true; return { id: this.database, data_sources: [{ id: this.source }] }; }
    if (path === `databases/${this.database}`) return { data_sources: [{ id: this.source }] };
    if (path === `data_sources/${this.source}`) return { properties: Object.fromEntries(Object.entries(TEMPLATE_PROPERTIES).map(([name, p]) => [name, { type: Object.keys(p)[0] }])) };
    if (path === `data_sources/${this.source}/query`) return { results: [...this.pages.values()].filter(p => p.properties['Dayflow ID'].rich_text[0].text.content === body.filter.rich_text.equals) };
    if (path === 'pages') {
      assert.deepEqual(body.parent, { type: 'data_source_id', data_source_id: this.source });
      const page = { id: randomUUID(), properties: body.properties, blocks: [] }; this.pages.set(page.id, page);
      if (this.loseCreate) { this.loseCreate = false; throw new NotionError(503); }
      return page;
    }
    const page = this.pages.get(path.split('/')[1]);
    if (page && path.startsWith('pages/') && method === 'PATCH') {
      if (this.onPageUpdate) { const action = this.onPageUpdate; this.onPageUpdate = undefined; await action(); }
      Object.assign(page.properties, body.properties); return page;
    }
    if (page && path.includes('/children')) {
      if (method === 'PATCH') page.blocks.push(...body.children.map((b: any) => ({ ...b, id: randomUUID() })));
      return { results: structuredClone(page.blocks), has_more: false };
    }
    for (const page of this.pages.values()) {
      const index = page.blocks.findIndex(b => path === `blocks/${b.id}`);
      if (index < 0) continue;
      if (method === 'DELETE') page.blocks.splice(index, 1);
      else Object.assign(page.blocks[index], body);
      return {};
    }
    throw new Error(`Unexpected fictional request ${method} ${path}`);
  }
}

test('Notion transport, encryption, limits and deployment configuration', async () => {
  const key = 'ab'.repeat(32); const tokens = { access_token: 'secret', refresh_token: 'refresh' };
  const encoded = encryptTokens(tokens, key);
  assert.deepEqual(decryptTokens(encoded, key), tokens); assert.ok(!encoded.includes('secret'));
  assert.throws(() => decryptTokens(encoded, 'cd'.repeat(32)));
  assert.equal(richText('😀'.repeat(4000)).map(x => x.text.content).join(''), '😀'.repeat(4000));
  // Notion counts UTF-16 length conservatively; chunks must remain below 2,000.
  const transport = new NotionAPI(async (input, options) => {
    assert.equal(input, 'https://api.notion.com/v1/search');
    assert.equal(new Headers(options?.headers).get('Notion-Version'), NOTION_VERSION);
    assert.equal(options?.redirect, 'error');
    return new Response('{}', { status: 429, headers: { 'Retry-After': '123' } });
  }, 0);
  await assert.rejects(transport.request('search', 'Bearer fictional', 'POST', {}), (e: any) => e.status === 429 && e.retryAfter === 123);
  const config = fixtureConfig('/tmp/unused', 'postgresql://fixture@localhost/unused');
  config.notion = { clientId: 'client', clientSecret: 'secret', encryptionKey: key, redirectUri: `${config.publicOrigin}/api/v1/integrations/notion/callback` };
  assert.doesNotThrow(() => validateNotion(config));
  assert.throws(() => validateNotion({ ...config, production: true }));
  assert.throws(() => validateNotion({ ...config, notion: { ...config.notion!, encryptionKey: 'invalid' } }));
  assert.throws(() => validateNotion({ ...config, notion: { ...config.notion!, redirectUri: 'https://evil.example/callback' } }));
  assert.throws(() => validateNotion({ ...config, notion: { ...config.notion!, templateUrl: 'https://notion.so.evil.test/page' } }));
});

test('Notion OAuth, single-upload routing, durable retry and independent switches', async t => {
  const admin = new Pool({ connectionString: testDatabaseUrl() }); await verifyTestDatabase(admin);
  const schema = `test_notion_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl()); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString() });
  const storage = await mkdtemp(path.join(tmpdir(), 'dayflow-notion-test-'));
  const config = fixtureConfig(storage, url.toString());
  config.notion = { clientId: 'fictional-client', clientSecret: 'fictional-client-secret', encryptionKey: 'ab'.repeat(32),
    redirectUri: `${config.publicOrigin}/api/v1/integrations/notion/callback`, templateUrl: 'https://example.notion.site/template' };
  const fake = new FakeNotion(); const app = await createApp(config, { notionApi: fake, startNotionWorker: false });
  const worker = createNotionSync(pool, config, fake);
  t.after(async () => { await worker.stop(); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dayflow-request': '1' }, payload: { username: config.adminUsername, password: config.adminPassword } });
  const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie, 'x-dayflow-request': '1', origin: config.publicOrigin };
  const deviceHeaders = { authorization: `Bearer ${config.syncToken}` };
  const request = (method: any, route: string, payload?: any) => app.inject({ method, url: `/api/v1/integrations${route}`, headers, ...(payload === undefined ? {} : { payload }) });
  const beginAuth = async () => {
    const response = await request('POST', '/notion/authorize'); assert.equal(response.statusCode, 200);
    return { state: new URL(response.json().url).searchParams.get('state'), cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; ') };
  };
  await t.test('settings require the owner session; callback is one-use, browser/session bound', async () => {
    assert.equal((await request('PUT', '/notion/setup', { client_id: 'other', client_secret: 'fictional' })).statusCode, 409);
    for (const token of [config.syncToken, config.readToken]) assert.equal((await app.inject({ method: 'GET', url: '/api/v1/integrations/sync', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/integrations/sync', headers: { cookie }, payload: { cloud_enabled: false } })).statusCode, 403);
    assert.equal((await request('PATCH', '/sync', { notion_enabled: true })).statusCode, 409);
    const auth = await beginAuth(); const callback = `/api/v1/integrations/notion/callback?state=${auth.state}&code=fictional-code`;
    assert.equal((await app.inject(callback)).statusCode, 400);
    const response = await app.inject({ url: callback, headers: { cookie: auth.cookie } });
    assert.equal(response.statusCode, 302); assert.match(response.headers.location!, /notion=connected/);
    assert.equal((await app.inject({ url: callback, headers: { cookie: auth.cookie } })).statusCode, 400);
    assert.ok(!(await request('GET', '/sync')).body.includes('fictional-secret'));
    const stored = (await pool.query('SELECT credentials FROM notion_connection')).rows[0].credentials;
    assert.ok(!stored.includes('fictional-secret'));
    assert.equal(decryptTokens(stored, config.notion!.encryptionKey).access_token, 'fictional-secret');
    const denied = await beginAuth();
    assert.match((await app.inject({ url: `/api/v1/integrations/notion/callback?state=${denied.state}&error=access_denied`, headers: { cookie: denied.cookie } })).headers.location!, /notion=denied/);
  });
  const device = randomUUID(); const day = '2026-10-15';
  let card = { record_id: 7, title: '虚构活动', category: '编程', summary: '摘要', detailed_summary: '正文', subcategory: '', apps: ['Test'],
    start: `${day}T09:00:00+08:00`, end: `${day}T10:00:00+08:00`, duration_minutes: 60 };
  const state = async () => (await app.inject({ url: `/api/v1/sync/state?device_id=${device}`, headers: deviceHeaders })).json();
  const upload = async (deleted = false, includeDocs = false) => {
    const s = await state();
    const payload = { device_id: device, device_name: '测试设备', batch_id: randomUUID(), expected_revision: s.revision,
      time_zone: 'Asia/Shanghai', day_boundary_hour: 4, status: {}, categories: [],
      days: [{ date: day, source_hash: digest(deleted ? 'deleted' : JSON.stringify(card)), active_ids: deleted ? [] : [card.record_id],
        activities: deleted ? [] : [{ data: card, content_hash: digest(JSON.stringify(card)) }] }],
      dailies: includeDocs ? [{ date: day, source_hash: digest('daily'), document: { highlights: ['测试日报'] } }] : [],
      weeks: includeDocs ? [{ date: '2026-10-12', source_hash: digest('weekly'), document: { tracked_minutes: 60, categories: [] } }] : [],
    };
    const response = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: deviceHeaders, payload });
    return { response, payload };
  };
  await t.test('template selection, cloud backfill and idempotent batch replay', async () => {
    assert.equal((await request('GET', '/notion/pages')).json().pages[0].id, fake.root);
    assert.equal((await request('POST', '/notion/target', { page_id: fake.root })).statusCode, 200);
    assert.equal((await request('POST', '/notion/target', { page_id: fake.root })).statusCode, 200);
    assert.equal(fake.calls.filter(c => c.path === 'databases').length, 1);
    assert.equal((await upload(false, true)).response.statusCode, 200);
    assert.equal((await pool.query('SELECT * FROM notion_items')).rowCount, 0);
    assert.equal((await request('PATCH', '/sync', { notion_enabled: true })).statusCode, 200);
    assert.equal((await request('GET', '/sync')).json().pending, 3);
    const { response, payload } = await upload(); assert.equal(response.statusCode, 200);
    const versions = (await pool.query('SELECT version FROM notion_items ORDER BY key')).rows;
    const replay = await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: deviceHeaders, payload });
    assert.equal(replay.json().replayed, true);
    assert.deepEqual((await pool.query('SELECT version FROM notion_items ORDER BY key')).rows, versions);
    await worker.tick(); await worker.tick(); await worker.tick();
    assert.equal(fake.pages.size, 3); assert.equal((await request('GET', '/sync')).json().pending, 0);
    assert.equal((await pool.query('SELECT * FROM notion_items WHERE payload IS NOT NULL')).rowCount, 0);
  });
  await t.test('Notion-only updates do not modify the cloud archive; deletion and restoration retain page identity', async () => {
    assert.equal((await request('PATCH', '/sync', { cloud_enabled: false })).statusCode, 200);
    card = { ...card, title: '仅 Notion 的更新', detailed_summary: '长正文😀\n'.repeat(7000) };
    assert.equal((await upload()).response.statusCode, 200);
    assert.equal((await pool.query('SELECT payload FROM activities')).rows[0].payload.title, '虚构活动');
    assert.equal((await state()).activities[0].has_screenshot, true);
    await worker.tick(); assert.equal(fake.pages.size, 3);
    const page = [...fake.pages.values()].find(p => p.properties['Dayflow ID'].rich_text[0].text.content.endsWith('activity:7'))!;
    assert.ok(page.blocks.map(b => b.paragraph.rich_text.map((t: any) => t.text.content).join('')).join('').includes(card.detailed_summary));
    for (const block of page.blocks) for (const text of block.paragraph.rich_text) assert.ok(text.text.content.length <= 2000);
    assert.equal((await upload(true)).response.statusCode, 200); await worker.tick();
    assert.equal(page.properties.源端已删除.checkbox, true); assert.ok(page.blocks.length);
    card = { ...card, detailed_summary: '恢复后的短正文' }; await upload(); await worker.tick();
    assert.equal(fake.pages.size, 3); assert.equal(page.properties.源端已删除.checkbox, false); assert.equal(page.blocks.length, 1);
  });
  await t.test('concurrent upload survives old acknowledgement; a second worker cannot duplicate the job', async () => {
    card = { ...card, title: '正在发送旧版本' }; await upload();
    const secondWorker = createNotionSync(pool, config, fake);
    fake.onPageUpdate = async () => {
      await secondWorker.tick();
      card = { ...card, title: '发送期间新到达的版本' }; assert.equal((await upload()).response.statusCode, 200);
    };
    await worker.tick();
    const pending = (await pool.query("SELECT payload,dirty FROM notion_items WHERE kind='activity'")).rows[0];
    assert.equal(pending.dirty, true); assert.equal(pending.payload.title, card.title);
    await secondWorker.tick(); await secondWorker.stop();
    assert.equal((await request('GET', '/sync')).json().pending, 0);
    assert.equal(fake.pages.size, 3);
  });
  await t.test('resuming Notion after a cloud toggle cannot backfill older archive content over newer relay content', async () => {
    assert.equal((await request('PATCH', '/sync', { cloud_enabled: true, notion_enabled: false })).statusCode, 200);
    assert.equal((await request('PATCH', '/sync', { notion_enabled: true })).statusCode, 200);
    assert.equal((await request('GET', '/sync')).json().pending, 0);
    const row = (await pool.query("SELECT source_hash FROM notion_items WHERE kind='activity'")).rows[0];
    assert.equal(row.source_hash, digest(JSON.stringify(card)));
    await request('PATCH', '/sync', { cloud_enabled: false });
  });
  await t.test('rate limits pause dispatch; refresh rotates tokens; lost create response recovers without duplication', async () => {
    card = { ...card, title: '限流测试' }; await upload(); fake.failNext = 429; await worker.tick();
    const status = (await request('GET', '/sync')).json(); assert.equal(status.failed, 1); assert.match(status.connection.last_error, /限流/);
    const calls = fake.calls.length; await worker.tick(); assert.equal(fake.calls.length, calls);
    await request('POST', '/notion/retry'); fake.expired = true; await worker.tick();
    assert.equal(decryptTokens((await pool.query('SELECT credentials FROM notion_connection')).rows[0].credentials, config.notion!.encryptionKey).refresh_token, 'rotated-refresh');
    card = { ...card, record_id: 8, title: '丢失创建响应' };
    assert.equal((await upload()).response.statusCode, 200);
    fake.loseCreate = true;
    await worker.tick(); await worker.tick();
    const size = fake.pages.size; await request('POST', '/notion/retry'); await worker.tick();
    assert.equal(fake.pages.size, size); assert.equal((await request('GET', '/sync')).json().pending, 0);
    card = { ...card, record_id: 7 };
  });
  await t.test('both off reject uploads; enabling cloud forces fresh reconciliation; disconnect revokes and clears only Notion state', async () => {
    assert.equal((await request('PATCH', '/sync', { notion_enabled: false })).statusCode, 200);
    assert.equal((await state()).paused, true); assert.equal((await upload()).response.statusCode, 423);
    assert.equal((await request('PATCH', '/sync', { cloud_enabled: true })).statusCode, 200);
    assert.equal((await state()).days.length, 0);
    assert.equal((await upload()).response.statusCode, 200);
    assert.equal((await pool.query('SELECT payload FROM activities WHERE record_id=7')).rows[0].payload.title, card.title);
    const pageCount = fake.pages.size;
    assert.equal((await request('DELETE', '/notion')).statusCode, 200);
    assert.ok(fake.calls.some(c => c.path === 'oauth/revoke'));
    assert.equal((await pool.query('SELECT * FROM notion_items')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM activities')).rowCount, 1);
    assert.equal(fake.pages.size, pageCount);
  });
});

test('WebUI config persists encrypted, activates OAuth and dispatch without environment settings, and survives restart', async t => {
  const admin = new Pool({ connectionString: testDatabaseUrl() }); await verifyTestDatabase(admin);
  const schema = `test_setup_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl()); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString() });
  const storage = await mkdtemp(path.join(tmpdir(), 'dayflow-notion-setup-'));
  const config = fixtureConfig(storage, url.toString());
  const fake = new FakeNotion();
  let app = await createApp(config, { notionApi: fake, startNotionWorker: false });
  const worker = createNotionSync(pool, config, fake); // Created before any settings exist.
  t.after(async () => { await worker.stop(); await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true }); });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dayflow-request': '1' }, payload: { username: config.adminUsername, password: config.adminPassword } });
  const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie, 'x-dayflow-request': '1', origin: config.publicOrigin };
  const request = (method: any, route: string, payload?: any) => app.inject({ method, url: `/api/v1/integrations${route}`, headers, ...(payload === undefined ? {} : { payload }) });
  const input = { client_id: 'web-client', client_secret: 'web-client-secret-fixture', template_url: '' };
  const initial = (await request('GET', '/sync')).json();
  assert.equal(initial.configured, false); assert.equal(initial.setup.editable, true);
  assert.equal(initial.setup.redirect_uri, `${config.publicOrigin}/api/v1/integrations/notion/callback`);
  assert.equal((await request('PUT', '/notion/setup', { ...input, client_secret: '' })).statusCode, 400);
  assert.equal((await request('PUT', '/notion/setup', { ...input, template_url: 'https://evil.test' })).statusCode, 400);
  await assert.rejects(stat(path.join(storage, '.notion-encryption-key')), { code: 'ENOENT' });
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/integrations/notion/setup', headers: { cookie }, payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/integrations/notion/setup', headers: { ...headers, cookie: '', authorization: `Bearer ${config.readToken}` }, payload: input })).statusCode, 401);
  const saved = await request('PUT', '/notion/setup', input);
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().configured, true);
  assert.equal(saved.json().setup.source, 'web'); assert.ok(!saved.body.includes(input.client_secret));
  const keyPath = path.join(storage, '.notion-encryption-key'); const key = await readFile(keyPath, 'utf8');
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  const ciphertext = (await pool.query('SELECT secret_ciphertext FROM notion_settings')).rows[0].secret_ciphertext;
  assert.ok(!ciphertext.includes(input.client_secret)); assert.equal(decryptTokens(ciphertext, key).access_token, input.client_secret);
  const oldAuth = await request('POST', '/notion/authorize');
  const oldState = new URL(oldAuth.json().url).searchParams.get('state');
  assert.equal((await request('PUT', '/notion/setup', { client_id: input.client_id, template_url: 'https://example.notion.site/template' })).statusCode, 200);
  assert.equal((await pool.query('SELECT secret_ciphertext FROM notion_settings')).rows[0].secret_ciphertext, ciphertext);
  assert.equal((await app.inject({ url: `/api/v1/integrations/notion/callback?state=${oldState}&code=old`, headers: { cookie: oldAuth.cookies.map(c => `${c.name}=${c.value}`).join('; ') } })).statusCode, 400);
  await app.close(); app = await createApp(config, { notionApi: fake, startNotionWorker: false });
  assert.equal((await request('GET', '/sync')).json().setup.client_id, input.client_id);
  assert.equal(await readFile(keyPath, 'utf8'), key);
  const auth = await request('POST', '/notion/authorize'); const authUrl = new URL(auth.json().url);
  assert.equal(authUrl.searchParams.get('client_id'), input.client_id);
  const callback = await app.inject({ url: `/api/v1/integrations/notion/callback?state=${authUrl.searchParams.get('state')}&code=fixture`, headers: { cookie: auth.cookies.map(c => `${c.name}=${c.value}`).join('; ') } });
  assert.match(callback.headers.location!, /notion=connected/);
  assert.equal((await request('PUT', '/notion/setup', input)).statusCode, 409);
  assert.equal((await request('POST', '/notion/target', { page_id: fake.root })).statusCode, 200);
  assert.equal((await request('PATCH', '/sync', { cloud_enabled: false, notion_enabled: true })).statusCode, 200);
  const device = randomUUID(); const day = '2026-10-15';
  const batch = { device_id: device, device_name: 'Web setup fixture', batch_id: randomUUID(), expected_revision: 0,
    time_zone: 'Asia/Shanghai', day_boundary_hour: 4, status: {}, categories: [], days: [], weeks: [],
    dailies: [{ date: day, source_hash: digest('web-daily'), document: { highlights: ['WebUI 授权后的日报'] } }] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: { authorization: `Bearer ${config.syncToken}` }, payload: batch })).statusCode, 200);
  await worker.tick(); assert.equal(fake.pages.size, 1); assert.equal((await request('GET', '/sync')).json().pending, 0);
  assert.equal((await request('DELETE', '/notion')).statusCode, 200);
  assert.equal((await request('GET', '/sync')).json().configured, true); // Disconnect keeps reusable app settings.
  await rename(keyPath, `${keyPath}.fixture-backup`);
  assert.equal((await request('POST', '/notion/authorize')).statusCode, 409);
  assert.equal((await request('PUT', '/notion/setup', input)).statusCode, 409);
  await assert.rejects(stat(keyPath), { code: 'ENOENT' });
  await rename(`${keyPath}.fixture-backup`, keyPath);
});

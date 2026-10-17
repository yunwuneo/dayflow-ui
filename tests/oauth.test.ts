import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import OAuth2Server from '@node-oauth/oauth2-server';
import { Writable } from 'node:stream';
import { oauthFailure } from '../server/oauth.ts';
import { createApp } from '../server/app.ts';
import { digest, hashPassword } from '../server/security.ts';
import { resetPassword } from '../server/password.ts';
import { fixtureConfig, testDatabaseUrl, verifyTestDatabase } from './isolation.ts';

test('OAuth diagnostics correlate responses and safe logs without exposing internal errors', async () => {
  let logs = '';
  const app = Fastify({ logger: { stream: new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }) } });
  app.get('/oauth/authorize', (_request, reply) => oauthFailure(new OAuth2Server.InvalidRequestError('code_challenge_method must be S256'), reply));
  app.post('/oauth/token', (_request, reply) => oauthFailure(new Error('secret-database-password'), reply));
  try {
    const response = await app.inject('/oauth/authorize');
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_request');
    assert.match(response.json().error_description, /code_challenge_method.*S256/);
    assert.equal(response.json().request_id, response.headers['x-request-id']);
    assert.equal(response.headers['cache-control'], 'no-store');
    const html = await app.inject({ url: '/oauth/authorize', headers: { accept: 'text/html' } });
    assert.match(String(html.headers['content-type']), /text\/html/);
    assert.match(html.body, /OAuth 授权失败/);
    assert.ok(html.body.includes(String(html.headers['x-request-id'])));
    const internal = await app.inject({ method: 'POST', url: '/oauth/token', headers: { accept: 'text/html' } });
    assert.equal(internal.statusCode, 500);
    assert.equal(internal.json().error, 'server_error');
    assert.match(internal.json().error_description, /请求编号/);
    const diagnostic = logs.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.event === 'oauth_failure' && line.status === 500);
    assert.equal(diagnostic.request_id, internal.json().request_id);
    assert.ok(!logs.includes('secret-database-password'));
    assert.ok(!internal.body.includes('secret-database-password'));
  } finally { await app.close(); }
});

test('OAuth authorization, persistence, scope separation and replay protection (fictional database)', async t => {
  const admin = new Pool({ connectionString: testDatabaseUrl() });
  await verifyTestDatabase(admin);
  const schema = `oauth_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(testDatabaseUrl()); url.searchParams.set('options', `-c search_path=${schema}`);
  const storage = await mkdtemp(path.join(tmpdir(), 'dayflow-oauth-tests-'));
  const config = fixtureConfig(storage, url.toString());
  const pool = new Pool({ connectionString: url.toString() });
  let app = await createApp(config);
  t.after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true }); });
  await pool.query('INSERT INTO users VALUES($1,$2)', ['other-user', await hashPassword(config.adminPassword)]);
  const owner = config.oauth!.ownerUsername;
  const resource = `${config.publicOrigin}/mcp`;
  const callback = config.oauth!.redirectUris[0];
  const clientId = config.oauth!.clientId;
  const login = async (username = owner) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: config.adminPassword }, headers: { 'x-dayflow-request': '1', origin: config.publicOrigin } });
    assert.equal(response.statusCode, 200, response.body);
    return String(response.headers['set-cookie']).split(';')[0];
  };
  let ownerCookie = await login();
  const otherCookie = await login('other-user');
  let requestCount = 0;
  const remoteAddress = () => `192.0.2.${++requestCount % 250 + 1}`;
  const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
  const query = (challenge: string) => ({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'dayflow:read offline_access', resource, state: 'fictional-state', code_challenge: challenge, code_challenge_method: 'S256' });
  const begin = async (cookie = ownerCookie, overrides: Record<string,string> = {}) => {
    const p = pkce();
    const response = await app.inject({ remoteAddress: remoteAddress(), url: '/oauth/authorize?' + new URLSearchParams({ ...query(p.challenge), ...overrides }), headers: cookie ? { cookie } : {} });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.body.match(/name="id" value="([^"]+)"/)![1];
    const csrf = response.body.match(/name="csrf" value="([^"]+)"/)![1];
    const flowCookie = String(response.headers['set-cookie']).split(';')[0];
    return { ...p, id, csrf, cookie: [cookie, flowCookie].filter(Boolean).join('; '), page: response.body };
  };
  type Flow = Awaited<ReturnType<typeof begin>>;
  const decision = (flow: Flow, allow = true, headers = {}, payload = {}) => app.inject({ remoteAddress: remoteAddress(), method: 'POST', url: '/oauth/decision',
    headers: { cookie: flow.cookie, origin: config.publicOrigin, ...headers }, payload: { id: flow.id, csrf: flow.csrf, decision: allow ? 'allow' : 'deny', ...payload } });
  const code = async (overrides: Record<string,string> = {}) => {
    const flow = await begin(ownerCookie, overrides); const response = await decision(flow);
    assert.equal(response.statusCode, 302, response.body);
    const location = new URL(String(response.headers.location));
    assert.equal(location.searchParams.get('iss'), config.publicOrigin); assert.equal(location.searchParams.get('state'), 'fictional-state');
    return { ...flow, code: location.searchParams.get('code')! };
  };
  const formPost = (endpoint: string, values: Record<string,string>, headers = {}) => app.inject({ remoteAddress: remoteAddress(), method: 'POST', url: endpoint,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(values).toString() });
  const exchange = (c: Awaited<ReturnType<typeof code>>, overrides: Record<string,string> = {}, headers = {}) => formPost('/oauth/token', {
    grant_type: 'authorization_code', client_id: clientId, code: c.code, redirect_uri: callback, resource, code_verifier: c.verifier, ...overrides }, headers);
  const grant = async (overrides: Record<string,string> = {}) => {
    const c = await code(overrides); const response = await exchange(c); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const refresh = (token: string, overrides: Record<string,string> = {}, headers = {}) => formPost('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource, ...overrides }, headers);
  const rpc = (token: string, method = 'tools/list', params = {}) => app.inject({ remoteAddress: remoteAddress(), method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });

  await t.test('Discovery, challenge and native session identity; read token is not a session', async () => {
    const meta = (await app.inject('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(meta.registration_endpoint, undefined);
    const protectedMeta = (await app.inject('/.well-known/oauth-protected-resource/mcp')).json(); assert.equal(protectedMeta.resource, resource);
    assert.equal((await app.inject('/.well-known/oauth-protected-resource')).json().resource, resource);
    for (const headers of [{}, { cookie: ownerCookie }, { authorization: `Bearer ${config.syncToken}` }]) {
      const response = await app.inject({ method: 'POST', url: '/mcp', headers, payload: {} });
      assert.equal(response.statusCode, 401); assert.match(String(response.headers['www-authenticate']), /resource_metadata=.*oauth-protected-resource\/mcp/);
    }
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: otherCookie } })).json().username, 'other-user');
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { authorization: `Bearer ${config.readToken}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/overview', headers: { cookie: otherCookie } })).statusCode, 403);
  });
  await t.test('Reject unknown client, illegal redirect/resource/scope, missing and plain PKCE before any redirect', async () => {
    const p = pkce();
    for (const overrides of [{ client_id: 'unknown' }, { redirect_uri: 'https://attacker.example/callback' }, { redirect_uri: callback + '?evil=1' },
      { resource: 'https://wrong.example/mcp' }, { scope: 'dayflow:write' }, { scope: 'dayflow:read dayflow:read' }, { scope: 'openid' },
      { code_challenge_method: 'plain' }, { code_challenge_method: '' }, { code_challenge: '' }, { state: '' }]) {
      const response = await app.inject('/oauth/authorize?' + new URLSearchParams({ ...query(p.challenge), ...overrides }));
      assert.ok(response.statusCode >= 400, response.body); assert.equal(response.headers.location, undefined);
    }
    assert.equal((await app.inject(`/oauth/authorize?${new URLSearchParams(query(p.challenge))}&resource=evil`)).statusCode, 400);
  });
  await t.test('Authorization errors identify fields without reflecting request values', async () => {
    const p = pkce();
    for (const [overrides, expected] of [
      [{ code_challenge_method: 'plain' }, /code_challenge_method: must be S256/],
      [{ code_challenge: '' }, /code_challenge:/],
      [{ state: '' }, /state:/],
      [{ client_id: 'sensitive-unregistered-value' }, /client_id.*MCP_OAUTH_CLIENT_ID/],
      [{ redirect_uri: 'https://evil.example/sensitive-unregistered-value' }, /redirect_uri.*MCP_OAUTH_REDIRECT_URIS/],
      [{ resource: 'sensitive-unregistered-value' }, /resource must equal/],
      [{ scope: 'sensitive-unregistered-value' }, /scope must include dayflow:read/],
      [{ unexpected: 'sensitive-unregistered-value' }, /Only documented/],
    ] as [Record<string, string>, RegExp][]) {
      const response = await app.inject('/oauth/authorize?' + new URLSearchParams({ ...query(p.challenge), ...overrides }));
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error_description, expected);
      assert.equal(response.headers.location, undefined);
      assert.ok(!response.body.includes('sensitive-unregistered-value'));
      assert.ok(response.json().request_id);
    }
    const missingCode = await formPost('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, resource });
    assert.equal(missingCode.json().error, 'invalid_request');
    assert.match(missingCode.json().error_description, /Missing parameter: `code`/);
    const duplicate = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'client_id=one&client_id=two' });
    assert.equal(duplicate.json().error, 'invalid_request');
    assert.match(duplicate.json().error_description, /重复/);
    assert.ok(duplicate.json().request_id);
  });
  await t.test('Native credentials login within OAuth, explicit consent and denial', async () => {
    const flow = await begin(''); assert.match(flow.page, /登录以继续授权/);
    const response = await formPost('/oauth/login', { id: flow.id, csrf: flow.csrf, username: owner, password: config.adminPassword }, { cookie: flow.cookie, origin: config.publicOrigin });
    assert.equal(response.statusCode, 200, response.body); assert.match(response.body, /同意只读访问/);
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
    const session = String(response.headers['set-cookie']).split(';')[0];
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session } })).json().username, owner);
    const denied = await decision({ ...flow, cookie: `${flow.cookie}; ${session}` }, false);
    assert.equal(denied.statusCode, 302, denied.body);
    const location = new URL(String(denied.headers.location)); assert.equal(location.searchParams.get('error'), 'access_denied'); assert.equal(location.searchParams.get('iss'), config.publicOrigin);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mcp_oauth_grants')).rows[0].n, 0);
    const newFlow = await begin('');
    const wrong = await formPost('/oauth/login', { id: newFlow.id, csrf: newFlow.csrf, username: owner, password: 'wrong' }, { cookie: newFlow.cookie, origin: config.publicOrigin });
    assert.equal(wrong.statusCode, 401);
  });
  await t.test('CSRF, cross-browser injection, expired intent and non-owner/forged username are refused', async () => {
    const flow = await begin();
    assert.equal((await decision(flow, true, { origin: 'https://attacker.example' })).statusCode, 403);
    assert.equal((await decision(flow, true, { origin: '' })).statusCode, 403);
    assert.equal((await decision(flow, true, {}, { csrf: 'a'.repeat(64) })).statusCode, 403);
    assert.equal((await decision(flow, true, { cookie: ownerCookie })).statusCode, 403);
    assert.equal((await decision({ ...flow, cookie: flow.cookie.replace(ownerCookie, otherCookie) }, true, {}, { username: owner })).statusCode, 403);
    assert.equal((await decision({ ...flow, cookie: flow.cookie.replace(ownerCookie, '') })).statusCode, 401);
    assert.equal((await decision(flow)).statusCode, 302);
    assert.equal((await decision(flow)).statusCode, 403);
    const expired = await begin(); await pool.query("UPDATE mcp_oauth_interactions SET expires_at=now()-interval '1 second' WHERE id_hash=$1", [digest(expired.id)]);
    assert.equal((await decision(expired)).statusCode, 403);
  });
  await t.test('Wrong PKCE consumes code; missing/malformed verifier, redirect and expiry fail', async () => {
    const wrong = await code(); assert.equal((await exchange(wrong, { code_verifier: pkce().verifier })).statusCode, 400);
    assert.equal((await exchange(wrong)).statusCode, 400);
    for (const overrides of [{ code_verifier: '' }, { code_verifier: 'short' }, { redirect_uri: 'https://attacker.example/callback' }] as Record<string,string>[]) {
      assert.equal((await exchange(await code(), overrides)).statusCode, 400);
    }
    const expired = await code(); await pool.query("UPDATE mcp_oauth_codes SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [digest(expired.code)]);
    assert.equal((await exchange(expired)).statusCode, 400);
  });
  await t.test('Authorization code concurrent replay has exactly one winner', async () => {
    const c = await code(); const responses = await Promise.all(Array.from({ length: 4 }, () => exchange(c)));
    assert.equal(responses.filter(r => r.statusCode === 200).length, 1); assert.equal(responses.filter(r => r.statusCode === 400).length, 3);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE grant_id=(SELECT grant_id FROM mcp_oauth_codes WHERE code_hash=$1)', [digest(c.code)])).rows[0].n, 1);
  });
  let persistent: Record<string,string>;
  await t.test('Tokens are resource-bound, read-only, opaque and functional for all five MCP tools', async () => {
    const c = await code();
    assert.equal((await exchange(c, { resource: 'https://wrong.example/mcp' })).statusCode, 400);
    assert.equal((await exchange(c, { scope: 'dayflow:write' })).statusCode, 400);
    assert.equal((await exchange(c, { scope: 'dayflow:read' })).statusCode, 400);
    assert.equal((await exchange(c, { client_id: 'other-client' })).statusCode, 400);
    const response = await exchange(c); assert.equal(response.statusCode, 200, response.body); persistent = response.json();
    assert.equal(persistent.resource, resource);
    assert.equal((await rpc(persistent.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fictional', version: '1' } })).statusCode, 200);
    const tools = (await rpc(persistent.access_token)).json().result.tools;
    assert.equal(tools.length, 5); assert.ok(tools.every((tool: any) => tool.annotations.readOnlyHint && tool.securitySchemes?.[0].scopes.includes('dayflow:read')));
    const device = randomUUID(); const day = '2026-01-01';
    const card = { record_id: 1, title: '虚构活动', category: '演示', start: `${day}T09:00:00Z`, end: `${day}T10:00:00Z`, summary: '虚构摘要', detailed_summary: '虚构详情', apps: ['Fictional App'], duration_minutes: 60 };
    const batch = { device_id: device, device_name: 'Fictional Mac', expected_revision: 0, batch_id: randomUUID(), time_zone: 'Asia/Shanghai', day_boundary_hour: 4, status: {}, categories: [],
      days: [{ date: day, source_hash: digest('fictional'), active_ids: [1], activities: [{ content_hash: digest('fictional-card'), data: card }] }], dailies: [], weeks: [] };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: { authorization: `Bearer ${config.syncToken}` }, payload: batch })).statusCode, 200);
    const picture = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#246c54' } }).jpeg().toBuffer();
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/sync/activities/${device}/1/screenshot`, headers: { authorization: `Bearer ${config.syncToken}`, 'content-type': 'image/jpeg' }, payload: picture })).statusCode, 200);
    for (const [name, args] of [['get_overview', {}], ['search_activities', {}], ['get_activity', { device_id: device, record_id: 1 }],
      ['get_screenshot', { device_id: device, record_id: 1 }], ['summarize_time', { from: '2026-01-01', to: '2026-01-01' }]] as const) {
      const result = await rpc(persistent.access_token, 'tools/call', { name, arguments: args });
      assert.equal(result.statusCode, 200); assert.notEqual(result.json().result.isError, true);
      if (name === 'get_screenshot') assert.equal(result.json().result.content[0].type, 'image');
      if (name === 'get_activity') assert.equal(JSON.parse(result.json().result.content[0].text).title, card.title);
    }
    for (const endpoint of ['/api/v1/overview', '/api/v1/auth/session', `/api/v1/sync/state?device_id=${device}`]) {
      assert.equal((await app.inject({ url: endpoint, headers: { authorization: `Bearer ${persistent.access_token}` } })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sync/batch', headers: { authorization: `Bearer ${persistent.access_token}` }, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/sync/activities/${device}/1/screenshot`, headers: { authorization: `Bearer ${persistent.access_token}`, 'content-type': 'image/jpeg' }, payload: Buffer.from('fake') })).statusCode, 401);
    assert.equal((await rpc(config.syncToken)).statusCode, 401);
    assert.equal((await rpc(config.readToken!)).statusCode, 200);
    const stored = (await pool.query('SELECT * FROM mcp_oauth_tokens WHERE access_hash=$1', [digest(persistent.access_token)])).rows[0];
    assert.equal(stored.access_hash, digest(persistent.access_token)); assert.equal(stored.refresh_hash, digest(persistent.refresh_token));
    assert.ok(!JSON.stringify(stored).includes(persistent.access_token));
  });
  await t.test('Authorization, unused code, browser session and token persist across app restart', async () => {
    const pending = await code(); const flow = await begin(); await app.close();
    // A fresh Node process must recover a valid token from PostgreSQL without
    // inheriting any model/library in-memory state or the caller's .env.
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { createApp } from './server/app.ts';
      const app = await createApp(JSON.parse(process.env.ISOLATED_CONFIG));
      try {
        const response = await app.inject({ method: 'POST', url: '/mcp', headers: {
          authorization: 'Bearer ' + process.env.ISOLATED_ACCESS_TOKEN, accept: 'application/json, text/event-stream'
        }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
        process.stdout.write(String(response.statusCode));
      } finally { await app.close(); }
    `], { env: { PATH: process.env.PATH, NODE_ENV: 'test', ISOLATED_CONFIG: JSON.stringify(config), ISOLATED_ACCESS_TOKEN: persistent.access_token } });
    assert.equal(child.stdout, '200');
    app = await createApp(config);
    assert.equal((await rpc(persistent.access_token)).statusCode, 200);
    assert.equal((await exchange(pending)).statusCode, 200);
    assert.equal((await decision(flow)).statusCode, 302);
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: ownerCookie } })).json().username, owner);
    const renewed = await refresh(persistent.refresh_token); assert.equal(renewed.statusCode, 200); persistent = renewed.json();
  });
  await t.test('OAuth works without a fixed read token', async () => {
    const oauthOnly = await createApp({ ...config, readToken: undefined });
    try {
      assert.equal((await oauthOnly.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${persistent.access_token}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode, 200);
    } finally { await oauthOnly.close(); }
  });
  await t.test('Expired, wrong-audience, wrong-scope and disabled-client/owner tokens fail', async () => {
    const tok = await grant(); const h = digest(tok.access_token);
    await pool.query("UPDATE mcp_oauth_tokens SET access_expires_at=now()-interval '1 second' WHERE access_hash=$1", [h]); assert.equal((await rpc(tok.access_token)).statusCode, 401);
    await pool.query("UPDATE mcp_oauth_tokens SET access_expires_at=now()+interval '1 hour',scopes=ARRAY['dayflow:write'] WHERE access_hash=$1", [h]); assert.equal((await rpc(tok.access_token)).statusCode, 401);
    await pool.query("UPDATE mcp_oauth_tokens SET scopes=ARRAY['dayflow:read'] WHERE access_hash=$1", [h]);
    await pool.query("UPDATE mcp_oauth_grants SET resource='https://wrong.example/mcp' WHERE id=(SELECT grant_id FROM mcp_oauth_tokens WHERE access_hash=$1)", [h]); assert.equal((await rpc(tok.access_token)).statusCode, 401);
    for (const override of [{ ownerUsername: 'other-user' }, { clientId: 'removed-client' }]) {
      const changed = await createApp({ ...config, oauth: { ...config.oauth!, ...override } });
      try { assert.equal((await changed.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${persistent.access_token}` }, payload: {} })).statusCode, 401); }
      finally { await changed.close(); }
    }
  });
  await t.test('Refresh rotation/replay revokes the entire family; concurrent reuse cannot issue two successors', async () => {
    const tok = await grant(); const renewed = await refresh(tok.refresh_token); assert.equal(renewed.statusCode, 200, renewed.body);
    assert.notEqual(renewed.json().refresh_token, tok.refresh_token); assert.equal((await rpc(renewed.json().access_token)).statusCode, 200);
    assert.equal((await refresh(tok.refresh_token)).statusCode, 400);
    assert.equal((await rpc(tok.access_token)).statusCode, 401); assert.equal((await rpc(renewed.json().access_token)).statusCode, 401);
    assert.equal((await refresh(renewed.json().refresh_token)).statusCode, 400);
    const concurrent = await grant(); const responses = await Promise.all([refresh(concurrent.refresh_token), refresh(concurrent.refresh_token)]);
    assert.equal(responses.filter(r => r.statusCode === 200).length, 1);
    assert.equal(responses.filter(r => r.statusCode === 400).length, 1);
    assert.equal((await rpc(responses.find(r => r.statusCode === 200)!.json().access_token)).statusCode, 401);
    const expired = await grant(); await pool.query("UPDATE mcp_oauth_tokens SET refresh_expires_at=now()-interval '1 second' WHERE refresh_hash=$1", [digest(expired.refresh_token)]);
    assert.equal((await refresh(expired.refresh_token)).statusCode, 400);
  });
  await t.test('Refresh rejects escalation, wrong client/resource; read-only grants without offline scope have no refresh token', async () => {
    const tok = await grant();
    assert.equal((await refresh(tok.refresh_token, { resource: 'wrong' })).statusCode, 400);
    assert.equal((await refresh(tok.refresh_token, { client_id: 'unknown' })).statusCode, 400);
    assert.equal((await refresh(tok.refresh_token, { scope: 'dayflow:read dayflow:write' })).statusCode, 400);
    assert.equal((await refresh(tok.refresh_token)).statusCode, 200);
    const online = await grant({ scope: 'dayflow:read' }); assert.equal(online.refresh_token, undefined);
    for (const grant_type of ['password', 'client_credentials', 'implicit']) {
      assert.equal((await formPost('/oauth/token', { grant_type, client_id: clientId, resource })).statusCode, 400);
    }
    assert.equal((await formPost('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, resource }, { authorization: 'Basic Zm9vOmJhcg==' })).statusCode, 400);
    assert.equal((await formPost('/oauth/token', { grant_type: 'authorization_code', resource }, { authorization: 'Basic ' + Buffer.from(`${clientId}:`).toString('base64') })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `client_id=${clientId}&client_id=evil` })).statusCode, 400);
  });
  await t.test('Client revocation and session-bound management revoke access and refresh; CSRF/other user fail', async () => {
    const tok = await grant(); assert.equal((await formPost('/oauth/revoke', { client_id: 'wrong', token: tok.access_token })).statusCode, 400);
    assert.equal((await formPost('/oauth/revoke', { client_id: clientId, token: tok.refresh_token })).statusCode, 200);
    assert.equal((await rpc(tok.access_token)).statusCode, 401); assert.equal((await refresh(tok.refresh_token)).statusCode, 400);
    assert.equal((await formPost('/oauth/revoke', { client_id: clientId, token: 'nonexistent' })).statusCode, 200);
    const managed = await grant();
    assert.equal((await app.inject({ url: '/oauth/authorizations', headers: { cookie: otherCookie } })).statusCode, 403);
    const row = (await pool.query('SELECT grant_id FROM mcp_oauth_tokens WHERE access_hash=$1', [digest(managed.access_token)])).rows[0];
    const values = { id: row.grant_id, csrf: digest(`oauth-revoke:${ownerCookie.split('=')[1]}`) };
    assert.equal((await formPost('/oauth/authorizations/revoke', values, { cookie: ownerCookie, origin: 'https://attacker.example' })).statusCode, 403);
    assert.equal((await formPost('/oauth/authorizations/revoke', values, { cookie: otherCookie, origin: config.publicOrigin })).statusCode, 403);
    assert.equal((await formPost('/oauth/authorizations/revoke', { ...values, csrf: 'bad' }, { cookie: ownerCookie, origin: config.publicOrigin })).statusCode, 403);
    assert.equal((await formPost('/oauth/authorizations/revoke', values, { cookie: ownerCookie, origin: config.publicOrigin })).statusCode, 302);
    assert.equal((await rpc(managed.access_token)).statusCode, 401);
  });
  await t.test('Confidential client still requires its secret with PKCE, including refresh and revocation', async () => {
    const secret = 'fictional-client-secret-'.repeat(3);
    await app.close(); app = await createApp({ ...config, oauth: { ...config.oauth!, clientSecret: secret } });
    const c = await code(); assert.equal((await exchange(c)).statusCode, 400);
    assert.equal((await exchange(c, { client_secret: 'wrong' })).statusCode, 400);
    const response = await exchange(c, { client_secret: secret }); assert.equal(response.statusCode, 200, response.body);
    assert.equal((await refresh(response.json().refresh_token)).statusCode, 400);
    assert.equal((await formPost('/oauth/revoke', { client_id: clientId, token: response.json().access_token })).statusCode, 400);
    const basic = 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64');
    const renewed = await formPost('/oauth/token', { grant_type: 'refresh_token', refresh_token: response.json().refresh_token, resource }, { authorization: basic }); assert.equal(renewed.statusCode, 200, renewed.body);
    assert.equal((await formPost('/oauth/revoke', { token: renewed.json().access_token }, { authorization: basic })).statusCode, 200);
    await app.close(); app = await createApp(config);
  });
  await t.test('Password reset revokes account sessions, grants, pending codes and refresh; legacy Bearer remains usable', async () => {
    const tok = await grant(); const pending = await code(); const flow = await begin();
    await resetPassword(pool, owner, 'fictional-replacement-password');
    assert.equal((await rpc(tok.access_token)).statusCode, 401); assert.equal((await refresh(tok.refresh_token)).statusCode, 400);
    assert.equal((await exchange(pending)).statusCode, 400); assert.equal((await decision(flow)).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: ownerCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie: otherCookie } })).json().username, 'other-user');
    assert.equal((await rpc(config.readToken!)).statusCode, 200);
    const old = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-dayflow-request': '1' }, payload: { username: owner, password: config.adminPassword } }); assert.equal(old.statusCode, 401);
  });
});

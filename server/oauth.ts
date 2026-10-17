import OAuth2Server from '@node-oauth/oauth2-server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Config } from './config.ts';
import type { NativeAuth } from './auth.ts';
import { failure } from './auth.ts';
import { constantEquals, digest } from './security.ts';

export const MCP_SCOPE = 'dayflow:read';
const scopes = [MCP_SCOPE, 'offline_access'];
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const authorizationQuery = z.object({
  client_id: z.string().min(1).max(200), redirect_uri: z.string().max(2048), response_type: z.literal('code'),
  scope: z.string().min(1).max(200), resource: z.string().max(2048), state: z.string().regex(/^[\x20-\x7e]{1,512}$/),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'),
// RFC 6749 section 3.1: ignore unrecognized authorization parameters.
// Strip them before persisting or passing the request to the OAuth engine.
}).strip();
function page(title: string, content: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Dayflow</title>
  <style>body{margin:0;background:#f4f6f5;color:#203b35;font:16px/1.7 system-ui}main{max-width:560px;margin:8vh auto;padding:30px;background:white;border-radius:20px;box-shadow:0 8px 40px #203b3510}h1{font-size:25px}label{display:block;margin:14px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;border:1px solid #b8c6c0;border-radius:8px;font:inherit}button,a{font:inherit}button{cursor:pointer;border:0;border-radius:9px;padding:12px 18px;background:#246c54;color:white;margin:8px 8px 8px 0}button.secondary{background:#e7ede9;color:#203b35}p,li{overflow-wrap:anywhere}.error{color:#9a2323}@media(max-width:640px){main{margin:20px;padding:24px}}</style>
  <main><p>Dayflow Archive</p><h1>${esc(title)}</h1>${content}</main></html>`;
}
export function oauthFailure(error: unknown, reply: FastifyReply) {
  const request = reply.request;
  const typed = error as { statusCode?: number };
  const status = error instanceof ZodError ? 400 : error instanceof OAuth2Server.OAuthError ? error.code : typed?.statusCode || 500;
  const serverError = status >= 500;
  const code = serverError ? 'server_error' : error instanceof OAuth2Server.OAuthError ? error.name : 'invalid_request';
  // OAuth library 4xx messages describe protocol checks, never token values.
  // Never expose/log arbitrary internal errors, request bodies or query strings.
  const description = serverError ? 'OAuth 服务暂时不可用，请使用请求编号检查服务端日志和数据库状态。'
    : error instanceof OAuth2Server.OAuthError ? error.message
    : error instanceof ZodError ? '请求字段缺失或格式不正确，请检查表单字段及参数类型。'
    : status === 429 ? '授权请求过于频繁，请稍后重试。'
    : status === 403 ? '授权来源、浏览器状态或权限校验失败；请在同一浏览器重新发起授权并检查登录账号。'
    : status === 401 ? '登录会话无效，请登录后重新发起授权。'
    : status === 413 ? '授权请求过大，请减少请求参数。'
    : '请求格式不正确，请使用 application/x-www-form-urlencoded，且不要重复提交同名参数。';
  const hints: Record<string, string> = {
    invalid_request: '检查提示中的参数；授权需要 response_type=code、state、resource 和 PKCE S256。',
    invalid_client: '核对 MCP_OAUTH_CLIENT_ID、MCP_OAUTH_REDIRECT_URIS 和客户端认证方式；回调地址必须完全匹配。',
    invalid_scope: 'scope 必须包含 dayflow:read，可选 offline_access；不能包含其他或重复权限。',
    invalid_grant: '授权码可能已使用、过期，或 PKCE/回调地址不匹配；请重新授权。刷新令牌失效也需要重新授权。',
    unsupported_grant_type: 'grant_type 仅支持 authorization_code 或 refresh_token。',
  };
  const result = { error: code, error_description: description, ...(hints[code] ? { hint: hints[code] } : {}), request_id: request.id };
  const diagnostic = { event: 'oauth_failure', endpoint: request.routeOptions.url, status, ...result };
  if (serverError) request.log.error(diagnostic, 'OAuth request failed');
  else request.log.warn(diagnostic, 'OAuth request rejected');
  reply.code(serverError ? 500 : status).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('X-Request-ID', request.id);
  const endpoint = request.routeOptions.url || '';
  if (['/oauth/authorize', '/oauth/login', '/oauth/decision'].includes(endpoint) && request.headers.accept?.includes('text/html')) {
    return reply.type('text/html').send(page('OAuth 授权失败', `<p class="error" role="alert">${esc(description)}</p><p>错误代码：${esc(code)}</p>${result.hint ? `<p>${esc(result.hint)}</p>` : ''}<p>请求编号：<code>${esc(request.id)}</code></p><p>请保留错误代码和请求编号以便排查，然后从客户端重新发起授权。</p>`));
  }
  return reply.send(result);
}
const invalid = (name: 'InvalidRequestError' | 'InvalidClientError' | 'InvalidScopeError' | 'InvalidGrantError', text: string) => new OAuth2Server[name](text);

export function createOAuth(app: FastifyInstance, pool: Pool, config: Config, auth: NativeAuth) {
  const o = config.oauth;
  if (!o) return undefined;
  const issuer = config.publicOrigin;
  const resource = `${issuer}/mcp`;
  const client: OAuth2Server.Client = { id: o.clientId, redirectUris: o.redirectUris, grants: ['authorization_code', 'refresh_token'] };
  const validScopes = (scope?: string[]) => Boolean(scope?.includes(MCP_SCOPE) && new Set(scope).size === scope.length && scope.every(s => scopes.includes(s)));
  const checkClient = (id: string, secret?: string | null, authorize = false) => id === o.clientId &&
    (authorize || (o.clientSecret ? Boolean(secret && constantEquals(secret, o.clientSecret)) : !secret));

  // Every token exchange owns one database transaction and one model instance.
  // Lock the user before the grant, matching password reset's lock order.
  function model(db: Pool | PoolClient, requestedResource = resource): OAuth2Server.AuthorizationCodeModel & OAuth2Server.RefreshTokenModel {
    const loadGrant = async (id: string) => {
      const user = await db.query('SELECT username FROM users WHERE username=$1 FOR SHARE', [o!.ownerUsername]);
      if (!user.rowCount) return null;
      const result = await db.query(`SELECT * FROM mcp_oauth_grants WHERE id=$1 AND username=$2 AND client_id=$3
        AND resource=$4 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, [id, o!.ownerUsername, o!.clientId, requestedResource]);
      return result.rows[0] || null;
    };
    return {
      async getClient(id, secret) { return checkClient(id, secret) ? client : false; },
      async validateScope(user, _client, scope) { return user.username === o!.ownerUsername && validScopes(scope) ? scope : false; },
      async saveAuthorizationCode(code, _client, user) {
        const id = randomUUID();
        const expires = new Date(Date.now() + o!.grantSeconds * 1000);
        await db.query('INSERT INTO mcp_oauth_grants(id,username,client_id,resource,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, user.username, client.id, resource, code.scope, expires]);
        await db.query(`INSERT INTO mcp_oauth_codes(code_hash,grant_id,redirect_uri,challenge,challenge_method,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [digest(code.authorizationCode), id, code.redirectUri, code.codeChallenge, code.codeChallengeMethod, code.expiresAt]);
        return { ...code, client, user: { username: user.username, grantId: id, grantExpires: expires } };
      },
      async getAuthorizationCode(raw) {
        const found = await db.query('SELECT * FROM mcp_oauth_codes WHERE code_hash=$1', [digest(raw)]);
        const c = found.rows[0];
        if (!c) return false;
        const g = await loadGrant(c.grant_id);
        if (!g || c.consumed_at) return false;
        return { authorizationCode: raw, expiresAt: c.expires_at, redirectUri: c.redirect_uri, scope: g.scopes,
          codeChallenge: c.challenge, codeChallengeMethod: c.challenge_method, client,
          user: { username: g.username, grantId: g.id, grantExpires: g.expires_at } };
      },
      async revokeAuthorizationCode(code) {
        const result = await db.query('UPDATE mcp_oauth_codes SET consumed_at=now() WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now()', [digest(code.authorizationCode)]);
        return result.rowCount === 1;
      },
      async getRefreshToken(raw) {
        const found = await db.query('SELECT * FROM mcp_oauth_tokens WHERE refresh_hash=$1', [digest(raw)]);
        const t = found.rows[0];
        if (!t) return false;
        const g = await loadGrant(t.grant_id);
        if (!g || !t.scopes.includes('offline_access') || !validScopes(t.scopes) || !t.scopes.every((scope: string) => g.scopes.includes(scope))) return false;
        // Re-read under the grant lock: a concurrent exchange may have rotated it.
        const latest = await db.query('SELECT refresh_consumed_at FROM mcp_oauth_tokens WHERE refresh_hash=$1', [digest(raw)]);
        if (latest.rows[0].refresh_consumed_at) {
          await db.query('UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1', [g.id]);
          return false;
        }
        return { refreshToken: raw, refreshTokenExpiresAt: t.refresh_expires_at, scope: t.scopes, client,
          user: { username: g.username, grantId: g.id, grantExpires: g.expires_at } };
      },
      async revokeToken(token) {
        const result = await db.query('UPDATE mcp_oauth_tokens SET refresh_consumed_at=now() WHERE refresh_hash=$1 AND refresh_consumed_at IS NULL', [digest(token.refreshToken)]);
        return result.rowCount === 1;
      },
      async saveToken(token, _client, user) {
        const expires = new Date(Math.min(token.accessTokenExpiresAt!.getTime(), user.grantExpires.getTime()));
        const offline = token.scope?.includes('offline_access');
        await db.query(`INSERT INTO mcp_oauth_tokens(access_hash,refresh_hash,grant_id,scopes,access_expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [digest(token.accessToken), offline ? digest(token.refreshToken!) : null, user.grantId, token.scope, expires, offline ? user.grantExpires : null]);
        return { ...token, accessTokenExpiresAt: expires, refreshToken: offline ? token.refreshToken : undefined,
          refreshTokenExpiresAt: offline ? user.grantExpires : undefined, client, user };
      },
      async getAccessToken(raw) {
        const result = await db.query(`SELECT t.*,g.username FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id
          JOIN users u ON u.username=g.username WHERE t.access_hash=$1 AND g.username=$2 AND g.client_id=$3 AND g.resource=$4
          AND g.revoked_at IS NULL AND g.expires_at>now() AND g.scopes @> t.scopes`, [digest(raw), o!.ownerUsername, client.id, resource]);
        const t = result.rows[0];
        return t ? { accessToken: raw, accessTokenExpiresAt: t.access_expires_at, scope: t.scopes, client, user: { username: t.username } } : false;
      },
      async verifyScope(token, scope) { return validScopes(token.scope) && scope.every(s => token.scope!.includes(s)); },
    };
  }
  const server = (db: Pool | PoolClient, requestedResource?: string) => new OAuth2Server({ model: model(db, requestedResource),
    accessTokenLifetime: o.accessTokenSeconds, refreshTokenLifetime: o.grantSeconds, authorizationCodeLifetime: o.codeSeconds,
    requireClientAuthentication: { authorization_code: Boolean(o.clientSecret), refresh_token: Boolean(o.clientSecret) }, alwaysIssueNewRefreshToken: true });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_req, body, done) => {
    const params = new URLSearchParams(body as string);
    const values: Record<string, string> = Object.create(null);
    for (const [key, value] of params) {
      if (key in values) return done(failure(400, '重复的表单参数'));
      values[key] = value;
    }
    done(null, values);
  });
  const metadata = { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], scopes_supported: scopes,
    token_endpoint_auth_methods_supported: o.clientSecret ? ['client_secret_basic', 'client_secret_post'] : ['none'],
    revocation_endpoint_auth_methods_supported: o.clientSecret ? ['client_secret_basic', 'client_secret_post'] : ['none'],
    authorization_response_iss_parameter_supported: true };
  app.get('/.well-known/oauth-authorization-server', async () => metadata);
  const protectedMetadata = { resource, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] };
  for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) app.get(url, async () => protectedMetadata);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/oauth/') || request.url.startsWith('/.well-known/oauth')) reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin');
  });
  const parameters = (input: unknown) => {
    const parsed = authorizationQuery.safeParse(input);
    if (!parsed.success) {
      const rules: Record<string, string> = {
        client_id: 'required, at most 200 characters', redirect_uri: 'required, at most 2048 characters',
        response_type: 'must be code', scope: 'required, at most 200 characters', resource: 'required, at most 2048 characters',
        state: 'required, 1-512 printable ASCII characters', code_challenge: 'must be a 43-character base64url SHA-256 challenge',
        code_challenge_method: 'must be S256',
      };
      const details = [...new Set(parsed.error.issues.map(issue => {
        const field = String(issue.path[0]);
        return rules[field] ? `${field}: ${rules[field]}` : 'Invalid authorization parameter';
      }))];
      throw invalid('InvalidRequestError', `Invalid authorization parameters: ${details.join('; ')}`);
    }
    const q = parsed.data;
    if (!checkClient(q.client_id, null, true)) throw invalid('InvalidClientError', 'client_id does not match MCP_OAUTH_CLIENT_ID');
    if (!o.redirectUris.includes(q.redirect_uri)) throw invalid('InvalidClientError', 'redirect_uri must exactly match an entry in MCP_OAUTH_REDIRECT_URIS');
    if (q.resource !== resource) throw invalid('InvalidRequestError', `resource must equal ${resource}`);
    if (!validScopes(q.scope.split(' '))) throw invalid('InvalidScopeError', 'scope must include dayflow:read; only dayflow:read and offline_access are supported, without duplicates');
    return q;
  };
  const fields = (id: string, csrf: string) => `<input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const interactionCookie = 'dayflow_oauth_interaction';
  const form = (id: string, csrf: string, username: string | null, requestedScope: string, error = '') => username
    ? page('授权只读访问', `<p>当前账号：<strong>${esc(username)}</strong></p><p>客户端：${esc(o.clientName)}</p>
      <p>同意后，客户端可以读取此个人档案的活动、详细摘要、日报、周统计、设备状态及截图。截图和文字会提供给客户端及其模型服务。</p>
      <p>权限：${esc(requestedScope)}。${requestedScope.split(' ').includes('offline_access') ? '允许自动续期；' : '不自动续期；'}授权最长 ${Math.ceil(o.grantSeconds / 86400)} 天，可随时撤销。此授权不能上传或修改数据。</p>
      <form method="post" action="/oauth/decision">${fields(id, csrf)}${username === o.ownerUsername ? '<button name="decision" value="allow">同意只读访问</button>' : '<p class="error">此账号不是档案所有者，不能授权读取。</p>'}<button class="secondary" name="decision" value="deny">拒绝</button></form>`)
    : page('登录以继续授权', `<p>使用已有 Dayflow 账号登录，再确认对 ${esc(o.clientName)} 的只读授权。</p>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form method="post" action="/oauth/login">${fields(id, csrf)}<label>用户名<input name="username" autocomplete="username" required maxlength="200"></label>
      <label>密码<input type="password" name="password" autocomplete="current-password" required maxlength="1000"></label><button>登录</button></form>`);
  const interaction = async (request: FastifyRequest, db: Pool | PoolClient = pool, lock = false) => {
    const body = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), csrf: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(request.body);
    if (request.headers.origin !== issuer || !request.cookies[interactionCookie] || !constantEquals(body.id, request.cookies[interactionCookie])) throw failure(403, '授权请求来源或浏览器状态无效');
    const found = await db.query(`SELECT * FROM mcp_oauth_interactions WHERE id_hash=$1 AND expires_at>now() ${lock ? 'FOR UPDATE' : ''}`, [digest(body.id)]);
    const i = found.rows[0];
    if (!i || !constantEquals(digest(body.csrf), i.csrf_hash)) throw failure(403, '授权请求校验失败或已过期');
    return { body, q: parameters(i.parameters) };
  };
  app.get('/oauth/authorize', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const q = parameters(request.query);
      const id = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
      await pool.query('DELETE FROM mcp_oauth_interactions WHERE expires_at<now()');
      await pool.query("INSERT INTO mcp_oauth_interactions VALUES($1,$2,$3,now()+interval '10 minutes')", [digest(id), digest(csrf), q]);
      reply.setCookie(interactionCookie, id, { path: '/oauth', httpOnly: true, secure: issuer.startsWith('https:'), sameSite: 'lax', maxAge: 600 });
      return reply.type('text/html').send(form(id, csrf, await auth.session(request), q.scope));
    } catch (error) { return oauthFailure(error, reply); }
  });
  app.post('/oauth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { body, q } = await interaction(request);
    const credentials = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(body);
    try {
      const { username } = await auth.login(credentials.username, credentials.password, reply);
      return reply.type('text/html').send(form(body.id, body.csrf, username, q.scope));
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) return reply.code(401).type('text/html').send(form(body.id, body.csrf, null, q.scope, '用户名或密码不正确'));
      throw error;
    }
  });
  app.post('/oauth/decision', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const username = await auth.session(request, db, true);
      if (!username) throw failure(401, '请先登录');
      const { body, q } = await interaction(request, db, true);
      const decision = z.enum(['allow', 'deny']).parse(body.decision);
      if (decision === 'allow' && username !== o.ownerUsername) throw failure(403, '只有档案所有者可以授权读取');
      await db.query('DELETE FROM mcp_oauth_interactions WHERE id_hash=$1', [digest(body.id)]);
      const response = new OAuth2Server.Response();
      const engine = server(db);
      // Authorization has already validated the client and exact redirect URI.
      engine.options.model.getClient = async id => checkClient(id, null, true) ? client : false;
      try {
        await engine.authorize(new OAuth2Server.Request({ method: 'GET', headers: {}, query: { ...q, allowed: decision === 'allow' ? 'true' : 'false' } }), response,
          { authenticateHandler: { handle: async () => ({ username }) } });
      } catch (error) {
        if (!(error instanceof OAuth2Server.AccessDeniedError)) throw error;
      }
      const location = new URL(response.headers!.location);
      location.searchParams.set('iss', issuer);
      await db.query('COMMIT');
      reply.clearCookie(interactionCookie, { path: '/oauth' });
      return reply.redirect(location.toString());
    } catch (error) { await db.query('ROLLBACK'); return oauthFailure(error, reply); }
    finally { db.release(); }
  });
  function clientCredentials(request: FastifyRequest, body: Record<string, string>) {
    let id = body.client_id; let secret = body.client_secret;
    const header = request.headers.authorization;
    if (header) {
      if (!o!.clientSecret || id || secret || !header.startsWith('Basic ')) throw invalid('InvalidClientError', 'Invalid client authentication');
      const [left, ...right] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      try { id = decodeURIComponent(left); secret = decodeURIComponent(right.join(':')); }
      catch { throw invalid('InvalidClientError', 'Invalid client authentication'); }
    }
    if (!id || !checkClient(id, secret)) throw invalid('InvalidClientError', 'Unknown client');
    return { id, secret };
  }
  app.post('/oauth/token', { bodyLimit: 8192, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (request, reply) => {
    const db = await pool.connect();
    let begun = false;
    try {
      if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw invalid('InvalidRequestError', 'Form encoding required');
      const body = z.record(z.string(), z.string().max(4096)).parse(request.body);
      const creds = clientCredentials(request, body);
      if (!['authorization_code', 'refresh_token'].includes(body.grant_type)) throw new OAuth2Server.UnsupportedGrantTypeError('Only authorization_code and refresh_token are supported');
      if (body.resource !== resource) throw invalid('InvalidRequestError', `resource must equal ${resource}`);
      if (body.scope && !validScopes(body.scope.split(' '))) throw invalid('InvalidScopeError', 'Invalid scope');
      if (body.grant_type === 'authorization_code' && body.scope) throw invalid('InvalidRequestError', 'Authorization code scope cannot be changed at exchange');
      await db.query('BEGIN'); begun = true;
      const response = new OAuth2Server.Response();
      // Credentials are checked above even for PKCE: the library permits public clients.
      const exchangeBody = { ...body, client_id: creds.id, ...(creds.secret ? { client_secret: creds.secret } : {}) };
      await server(db, body.resource).token(new OAuth2Server.Request({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }, query: {}, body: exchangeBody }), response);
      await db.query('COMMIT'); begun = false;
      return reply.header('Pragma', 'no-cache').send({ ...response.body, resource });
    } catch (error) {
      // Preserve code consumption on invalid PKCE, and family revocation on refresh reuse.
      if (begun) await db.query(error instanceof OAuth2Server.OAuthError && error.code < 500 ? 'COMMIT' : 'ROLLBACK');
      return oauthFailure(error, reply);
    } finally { db.release(); }
  });
  app.post('/oauth/revoke', { bodyLimit: 8192, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw invalid('InvalidRequestError', 'Form encoding required');
      const body = z.record(z.string(), z.string().max(4096)).parse(request.body);
      clientCredentials(request, body);
      if (!body.token) throw invalid('InvalidRequestError', 'Token is required');
      await pool.query(`UPDATE mcp_oauth_grants g SET revoked_at=now() FROM mcp_oauth_tokens t WHERE g.id=t.grant_id
        AND g.client_id=$1 AND (t.access_hash=$2 OR t.refresh_hash=$2)`, [client.id, digest(body.token)]);
      return reply.code(200).send();
    } catch (error) { return oauthFailure(error, reply); }
  });
  app.get('/oauth/authorizations', async (request, reply) => {
    const username = await auth.session(request);
    if (!username) return reply.code(401).type('text/html').send(page('请先登录', '<p><a href="/">打开 Dayflow 登录页</a>，登录后返回此页面管理授权。</p>'));
    if (username !== o.ownerUsername) throw failure(403, '只有档案所有者可以管理授权');
    const result = await pool.query('SELECT id,created_at,expires_at,revoked_at FROM mcp_oauth_grants WHERE username=$1 ORDER BY created_at DESC LIMIT 100', [username]);
    const csrf = digest(`oauth-revoke:${request.cookies.dayflow_session}`);
    return reply.type('text/html').send(page('管理只读授权', `<p>当前账号：${esc(username)}</p>${result.rows.map(g => `<p>${esc(o.clientName)} · ${esc(g.created_at.toISOString())} · 到期 ${esc(g.expires_at.toISOString())}${g.revoked_at ? ' · 已撤销' : ''}</p>${g.revoked_at ? '' : `<form method="post" action="/oauth/authorizations/revoke">${fields(g.id, csrf)}<button>撤销此授权</button></form>`}`).join('') || '<p>暂无授权</p>'}`));
  });
  app.post('/oauth/authorizations/revoke', async (request, reply) => {
    const username = await auth.session(request);
    if (!username || username !== o.ownerUsername) throw failure(403, '只有档案所有者可以管理授权');
    const body = z.object({ id: z.uuid(), csrf: z.string() }).parse(request.body);
    if (request.headers.origin !== issuer || !constantEquals(body.csrf, digest(`oauth-revoke:${request.cookies.dayflow_session}`))) throw failure(403, '授权撤销校验失败');
    await pool.query('UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1 AND username=$2', [body.id, username]);
    return reply.redirect('/oauth/authorizations');
  });
  return {
    challenge: `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`,
    async authenticate(raw: string) {
      try {
        const token = await server(pool).authenticate(new OAuth2Server.Request({ method: 'POST', headers: { authorization: `Bearer ${raw}` }, query: {} }), new OAuth2Server.Response(),
          { scope: [MCP_SCOPE], allowBearerTokensInQueryString: false });
        return token.user.username === o.ownerUsername;
      } catch (error) {
        if (error instanceof OAuth2Server.OAuthError && error.code < 500) return false;
        throw error;
      }
    },
  };
}

import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

test('OAuth native login, visible consent, denial, token use and browser revocation', async ({ page, request }, info) => {
  if (!process.env.DAYFLOW_TEST_ROOT) throw new Error('Use npm run test:ui; real environments are forbidden');
  const origin = process.env.PUBLIC_ORIGIN!;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = 'https://client.example.test/callback';
  const authorize = '/oauth/authorize?' + new URLSearchParams({ client_id: 'fictional-client', redirect_uri: callback, response_type: 'code', scope: 'dayflow:read offline_access',
    resource: `${origin}/mcp`, state: 'fictional-browser-state', code_challenge: challenge, code_challenge_method: 'S256' });
  // Keep the entire flow local; never visit the fictional external callback server.
  await page.route('https://client.example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>测试回调完成</h1>' }));
  await page.goto(authorize);
  await expect(page.getByRole('heading', { name: '登录以继续授权' })).toBeVisible();
  await page.getByLabel('用户名').fill(process.env.ADMIN_USERNAME!);
  await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD!);
  const [loginResponse] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/oauth/login'), page.getByRole('button', { name: '登录', exact: true }).click()]);
  expect(loginResponse.status(), await loginResponse.text()).toBe(200);
  await expect(page.getByRole('heading', { name: '授权只读访问' })).toBeVisible();
  await expect(page.getByText('当前账号：', { exact: false })).toContainText('fixture-owner');
  await expect(page.getByText('权限：dayflow:read', { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: process.env.DAYFLOW_QA_DIR ? `${process.env.DAYFLOW_QA_DIR}/${info.project.name}-consent.png` : info.outputPath('oauth-consent.png'), fullPage: true });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await page.waitForURL('https://client.example.test/**');
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');
  await page.goto(authorize);
  await page.getByRole('button', { name: '同意只读访问' }).click();
  await page.waitForURL('https://client.example.test/**');
  const location = new URL(page.url()); expect(location.searchParams.get('iss')).toBe(origin);
  const response = await request.post('/oauth/token', { form: { client_id: 'fictional-client', grant_type: 'authorization_code', code: location.searchParams.get('code')!, redirect_uri: callback,
    code_verifier: verifier, resource: `${origin}/mcp` } });
  expect(response.status()).toBe(200);
  const token = await response.json();
  const rpc = () => request.post('/mcp', { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect((await rpc()).status()).toBe(200);
  await page.goto('/oauth/authorizations');
  await page.getByRole('button', { name: '撤销此授权' }).last().click();
  await expect(page.getByText('已撤销', { exact: false }).last()).toBeVisible();
  expect((await rpc()).status()).toBe(401);
});

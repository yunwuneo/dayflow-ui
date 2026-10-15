import { expect, test } from '@playwright/test';

test.beforeEach(() => { if (!process.env.DAYFLOW_TEST_ROOT) throw new Error('Use npm run test:ui; real datasets are forbidden'); });

test('sync switches work without Notion credentials and preserve the cloud archive', async ({ page }) => {
  await page.goto('/?view=status');
  await page.getByLabel('用户名').fill(process.env.ADMIN_USERNAME!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const cloud = page.getByRole('switch', { name: '云端同步', exact: true });
  await expect(cloud).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Notion 同步', exact: true })).toBeDisabled();
  await expect(page.getByText(/尚未配置 Notion 接入/)).toBeVisible();
  try {
    await cloud.click(); await expect(cloud).not.toBeChecked();
    await expect(page.getByText('所有同步方式均已关闭，客户端将暂停上传。')).toBeVisible();
  } finally {
    await expect(cloud).toBeEnabled(); await cloud.click(); await expect(cloud).toBeChecked();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Notion onboarding, target, retry, error and disconnect controls', async ({ page }) => {
  const state: any = { cloud_enabled: true, notion_enabled: false, configured: true,
    template_url: 'https://example.notion.site/template', connection: null, pending: 0, failed: 0, synced: 0, last_upload_at: null };
  const id = '12345678-1234-4234-8234-123456789012';
  let rejectTarget = true;
  await page.route('**/api/v1/integrations/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const reply = (body: any, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith('/authorize')) {
      state.connection = { workspace_name: '虚构工作区', workspace_id: 'fake', page_id: id, data_source_id: null,
        connected_at: '2026-10-15T01:00:00Z', last_success_at: null, last_error: null, retry_at: null };
      return reply({ url: `${new URL(page.url()).origin}/?view=status&notion=connected` });
    }
    if (url.pathname.endsWith('/pages')) return reply({ pages: [{ id, title: '开发者模板副本' }], next_cursor: null });
    if (url.pathname.endsWith('/target')) {
      if (rejectTarget) { rejectTarget = false; return reply({ error: 'Notion 页面不可访问，请检查共享权限' }, 502); }
      state.connection.data_source_id = 'fake-source'; return reply(state);
    }
    if (url.pathname.endsWith('/retry')) { state.failed = 0; state.pending = 0; state.synced = 12; state.connection.last_error = null; state.connection.last_success_at = '2026-10-15T02:00:00Z'; return reply(state); }
    if (request.method() === 'DELETE') { state.connection = null; state.notion_enabled = false; return reply(state); }
    if (request.method() === 'PATCH') {
      Object.assign(state, request.postDataJSON());
      if (state.notion_enabled) { state.pending = 12; state.failed = 1; state.connection.last_error = 'Notion 请求限流，服务端将自动重试'; }
    }
    return reply(state);
  });
  await page.goto('/?view=status');
  await page.getByLabel('用户名').fill(process.env.ADMIN_USERNAME!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('link', { name: /预览开发者模板/ })).toHaveAttribute('href', state.template_url);
  await page.getByRole('button', { name: '连接 Notion', exact: true }).click();
  await expect(page.getByText('已授权 · 虚构工作区')).toBeVisible();
  await expect(page.getByLabel('目标页面')).toHaveValue(id);
  await page.getByRole('button', { name: '确认同步页面' }).click();
  await expect(page.getByRole('alert')).toContainText('Notion 页面不可访问');
  await page.getByRole('button', { name: '刷新授权页面' }).click();
  await page.getByRole('button', { name: '确认同步页面' }).click();
  await expect(page.getByRole('link', { name: /打开同步页面/ })).toBeVisible();
  const notion = page.getByRole('switch', { name: 'Notion 同步', exact: true });
  await notion.click(); await expect(notion).toBeChecked();
  await expect(page.getByText(/Notion 请求限流/)).toBeVisible();
  await page.getByRole('button', { name: '立即重试', exact: true }).click();
  await expect(page.getByText(/Notion 请求限流/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(page.getByRole('group', { name: '确认断开 Notion' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('button', { name: '确认断开', exact: true }).click();
  await expect(page.getByText('尚未授权 Notion', { exact: true })).toBeVisible();
});

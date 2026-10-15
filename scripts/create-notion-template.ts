import { z } from 'zod';
import { NotionAPI, ensureTemplateDatabase, TEMPLATE_BLOCKS, TEMPLATE_TITLE, TEMPLATE_PROPERTIES, richText } from '../server/notion-api.ts';

// No env file is loaded automatically. Secrets never appear in arguments/output.
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes('--create')) {
  console.log(JSON.stringify({ title: TEMPLATE_TITLE, children: TEMPLATE_BLOCKS, database_properties: TEMPLATE_PROPERTIES }, null, 2));
  console.error('预览模式，没有写入 Notion。设置 NOTION_TEMPLATE_TOKEN 后使用 --create --parent <父页面 UUID> 创建模板；--page <已创建模板 UUID> 可补全数据库。');
} else {
  const token = process.env.NOTION_TEMPLATE_TOKEN;
  if (!token) throw new Error('请通过环境变量设置 NOTION_TEMPLATE_TOKEN，不要把令牌放进命令行参数');
  const existing = args.includes('--page') ? z.uuid().parse(value('--page')) : undefined;
  const parent = existing ? undefined : z.uuid().parse(args.includes('--parent') ? value('--parent') : '');
  const api = new NotionAPI();
  const call = (path: string, method?: string, body?: unknown) => api.request(path, `Bearer ${token}`, method, body);
  const pageId = existing || (await call('pages', 'POST', { parent: { type: 'page_id', page_id: parent },
    properties: { title: { type: 'title', title: richText(TEMPLATE_TITLE) } }, children: TEMPLATE_BLOCKS })).id;
  console.log(`模板页面：https://www.notion.so/${pageId.replaceAll('-', '')}`);
  console.log(`如后续步骤失败，复用此页面：npm run notion:template -- --create --page ${pageId}`);
  await ensureTemplateDatabase(call, pageId);
  console.log('模板已创建。请在 Notion 中发布此页并允许复制，再将公开 URL 填入连接配置的 Notion URL for optional template 和服务端 NOTION_TEMPLATE_URL。');
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const NOTION_VERSION = '2026-03-11';
export type NotionFetch = typeof fetch;
export class NotionError extends Error {
  constructor(public status: number, public retryAfter = 60) {
    super(status === 401 ? 'Notion 授权已失效，请重新授权' : status === 403 || status === 404
      ? 'Notion 页面不可访问，请检查页面共享权限和目标页面' : status === 429
      ? 'Notion 请求限流，服务端将自动重试' : status === 400
      ? 'Notion 拒绝了数据格式，请检查模板字段或记录大小' : 'Notion 暂时不可用，服务端将自动重试');
  }
}
export function encryptTokens(value: unknown, key: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decryptTokens(value: string, key: string): { access_token: string; refresh_token?: string } {
  const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
}
// One serial client per integration; the database lock also serializes replicas.
export class NotionAPI {
  private nextRequest = 0;
  constructor(private transport: NotionFetch = fetch, private interval = 350) {}
  async request(path: string, authorization: string, method = 'GET', body?: unknown): Promise<any> {
    await delay(Math.max(0, this.nextRequest - Date.now()));
    this.nextRequest = Date.now() + this.interval;
    let response: Response;
    try {
      response = await this.transport(`https://api.notion.com/v1/${path}`, { method, redirect: 'error',
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch { throw new NotionError(503); }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = Number(retry);
      throw new NotionError(response.status, retry && Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86400)) : 60);
    }
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new NotionError(503); }
  }
}
export function splitText(text: string, limit: number) {
  const chunks: string[] = []; let chunk = '';
  for (const char of text) {
    if (chunk.length + char.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
export const richText = (text: string) => splitText(text, 1900).map(content => ({ type: 'text', text: { content } }));
const documentLabels: Record<string, string> = {
  date: '日期', highlights: '今日亮点', tasks: '任务', blockers: '阻碍与问题', summary: '总结',
  week_start: '周开始', week_end: '周结束', tracked_minutes: '记录时长（分钟）', focus_minutes: '专注时长（分钟）',
  categories: '分类时间分配', days: '每日记录', name: '名称', minutes: '分钟', share: '占比',
  goals: '目标', title: '标题', completed: '已完成', status: '状态', notes: '备注',
};
export function formatDocument(value: unknown, depth = 0): string {
  if (value === null) return '无';
  if (Array.isArray(value)) return value.length ? value.map(item => `${'  '.repeat(depth)}• ${formatDocument(item, depth + 1)}`).join('\n') : '无';
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    `${'  '.repeat(depth)}${documentLabels[key] || key}：${typeof item === 'object' && item !== null ? '\n' : ''}${formatDocument(item, depth + 1)}`).join('\n');
  return typeof value === 'boolean' ? value ? '是' : '否' : String(value);
}
export const TEMPLATE_TITLE = 'Dayflow · 活动与回顾';
export const TEMPLATE_DATABASE = 'Dayflow 同步记录';
export const TEMPLATE_PROPERTIES = {
  Name: { title: {} }, 'Dayflow ID': { rich_text: {} }, 类型: { select: { options: [
    { name: '活动', color: 'blue' }, { name: '日报', color: 'green' }, { name: '周报', color: 'purple' },
  ] } }, 日期: { date: {} }, 设备: { rich_text: {} }, 分类: { rich_text: {} },
  时长: { number: { format: 'number' } }, 源端已删除: { checkbox: {} },
};
export const TEMPLATE_BLOCKS = [
  { object: 'block', type: 'heading_1', heading_1: { rich_text: richText('每天的投入，留下一份回顾') } },
  { object: 'block', type: 'paragraph', paragraph: { rich_text: richText('Dayflow 在这里整理活动、日报与周报。授权后回到 Dayflow 的同步设置，确认目标页面并开启 Notion 同步。') } },
  { object: 'block', type: 'heading_2', heading_2: { rich_text: richText('如何使用') } },
  ...['按「类型」筛选活动、日报或周报；按「日期」排序；按「分类」整理投入。时长单位为分钟。',
    '这是从 Dayflow 到 Notion 的单向同步。同步记录的属性与正文由 Dayflow 管理，请把个人笔记放在数据库之外。',
    '源端删除会标记「源端已删除」，保留已同步记录。关闭同步不会删除已有页面。',
    'Notion 同步包含活动文字、日报和周报；截图保存在云端档案，不上传到 Notion。模板不包含任何真实活动数据。',
  ].map(text => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(text) } })),
];

export async function ensureTemplateDatabase(call: (path: string, method?: string, body?: unknown) => Promise<any>, pageId: string) {
  let cursor: string | undefined;
  do {
    const result = await call(`blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const block of result.results) {
      if (block.type !== 'child_database' || block.child_database.title !== TEMPLATE_DATABASE) continue;
      const database = await call(`databases/${block.id}`);
      for (const source of database.data_sources || []) {
        const data = await call(`data_sources/${source.id}`);
        if (Object.entries(TEMPLATE_PROPERTIES).every(([name, definition]) => data.properties?.[name]?.type === Object.keys(definition)[0])) return source.id as string;
      }
      throw new NotionError(400); // Never silently write into an incompatible database.
    }
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  const database = await call('databases', 'POST', { parent: { type: 'page_id', page_id: pageId },
    title: richText(TEMPLATE_DATABASE), is_inline: true, initial_data_source: { properties: TEMPLATE_PROPERTIES } });
  if (!database.data_sources?.[0]?.id) throw new NotionError(503);
  return database.data_sources[0].id as string;
}

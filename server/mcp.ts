import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { date as dateSchema, identifier } from './contracts.ts';
import { activityFilters, getActivity, getOverview, getScreenshotHash, searchActivities, summarizeTime } from './queries.ts';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const problem = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
const activityKey = {
  device_id: z.uuid().describe('活动所属设备 ID'),
  record_id: identifier.describe('活动记录 ID'),
};

function buildServer(pool: Pool, config: Config) {
  const server = new McpServer({ name: 'dayflow', version: '1.0.0' }, {
    instructions: 'Dayflow 个人活动档案（只读）。日期格式 YYYY-MM-DD，按设备时区及日界线划分。先用 get_overview 了解可用日期和分类，再用 search_activities 查找活动，需要完整内容时调用 get_activity。',
  });
  server.registerTool('get_overview', {
    title: '每日概览',
    description: '某天的分类时长、日报、所在周的周统计、设备同步状态、分类列表以及所有有数据的日期。省略 date 表示今天。',
    inputSchema: { date: dateSchema.optional() },
    annotations: readOnly,
  }, async ({ date }) => json(await getOverview(pool, date)));
  server.registerTool('search_activities', {
    title: '搜索活动',
    description: '按日期、日期范围、分类或关键词（匹配标题、摘要、详情和应用）分页查询活动。结果不含 detailed_summary，需要时调用 get_activity。指定 date 时按时间正序，否则倒序。',
    inputSchema: { ...activityFilters, include_deleted: z.boolean().default(false).describe('是否包含源端已删除、仅在云端保留的活动') },
    annotations: readOnly,
  }, async query => {
    const result = await searchActivities(pool, query);
    return json({ ...result, activities: result.activities.map(({ detailed_summary: _omitted, ...rest }) => rest) });
  });
  server.registerTool('get_activity', {
    title: '活动详情',
    description: '单条活动的完整内容，包括 detailed_summary。',
    inputSchema: activityKey,
    annotations: readOnly,
  }, async ({ device_id, record_id }) => {
    const activity = await getActivity(pool, device_id, record_id);
    return activity ? json(activity) : problem('活动不存在');
  });
  server.registerTool('get_screenshot', {
    title: '活动截图',
    description: '活动时间段中点附近的一张 JPEG 截图。仅 has_screenshot 为 true 的活动可用。',
    inputSchema: activityKey,
    annotations: readOnly,
  }, async ({ device_id, record_id }) => {
    const hash = await getScreenshotHash(pool, device_id, record_id);
    if (!hash) return problem('截图尚未同步');
    try {
      const image = await readFile(path.join(config.storageDir, `${hash}.jpg`));
      return { content: [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/jpeg' }] };
    } catch { return problem('截图文件不可用'); }
  });
  server.registerTool('summarize_time', {
    title: '时长汇总',
    description: '统计日期范围内（含首尾，最多 366 天）的活动时长和数量，按天或按分类分组。不含源端已删除的活动。',
    inputSchema: { from: dateSchema, to: dateSchema, group_by: z.enum(['day', 'category']).default('category') },
    annotations: readOnly,
  }, async ({ from, to, group_by }) => {
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span < 0) return problem('to 不能早于 from');
    if (span > 365) return problem('日期范围不能超过 366 天');
    return json(await summarizeTime(pool, from, to, group_by));
  });
  return server;
}

export function registerMcp(app: FastifyInstance, pool: Pool, config: Config) {
  // Stateless Streamable HTTP: each POST gets its own server and transport, answered as plain JSON.
  app.post('/mcp', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const server = buildServer(pool, config);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined && key !== 'content-length') headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const response = await transport.handleRequest(new Request(new URL('/mcp', config.publicOrigin), { method: 'POST', headers }), { parsedBody: request.body });
      reply.code(response.status);
      response.headers.forEach((value, key) => { reply.header(key, value); });
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } finally { await server.close(); }
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: async (_request, reply) => reply.code(405).header('Allow', 'POST').send({ error: '仅支持 POST' }) });
  }
}

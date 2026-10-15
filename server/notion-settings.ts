import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { validateNotion, type Config } from './config.ts';
import { failure } from './auth.ts';
import { decryptTokens, encryptTokens } from './notion-api.ts';

export const notionSetupInput = z.object({
  client_id: z.string().trim().min(1).max(200).regex(/^[\x21-\x7e]+$/),
  client_secret: z.string().trim().max(2000).optional(),
  template_url: z.string().trim().max(2000).default(''),
}).strict();

// Every process reads the same database settings and persistent storage key.
// Environment configuration remains authoritative for existing deployments.
export function notionSettings(config: Config) {
  const redirectUri = `${config.publicOrigin}/api/v1/integrations/notion/callback`;
  const keyPath = path.join(config.storageDir, '.notion-encryption-key');
  async function key(create = false) {
    try { return checkKey(await readFile(keyPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) throw failure(409, 'Notion 加密密钥文件缺失，请恢复服务器存储卷中的密钥文件');
      const generated = randomBytes(32).toString('hex');
      try { await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 }); return generated; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return checkKey(await readFile(keyPath, 'utf8'));
        throw failure(409, '无法保存 Notion 加密密钥，请检查服务器存储目录权限');
      }
    }
  }
  function checkKey(value: string) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw failure(409, 'Notion 加密密钥文件损坏，请恢复原文件');
    return value;
  }
  function validate(n: NonNullable<Config['notion']>) {
    try { validateNotion({ ...config, notion: n }); }
    catch { throw failure(400, '请检查连接信息和模板网址；Notion 授权需要 HTTPS 公开地址（本机开发地址除外）'); }
  }
  async function get(db: Pool | PoolClient): Promise<Config['notion']> {
    if (config.notion) return config.notion;
    const saved = (await db.query('SELECT * FROM notion_settings WHERE id=1')).rows[0];
    if (!saved) return undefined;
    const encryptionKey = await key();
    let clientSecret: string;
    try { clientSecret = decryptTokens(saved.secret_ciphertext, encryptionKey).access_token; }
    catch { throw failure(409, 'Notion 连接配置无法解密，请恢复与数据库匹配的服务器密钥'); }
    const n = { clientId: saved.client_id, clientSecret, encryptionKey, redirectUri, templateUrl: saved.template_url || undefined };
    validate(n); return n;
  }
  async function describe(db: Pool | PoolClient) {
    const saved = config.notion ? null : (await db.query('SELECT client_id,template_url FROM notion_settings WHERE id=1')).rows[0];
    const url = new URL(config.publicOrigin);
    const allowed = url.protocol === 'https:' || (!config.production && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    return { source: config.notion ? 'environment' : saved ? 'web' : 'none', client_id: config.notion?.clientId || saved?.client_id || '',
      template_url: config.notion?.templateUrl || saved?.template_url || '', redirect_uri: redirectUri,
      editable: !config.notion, available: allowed,
      error: allowed ? null : '请先将服务器 PUBLIC_ORIGIN 配置为 HTTPS 地址，再进行 Notion 授权。',
    };
  }
  // Caller holds NOTION_LOCK to serialize changes with OAuth exchanges and dispatch.
  async function save(db: PoolClient, input: z.infer<typeof notionSetupInput>) {
    if (config.notion) throw failure(409, '此连接由服务器环境变量管理，请在服务器更新配置');
    if ((await db.query('SELECT 1 FROM notion_connection WHERE id=1')).rowCount) throw failure(409, '修改连接信息前请先断开当前 Notion 授权');
    const old = (await db.query('SELECT * FROM notion_settings WHERE id=1')).rows[0];
    if (!input.client_secret && (!old || old.client_id !== input.client_id)) throw failure(400, '首次配置或更换 Client ID 时必须填写 OAuth Client Secret');
    // Validate before creating files. An existing key is never silently replaced.
    const n = { clientId: input.client_id, clientSecret: input.client_secret || 'unchanged-secret',
      templateUrl: input.template_url || undefined, redirectUri, encryptionKey: '00'.repeat(32) };
    validate(n);
    const encryptionKey = await key(!old);
    const encrypted = input.client_secret ? encryptTokens({ access_token: input.client_secret }, encryptionKey) : old.secret_ciphertext;
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO notion_settings(id,client_id,secret_ciphertext,template_url) VALUES(1,$1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET client_id=EXCLUDED.client_id,secret_ciphertext=EXCLUDED.secret_ciphertext,template_url=EXCLUDED.template_url`,
      [input.client_id, encrypted, input.template_url]);
      await db.query('DELETE FROM notion_auth_states');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  return { get, describe, save };
}

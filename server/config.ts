import path from 'node:path';
import { isIPv4 } from 'node:net';

export interface Config {
  databaseUrl: string; storageDir: string; adminUsername: string; adminPassword: string;
  syncToken: string; readToken?: string; publicOrigin: string; production: boolean;
  trustProxy: boolean; logger: boolean;
  casdoor?: { origin: string; clientId: string; clientSecret: string; redirectUri: string };
  oauth?: OAuthConfig;
  notion?: { clientId: string; clientSecret: string; redirectUri: string; encryptionKey: string; templateUrl?: string };
}

export function validateNotion(config: Config) {
  if (!config.notion) return;
  const n = config.notion;
  const origin = new URL(config.publicOrigin);
  const loopback = !config.production && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== config.publicOrigin || (origin.protocol !== 'https:' && !(loopback && origin.protocol === 'http:')))
    throw new Error('Notion requires canonical HTTPS PUBLIC_ORIGIN (development loopback excepted)');
  if (!n.clientId.trim() || !n.clientSecret || n.clientSecret.startsWith('replace-') || !/^[a-f0-9]{64}$/i.test(n.encryptionKey))
    throw new Error('Notion client credentials and a 32-byte hex encryption key are required');
  if (n.redirectUri !== `${config.publicOrigin}/api/v1/integrations/notion/callback`)
    throw new Error('NOTION_REDIRECT_URI must match PUBLIC_ORIGIN/api/v1/integrations/notion/callback');
  if (n.templateUrl) {
    const url = new URL(n.templateUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(notion\.so|notion\.site)$/.test(url.hostname))
      throw new Error('NOTION_TEMPLATE_URL must be an HTTPS Notion page URL');
  }
}

export interface OAuthConfig {
  ownerUsername: string; clientId: string; clientName: string; redirectUris: string[];
  clientSecret?: string;
  accessTokenSeconds: number; grantSeconds: number; codeSeconds: number;
}

export function validateOAuth(config: Config) {
  if (!config.oauth) return;
  const o = config.oauth;
  const origin = new URL(config.publicOrigin);
  const loopback = !config.production && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== config.publicOrigin) throw new Error('OAuth PUBLIC_ORIGIN must be a canonical origin without path, credentials or trailing slash');
  if (origin.protocol !== 'https:' && !(loopback && origin.protocol === 'http:')) throw new Error('OAuth requires HTTPS (development loopback excepted)');
  if (!o.ownerUsername.trim() || !/^[\x21-\x7e]{1,200}$/.test(o.clientId) || !o.clientName.trim() || !o.redirectUris.length) throw new Error('OAuth owner, client ID/name and exact redirect URIs are required');
  for (const uri of o.redirectUris) {
    const url = new URL(uri);
    if (url.toString() !== uri || url.protocol !== 'https:' || url.username || url.password || url.hash || uri.includes('*')) throw new Error('OAuth redirect URIs must be exact HTTPS URLs without credentials, fragments or wildcards');
  }
  if (o.clientSecret && (o.clientSecret.length < 32 || o.clientSecret.startsWith('replace-'))) throw new Error('OAuth client secret is insecure');
  for (const [value, max] of [[o.accessTokenSeconds, 86400], [o.grantSeconds, 7776000], [o.codeSeconds, 300]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('OAuth token lifetime is outside its allowed range');
  }
  if (o.grantSeconds < o.accessTokenSeconds) throw new Error('OAuth grant lifetime must be at least the access token lifetime');
}

export function configuration(): Config {
  const required = (key: string, minimum = 1) => {
    const value = process.env[key];
    if (!value || value.length < minimum || value.startsWith('replace-')) throw new Error(`${key} is missing or insecure`);
    return value;
  };
  const production = process.env.NODE_ENV === 'production';
  const publicUrl = new URL(required('PUBLIC_ORIGIN'));
  const publicOrigin = publicUrl.origin;
  const internalHttp = publicUrl.protocol === 'http:' && isIPv4(publicUrl.hostname)
    && /^(192\.168|100\.64)\./.test(publicUrl.hostname);
  if (production && publicUrl.protocol !== 'https:' && !internalHttp) {
    throw new Error('Production requires an HTTPS PUBLIC_ORIGIN, except HTTP on 192.168.x.x or 100.64.x.x');
  }
  if (process.env.READ_API_TOKEN && process.env.READ_API_TOKEN.length < 32) throw new Error('READ_API_TOKEN must contain at least 32 characters');
  if (process.env.READ_API_TOKEN && process.env.READ_API_TOKEN === process.env.SYNC_TOKEN) throw new Error('Read and sync tokens must be different');
  const casdoorValues = [process.env.CASDOOR_ORIGIN, process.env.CASDOOR_CLIENT_ID, process.env.CASDOOR_CLIENT_SECRET];
  if (casdoorValues.some(Boolean) && casdoorValues.some(value => !value)) throw new Error('CASDOOR_ORIGIN, CASDOOR_CLIENT_ID and CASDOOR_CLIENT_SECRET must be configured together');
  const casdoor = casdoorValues.every(Boolean) ? {
    origin: new URL(process.env.CASDOOR_ORIGIN!).origin,
    clientId: process.env.CASDOOR_CLIENT_ID!,
    clientSecret: process.env.CASDOOR_CLIENT_SECRET!,
    redirectUri: process.env.CASDOOR_REDIRECT_URI || `${publicOrigin}/api/v1/auth/casdoor/callback`,
  } : undefined;
  const oauth = process.env.MCP_OAUTH_ENABLED === 'true' ? {
    ownerUsername: required('MCP_OWNER_USERNAME'), clientId: required('MCP_OAUTH_CLIENT_ID'),
    clientName: required('MCP_OAUTH_CLIENT_NAME'),
    redirectUris: required('MCP_OAUTH_REDIRECT_URIS').split(',').map(uri => uri.trim()),
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET || undefined,
    accessTokenSeconds: Number(process.env.MCP_OAUTH_ACCESS_TOKEN_SECONDS || 3600),
    grantSeconds: Number(process.env.MCP_OAUTH_GRANT_SECONDS || 2592000),
    codeSeconds: Number(process.env.MCP_OAUTH_CODE_SECONDS || 120),
  } : undefined;
  const config: Config = {
    databaseUrl: required('DATABASE_URL'), storageDir: path.resolve(process.env.STORAGE_DIR || '.local/storage'),
    adminUsername: required('ADMIN_USERNAME'), adminPassword: required('ADMIN_PASSWORD', 12),
    syncToken: required('SYNC_TOKEN', 32), readToken: process.env.READ_API_TOKEN,
    publicOrigin, production, trustProxy: process.env.TRUST_PROXY === 'true', logger: true, casdoor, oauth,
    notion: process.env.NOTION_ENABLED === 'true' ? {
      clientId: required('NOTION_CLIENT_ID'), clientSecret: required('NOTION_CLIENT_SECRET'),
      encryptionKey: required('NOTION_ENCRYPTION_KEY'),
      redirectUri: process.env.NOTION_REDIRECT_URI || `${publicOrigin}/api/v1/integrations/notion/callback`,
      templateUrl: process.env.NOTION_TEMPLATE_URL || undefined,
    } : undefined,
  };
  validateOAuth(config);
  validateNotion(config);
  return config;
}

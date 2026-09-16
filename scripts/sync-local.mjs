import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const origin = new URL(process.env.PUBLIC_ORIGIN);
if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('This helper only syncs to a local development server.');
mkdirSync('.local/client-state', { recursive: true });
const config = '.local/client-settings.json';
if (!existsSync(config)) writeFileSync(config, JSON.stringify({
  serverURL: origin.origin, deviceID: randomUUID(), deviceName: 'Neo 的 Mac',
  cliPath: '/usr/local/bin/dayflow', databasePath: path.join(homedir(), 'Library/Application Support/Dayflow/chunks.sqlite'),
  intervalMinutes: 30, paused: false,
}, null, 2), { mode: 0o600 });
const child = spawn('.local/Dayflow Sync.app/Contents/MacOS/DayflowSync', [
  process.argv.includes('--configure') ? '--configure' : '--sync-once', '--config', config, '--state-dir', '.local/client-state', '--token-env', 'DAYFLOW_DEVICE_TOKEN',
], { stdio: 'inherit', env: { ...process.env, DAYFLOW_DEVICE_TOKEN: process.env.SYNC_TOKEN } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

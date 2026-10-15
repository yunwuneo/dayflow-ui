// Never load .env. Start a disposable PostgreSQL cluster using existing local binaries.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const work = await mkdtemp(path.join(tmpdir(), 'dayflow-isolated-'));
const dbdir = path.join(work, 'pgdata'); const socket = path.join(work, 'socket');
await mkdir(socket);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(DATABASE_URL|ADMIN_|SYNC_TOKEN|READ_API_TOKEN|CASDOOR_|MCP_|NOTION_|PG|PUBLIC_ORIGIN|NODE_OPTIONS)/.test(key)) delete env[key];
delete env.DAYFLOW_QA_DIR;
env.NODE_ENV = 'test';
env.TEST_DATABASE_URL = `postgresql://fixture@localhost/dayflow_isolated_test?host=${encodeURIComponent(socket)}`;
env.DAYFLOW_TEST_ROOT = work;
if (process.argv.includes('--qa')) { env.DAYFLOW_QA_DIR = await mkdtemp(path.join(tmpdir(), 'dayflow-oauth-qa-')); console.log(`QA_DIR=${env.DAYFLOW_QA_DIR}`); }
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let started = false; let ui;
try {
  await run('initdb', ['-D', dbdir, '-U', 'fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8', '--no-sync'], { stdio: ['ignore', 'ignore', 'inherit'] });
  await run('pg_ctl', ['-D', dbdir, '-l', path.join(work, 'postgres.log'), '-o', `-h '' -k '${socket}' -c fsync=off -c synchronous_commit=off`, '-w', 'start'], { stdio: 'ignore' });
  started = true;
  await run('createdb', ['-h', socket, '-U', 'fixture', 'dayflow_isolated_test']);
  if (process.argv.includes('--ui')) {
    ui = spawn(process.execPath, ['--import', 'tsx', 'scripts/test-ui-server.ts'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const origin = await new Promise((resolve, reject) => {
      let output = '';
      ui.stdout.on('data', data => { output += data; const match = output.match(/ISOLATED_ORIGIN=(http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
      ui.on('error', reject); ui.on('exit', code => reject(new Error(`Fixture server exited ${code}`)));
    });
    env.PUBLIC_ORIGIN = origin;
    env.ADMIN_USERNAME = 'fixture-owner'; env.ADMIN_PASSWORD = 'fictional-password-for-tests';
    env.PLAYWRIGHT_CHANNEL = env.PLAYWRIGHT_CHANNEL || 'chrome';
    await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test']);
  } else {
    await run(process.execPath, ['--import', 'tsx', '--test', 'tests/config.test.ts', 'tests/server.test.ts', 'tests/oauth.test.ts', 'tests/notion.test.ts']);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (ui && ui.exitCode === null) { ui.kill('SIGTERM'); await new Promise(resolve => ui.once('exit', resolve)); }
  if (started) await run('pg_ctl', ['-D', dbdir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
  await rm(work, { recursive: true, force: true });
}

import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4310);
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(port, host, () => probe.close(resolve));
});
mkdirSync('.local', { recursive: true });
const log = openSync('.local/server.log', 'a', 0o600);
const child = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', 'server/index.ts'], {
  detached: true, stdio: ['ignore', log, log], env: process.env,
});
child.unref(); closeSync(log);
writeFileSync('.local/server.pid', String(child.pid));
for (let attempt = 0; attempt < 40; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 150));
  try {
    const response = await fetch(`http://${host}:${port}/health`);
    if (response.ok) { console.log(`Dayflow server: http://${host}:${port} (PID ${child.pid}; .local/server.log)`); process.exit(0); }
  } catch {}
}
console.error('Server did not become ready; inspect .local/server.log');
process.exit(1);

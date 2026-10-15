import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Config } from '../server/config.ts';

export function testDatabaseUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw && process.env.DAYFLOW_TEST_ROOT, 'Use npm test: a disposable database is required; .env databases are forbidden');
  const url = new URL(raw);
  assert.equal(url.pathname, '/dayflow_isolated_test');
  assert.equal(url.username, 'fixture');
  assert.equal(url.searchParams.get('host'), `${process.env.DAYFLOW_TEST_ROOT}/socket`);
  assert.match(process.env.DAYFLOW_TEST_ROOT, /\/dayflow-isolated-[A-Za-z0-9]+$/);
  return raw;
}
export async function verifyTestDatabase(pool: Pool) {
  const result = await pool.query("SELECT current_database() AS db,current_setting('data_directory') AS dir");
  assert.equal(result.rows[0].db, 'dayflow_isolated_test');
  assert.equal(result.rows[0].dir, `${process.env.DAYFLOW_TEST_ROOT}/pgdata`);
}
export function fixtureConfig(storage: string, databaseUrl = testDatabaseUrl(), publicOrigin = 'http://127.0.0.1:4310'): Config {
  return { databaseUrl, storageDir: storage, adminUsername: 'fixture-owner', adminPassword: 'fictional-password-for-tests',
    syncToken: 's'.repeat(48), readToken: 'r'.repeat(48), publicOrigin, production: false, trustProxy: false, logger: false,
    oauth: { ownerUsername: 'fixture-owner', clientId: 'fictional-client', clientName: '测试只读客户端', redirectUris: ['https://client.example.test/callback'],
      accessTokenSeconds: 3600, grantSeconds: 2592000, codeSeconds: 120 } };
}

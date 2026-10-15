import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../server/config.ts';

test('Production permits HTTP only for the configured internal IPv4 ranges', () => {
  const overrides = {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/dayflow',
    ADMIN_USERNAME: 'test', ADMIN_PASSWORD: 'a-long-test-password', SYNC_TOKEN: 's'.repeat(48),
    READ_API_TOKEN: '', CASDOOR_ORIGIN: '', CASDOOR_CLIENT_ID: '', CASDOOR_CLIENT_SECRET: '',
    PUBLIC_ORIGIN: '',
  };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    for (const origin of [
      'http://192.168.0.0', 'http://192.168.255.255:4310',
      'http://100.64.0.0', 'http://100.64.255.255:8080', 'https://dayflow.example.com',
    ]) {
      process.env.PUBLIC_ORIGIN = origin;
      const config = configuration();
      assert.equal(config.publicOrigin, origin);
      assert.equal(config.production, true);
    }
    for (const origin of [
      'http://192.167.255.255', 'http://192.169.0.0',
      'http://100.63.255.255', 'http://100.65.0.0',
      'http://10.0.0.1', 'http://172.16.0.1', 'http://127.0.0.1', 'http://[::1]',
      'http://dayflow.example.com', 'http://192.168.1.1.example.com', 'http://100.64.example.com',
      'http://192.168.1.1@evil.example.com', 'ftp://192.168.1.1',
    ]) {
      process.env.PUBLIC_ORIGIN = origin;
      assert.throws(() => configuration(), /Production requires an HTTPS PUBLIC_ORIGIN/, origin);
    }
    process.env.NODE_ENV = 'development';
    process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:4310';
    assert.equal(configuration().publicOrigin, process.env.PUBLIC_ORIGIN);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OAuth configuration fails closed for missing identity/client/callback and insecure URLs', async () => {
  const { fixtureConfig } = await import('./isolation.ts');
  const { validateOAuth } = await import('../server/config.ts');
  const config = fixtureConfig('/tmp/fictional-storage', 'postgresql://fixture@localhost/unused');
  assert.doesNotThrow(() => validateOAuth(config));
  for (const oauth of [
    { ...config.oauth!, ownerUsername: '' }, { ...config.oauth!, clientId: '' }, { ...config.oauth!, redirectUris: [] },
    { ...config.oauth!, redirectUris: ['https://client.example/*'] }, { ...config.oauth!, redirectUris: ['http://client.example/callback'] },
    { ...config.oauth!, redirectUris: ['https://client.example/callback#fragment'] }, { ...config.oauth!, redirectUris: ['https://user:pass@client.example/callback'] },
    { ...config.oauth!, accessTokenSeconds: 0 }, { ...config.oauth!, codeSeconds: 301 }, { ...config.oauth!, grantSeconds: 1 },
    { ...config.oauth!, clientSecret: 'replace-with-production-secret' },
  ]) assert.throws(() => validateOAuth({ ...config, oauth }));
  assert.throws(() => validateOAuth({ ...config, production: true }));
  assert.throws(() => validateOAuth({ ...config, publicOrigin: 'http://192.168.1.10', production: true }));
  assert.throws(() => validateOAuth({ ...config, publicOrigin: 'http://public.example.com' }));
  assert.throws(() => validateOAuth({ ...config, publicOrigin: 'https://dayflow.example.com/' }));
  assert.throws(() => validateOAuth({ ...config, publicOrigin: 'https://user:password@dayflow.example.com' }));
  assert.doesNotThrow(() => validateOAuth({ ...config, production: true, publicOrigin: 'https://dayflow.example.com' }));
});

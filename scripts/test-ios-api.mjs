import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('ios/build', { recursive: true });
const build = spawnSync('swiftc', ['-parse-as-library', '-swift-version', '6',
  'ios/Dayflow/Models.swift', 'ios/Dayflow/APIClient.swift', 'ios/tools/api-smoke.swift',
  '-o', 'ios/build/api-smoke'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const result = spawnSync('ios/build/api-smoke', [], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);

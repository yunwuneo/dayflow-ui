import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: process.env.DAYFLOW_TEST_ROOT ? `${process.env.DAYFLOW_TEST_ROOT}/browser-results` : 'test-results',
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  use: { baseURL: process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:4310', channel: process.env.PLAYWRIGHT_CHANNEL, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

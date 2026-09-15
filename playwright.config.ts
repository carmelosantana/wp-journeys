import { defineConfig } from '@playwright/test';

export default defineConfig({
  // R2: without this, Playwright's default testMatch also picks up the vitest suite in
  // tests/**/*.test.ts and tries to run it as browser tests.
  testDir: 'tests/e2e',
  // The harness serves trusted TLS, but a bare `.test` target may not — never let a cert
  // warning masquerade as a journey failure.
  use: { ignoreHTTPSErrors: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list']],
});

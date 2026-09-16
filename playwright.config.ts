import { defineConfig } from '@playwright/test';

export default defineConfig({
  // R2: without this, Playwright's default testMatch also picks up the vitest suite in
  // tests/**/*.test.ts and tries to run it as browser tests.
  testDir: 'tests/e2e',
  // One spec at a time. The specs share one scratch site, and wp-cli run by one of them
  // (conformance.spec.ts toggles and uninstalls a plugin) interrupts the other's navigations:
  // that is what produced a 22/23 flake.
  workers: 1,
  fullyParallel: false,
  // A focused spec silently drops every other proof, so it is an error, not a filter.
  forbidOnly: true,
  // A retry would turn a real failure into a pass. The runner retries navigation itself, once.
  retries: 0,
  // The harness serves trusted TLS, but a bare `.test` target may not — never let a cert
  // warning masquerade as a journey failure. No trace or screenshot settings: every spec
  // launches its own browser, so they would configure nothing.
  use: { ignoreHTTPSErrors: true },
  reporter: [['list']],
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.spec.ts'],
    // Task 10's journeys live in tests/e2e and are Playwright specs. The include pattern above
    // matches them too, and vitest would run them as unit tests the moment they land.
    exclude: ['tests/e2e/**'],
  },
});

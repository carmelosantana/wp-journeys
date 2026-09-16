/**
 * R101: the project's own live proofs must never pass having proved nothing. These are
 * regression pins on the source; the behaviour itself is proven by running the proofs.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('the live proofs (R101)', () => {
  it('never skip an e2e spec: Playwright exits 0 on a skip', async () => {
    for (const file of await readdir(join(ROOT, 'tests', 'e2e'))) {
      expect(await readFile(join(ROOT, 'tests', 'e2e', file), 'utf8'), file).not.toMatch(/test\.skip\s*\(/);
    }
  });

  it('never focus, park or skip a spec or a group in any other way either', async () => {
    // `.only` silently drops every other proof; `.fixme` and `describe.skip` are skips by
    // another name, and Playwright reports every one of them as a green run.
    const forbidden = /\b(?:test|describe)(?:\.describe)?\.(?:only|fixme|skip)\s*\(/;
    for (const file of await readdir(join(ROOT, 'tests', 'e2e'))) {
      expect(await readFile(join(ROOT, 'tests', 'e2e', file), 'utf8'), file).not.toMatch(forbidden);
    }
    for (const sample of ['test.only(', 'test.fixme(', 'test.describe.skip(', 'describe.skip(', 'test.describe.only(']) {
      expect(sample).toMatch(forbidden);
    }
  });

  it('run the e2e specs one at a time, with no retries, and refuse a focused spec in the config', async () => {
    // wp-cli in conformance.spec.ts interrupting frontend-renders.spec.ts in a parallel worker is
    // what produced a 22/23 flake; a retry would have hidden it as a pass.
    const { default: config } = await import('../playwright.config.ts');
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.forbidOnly).toBe(true);
    expect(config.retries).toBe(0);
    // Every spec launches its own browser, so these would configure nothing.
    expect(config.use).not.toHaveProperty('trace');
    expect(config.use).not.toHaveProperty('screenshot');
  });

  it('read the runner\'s one name for wp-cli, WPJ_WP, and nothing else', async () => {
    for (const file of ['tests/e2e/conformance.spec.ts', 'scripts/prove-login-minting.sh']) {
      const text = await readFile(join(ROOT, file), 'utf8');
      expect(text, file).toContain('WPJ_WP');
      expect(text, file).not.toContain('WPJ_WP_CLI');
    }
  });

  it('make the login-minting proof exit non-zero when any check skipped', async () => {
    const text = await readFile(join(ROOT, 'scripts', 'prove-login-minting.sh'), 'utf8');
    expect(text).toMatch(/if \[ "\$SKIPPED" -gt 0 \]; then[\s\S]*exit 1/);
  });

  it('never let the e2e clean-up run wp-cli against a target the setup refused', async () => {
    const text = await readFile(join(ROOT, 'tests', 'e2e', 'conformance.spec.ts'), 'utf8');
    expect(text).toMatch(/test\.afterAll\(async \(\) => \{[^}]*if \(!TARGETS_SCRATCH\) return;/);
  });

  it('refuse, in the login-minting proof, any wp-cli or base URL that is not the scratch site, before the first call (R103)', async () => {
    const text = await readFile(join(ROOT, 'scripts', 'prove-login-minting.sh'), 'utf8');
    const guard = text.indexOf('must target wpjtest');
    expect(guard).toBeGreaterThan(-1);
    // Before the first wp-cli call and the first agent call.
    expect(guard).toBeLessThan(text.indexOf('wp_cli user'));
    expect(guard).toBeLessThan(text.indexOf('BASELINE="$(api'));
    expect(text.slice(guard - 400, guard + 200)).toMatch(/exit 2/);
  });
});

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
});

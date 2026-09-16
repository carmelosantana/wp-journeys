import { describe, expect, it } from 'vitest';

import { isSitePath } from '../src/site-path.ts';

describe('isSitePath (R86: a path on THIS site, and nothing that leaves it)', () => {
  it('accepts a path that starts with exactly one slash', () => {
    for (const path of ['/', '/wp-admin/', '/wp-admin/options-general.php?page=acme', '/?p=1#x', '/a//b']) {
      expect(isSitePath(path), path).toBe(true);
    }
  });

  it('refuses anything that could resolve to another origin, or is not a path at all', () => {
    for (const path of [
      '//evil.example/',        // protocol-relative
      '/\\evil.example/',       // browsers read a backslash as a slash
      '\\\\evil.example/',
      '/\t/evil.example/',      // the URL parser strips tabs and newlines anywhere
      '/\n/evil.example/',
      'https://evil.example/',  // a scheme
      'javascript:alert(1)',
      'wp-admin/',              // relative
      '',
      ' /wp-admin/',
    ]) {
      expect(isSitePath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

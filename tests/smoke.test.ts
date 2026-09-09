import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/version.ts';

describe('smoke', () => {
  it('exposes a version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

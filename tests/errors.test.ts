import { describe, expect, it } from 'vitest';

import { MIN_SECRET_LENGTH, loadConfig } from '../src/config.ts';
import { redactSecret } from '../src/errors.ts';

describe('redactSecret (M1: one scrub, shared by every place text leaves the process)', () => {
  const secret = 'fixture-secret-not-real-0123456789';

  it('removes every occurrence of the secret', () => {
    expect(redactSecret(`a ${secret} b ${secret}`, secret)).toBe('a <REDACTED> b <REDACTED>');
  });

  it('leaves text alone when there is no usable secret — a short value is never sent anywhere', () => {
    expect(redactSecret('a short b', 'short')).toBe('a short b');
    expect(redactSecret('text', '')).toBe('text');
    expect(redactSecret('text', undefined)).toBe('text');
  });

  it('scrubs exactly the secrets loadConfig accepts, by the same minimum', () => {
    const shortest = 'y'.repeat(MIN_SECRET_LENGTH);
    expect(() => loadConfig({ WPJ_BASE_URL: 'https://s.test', WPJ_AGENT_SECRET: shortest })).not.toThrow();
    expect(() => loadConfig({ WPJ_BASE_URL: 'https://s.test', WPJ_AGENT_SECRET: shortest.slice(1) })).toThrow();
    expect(redactSecret(`[${shortest}]`, shortest)).toBe('[<REDACTED>]');
    expect(redactSecret(`[${shortest.slice(1)}]`, shortest.slice(1))).toBe(`[${shortest.slice(1)}]`);
  });
});

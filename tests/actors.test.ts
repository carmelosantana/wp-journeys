import { describe, expect, it } from 'vitest';

import { ALL_ACTORS, Actor, isAnonymous, usernameFor } from '../src/actors/roles.ts';
import { loadConfig } from '../src/config.ts';

describe('the actor set', () => {
  it('is exactly six, with anonymous first', () => {
    expect(ALL_ACTORS).toEqual([
      'anonymous', 'subscriber', 'contributor', 'author', 'editor', 'administrator',
    ]);
  });

  it('treats anonymous as the one actor without a login', () => {
    expect(isAnonymous(Actor.ANONYMOUS)).toBe(true);
    expect(isAnonymous(Actor.SUBSCRIBER)).toBe(false);
  });

  it('names a WordPress user for every actor except anonymous', () => {
    expect(usernameFor(Actor.EDITOR)).toBe('wpj_editor');
    expect(usernameFor(Actor.ANONYMOUS)).toBe('');
  });
});

describe('loadConfig', () => {
  it('reads the base URL and secret from the environment', () => {
    const cfg = loadConfig({ WPJ_BASE_URL: 'https://wpjtest.wp.test', WPJ_AGENT_SECRET: 'x'.repeat(16) });
    expect(cfg.baseUrl).toBe('https://wpjtest.wp.test');
  });

  it('refuses a target that is not local, so the runner cannot be pointed at production', () => {
    expect(() => loadConfig({ WPJ_BASE_URL: 'https://example.com', WPJ_AGENT_SECRET: 'x'.repeat(16) }))
      .toThrow(/refusing a non-local target/);
  });

  it('refuses a short secret', () => {
    expect(() => loadConfig({ WPJ_BASE_URL: 'https://wpjtest.wp.test', WPJ_AGENT_SECRET: 'short' }))
      .toThrow(/at least 16 characters/);
  });

  it('refuses a missing base URL rather than defaulting to something', () => {
    expect(() => loadConfig({ WPJ_AGENT_SECRET: 'x'.repeat(16) })).toThrow(/WPJ_BASE_URL/);
  });
});

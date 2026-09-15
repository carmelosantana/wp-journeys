import { readFileSync } from 'node:fs';

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

  it('names the same user the agent provisions, so a rename cannot land on only one side', () => {
    // These two definitions sit on opposite sides of the wire: TypeScript decides who to ask
    // for, PHP decides who to create. Nothing else would catch them drifting apart.
    const php = readFileSync(new URL('../mu-plugin/src/actors.php', import.meta.url), 'utf8');
    const prefix = php.match(/\?\s*'([a-z_]+)'\s*\.\s*\$role\s*:/)?.[1];

    expect(prefix, 'wpj_actor_login() no longer reads as "<prefix>" . $role').toBeDefined();
    expect(`${prefix}${Actor.EDITOR}`).toBe(usernameFor(Actor.EDITOR));
  });
});

describe('loadConfig', () => {
  it('reads the base URL and secret from the environment', () => {
    const cfg = loadConfig({ WPJ_BASE_URL: 'https://wpjtest.wp.test', WPJ_AGENT_SECRET: 'x'.repeat(16) });
    expect(cfg.baseUrl).toBe('https://wpjtest.wp.test');
  });

  it('accepts the IPv6 loopback, which is no less this machine than 127.0.0.1', () => {
    const cfg = loadConfig({ WPJ_BASE_URL: 'http://[::1]:8080', WPJ_AGENT_SECRET: 'x'.repeat(16) });
    expect(cfg.baseUrl).toBe('http://[::1]:8080');
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

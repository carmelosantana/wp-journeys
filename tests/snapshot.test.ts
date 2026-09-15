import { describe, expect, it } from 'vitest';

import { hasOrphans, orphansAfterUninstall } from '../src/discovery/snapshot.ts';
import type { Snapshot } from '../src/discovery/snapshot.ts';

const before: Snapshot = {
  options: ['siteurl', 'blogname'],
  tables: ['wp_posts', 'wp_options'],
  cron: ['wp_version_check'],
  userMeta: ['nickname'],
};

describe('orphansAfterUninstall', () => {
  it('reports nothing when uninstall restored the original state', () => {
    const orphans = orphansAfterUninstall(before, { ...before });
    expect(orphans).toEqual({ options: [], tables: [], cron: [], userMeta: [] });
    expect(hasOrphans(orphans)).toBe(false);
  });

  it('names every kind of leftover the plugin failed to remove', () => {
    const after: Snapshot = {
      options: ['siteurl', 'blogname', 'acme_settings', 'acme_version'],
      tables: ['wp_posts', 'wp_options', 'wp_acme_log'],
      cron: ['wp_version_check', 'acme_daily_sync'],
      userMeta: ['nickname', 'acme_seen_intro'],
    };

    const orphans = orphansAfterUninstall(before, after);

    expect(orphans).toEqual({
      options: ['acme_settings', 'acme_version'],
      tables: ['wp_acme_log'],
      cron: ['acme_daily_sync'],
      userMeta: ['acme_seen_intro'],
    });
    expect(hasOrphans(orphans)).toBe(true);
  });

  it('ignores keys the site removed during the run rather than calling them orphans', () => {
    const after: Snapshot = { options: ['siteurl'], tables: ['wp_posts'], cron: [], userMeta: [] };
    expect(hasOrphans(orphansAfterUninstall(before, after))).toBe(false);
  });

  it('does not treat a transient created during the run as a plugin orphan', () => {
    const after: Snapshot = {
      ...before,
      options: [...before.options, '_transient_doing_cron', '_site_transient_timeout_theme_roots'],
    };
    expect(orphansAfterUninstall(before, after).options).toEqual([]);
  });
});

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

  describe('a cron hook scheduled lazily by code that is still loaded (Task 11/12 carry-forward)', () => {
    // Observed on wpjtest: core schedules wp_delete_temp_updater_backups lazily, so a run whose
    // baseline predates that write blamed it on the plugin under test. After the uninstall the
    // plugin is not loaded, so a hook that still has a callback belongs to core or another
    // active plugin — never to the plugin under test.
    const after: Snapshot = {
      ...before,
      cron: ['wp_version_check', 'wp_delete_temp_updater_backups', 'acme_daily_sync'],
      cronHandled: ['wp_version_check', 'wp_delete_temp_updater_backups'],
    };

    it('is not the plugin\'s orphan when a callback still answers it after the uninstall', () => {
      expect(orphansAfterUninstall(before, after).cron).toEqual(['acme_daily_sync']);
    });

    it('still reports an added hook nothing answers — the uninstalled plugin was its only handler', () => {
      expect(hasOrphans(orphansAfterUninstall(before, after))).toBe(true);
    });

    it('excludes nothing when the agent did not say which hooks are handled — failing loud, not quiet', () => {
      const { cronHandled: _unused, ...unsaid } = after;
      expect(orphansAfterUninstall(before, unsaid).cron)
        .toEqual(['wp_delete_temp_updater_backups', 'acme_daily_sync']);
    });
  });
});

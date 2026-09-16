/**
 * The uninstall-orphan check: what a plugin left behind after it was told to remove itself.
 *
 * Pure: a diff of two snapshots. The snapshots themselves come from the agent.
 */

/** Names of the persistent state WordPress keeps, at one moment in time. */
export interface Snapshot {
  options: string[];
  tables: string[];
  cron: string[];
  userMeta: string[];
  /**
   * The `cron` hooks some code loaded at snapshot time still answers (`has_action`). Optional
   * because an older agent does not send it; absent means "unknown", and nothing is excluded.
   */
  cronHandled?: string[];
}

/** What survived an uninstall that should not have. */
export type Orphans = Omit<Snapshot, 'cronHandled'>;

/**
 * Transients are WordPress's own cache, created and expired by core and by unrelated code
 * throughout a run. They are never evidence that the plugin under test failed to clean up,
 * so they are excluded rather than reported — otherwise every run would show false orphans.
 */
function isTransient(option: string): boolean {
  return option.startsWith('_transient_') || option.startsWith('_site_transient_');
}

export function orphansAfterUninstall(before: Snapshot, after: Snapshot): Orphans {
  const handled = new Set(after.cronHandled ?? []);
  const added = (was: string[], now: string[]): string[] => {
    const had = new Set(was);
    return now.filter((name) => !had.has(name));
  };

  return {
    options: added(before.options, after.options).filter((o) => !isTransient(o)),
    tables: added(before.tables, after.tables),
    // A new hook that still has a callback AFTER the uninstall is not this plugin's: the plugin
    // is no longer loaded, so the callback is core's or another active plugin's. Core schedules
    // some of its own events lazily (wp_delete_temp_updater_backups, observed on wpjtest), and a
    // baseline taken before that write would otherwise blame it on whatever was under test.
    cron: added(before.cron, after.cron).filter((hook) => !handled.has(hook)),
    userMeta: added(before.userMeta, after.userMeta),
  };
}

/** True when anything at all was left behind. */
export function hasOrphans(orphans: Orphans): boolean {
  return (
    orphans.options.length > 0 ||
    orphans.tables.length > 0 ||
    orphans.cron.length > 0 ||
    orphans.userMeta.length > 0
  );
}

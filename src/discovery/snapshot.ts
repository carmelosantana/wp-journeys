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
   * The `cron` hooks whose EVERY callback is defined in core (wp-includes, wp-admin) — R79.
   * Optional because an older agent does not send it; absent means "unknown", excluding nothing.
   */
  cronCore?: string[];
  /**
   * Whether the plugin the snapshot was asked about is in active_plugins. Only present when the
   * snapshot was asked about one; absent is "unknown", never "inactive".
   */
  pluginActive?: boolean;
}

/** What survived an uninstall that should not have. */
export type Orphans = Omit<Snapshot, 'cronCore' | 'pluginActive'>;

/**
 * Transients are WordPress's own cache, created and expired by core and by unrelated code
 * throughout a run. They are never evidence that the plugin under test failed to clean up,
 * so they are excluded rather than reported — otherwise every run would show false orphans.
 */
function isTransient(option: string): boolean {
  return option.startsWith('_transient_') || option.startsWith('_site_transient_');
}

export function orphansAfterUninstall(before: Snapshot, after: Snapshot): Orphans {
  const core = new Set(after.cronCore ?? []);
  const added = (was: string[], now: string[]): string[] => {
    const had = new Set(was);
    return now.filter((name) => !had.has(name));
  };

  return {
    options: added(before.options, after.options).filter((o) => !isTransient(o)),
    tables: added(before.tables, after.tables),
    // A new hook that ONLY core answers is core's own lazy write (wp_delete_temp_updater_backups,
    // observed on wpjtest), not this plugin's orphan. "Only core", not "anything" (R79): a plugin
    // that leaves an mu-plugin or drop-in behind still answers its own orphaned hook.
    cron: added(before.cron, after.cron).filter((hook) => !core.has(hook)),
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

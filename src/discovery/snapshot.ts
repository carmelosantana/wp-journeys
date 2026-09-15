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
}

/** What survived an uninstall that should not have. */
export type Orphans = Snapshot;

/**
 * Transients are WordPress's own cache, created and expired by core and by unrelated code
 * throughout a run. They are never evidence that the plugin under test failed to clean up,
 * so they are excluded rather than reported — otherwise every run would show false orphans.
 */
function isTransient(option: string): boolean {
  return option.startsWith('_transient_') || option.startsWith('_site_transient_');
}

export function orphansAfterUninstall(before: Snapshot, after: Snapshot): Orphans {
  const added = (was: string[], now: string[]): string[] => {
    const had = new Set(was);
    return now.filter((name) => !had.has(name));
  };

  return {
    options: added(before.options, after.options).filter((o) => !isTransient(o)),
    tables: added(before.tables, after.tables),
    cron: added(before.cron, after.cron),
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

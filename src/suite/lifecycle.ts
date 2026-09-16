/**
 * Activate → use → deactivate → uninstall, watching the sentinel throughout, then diff the
 * snapshot for orphans.
 *
 * The read-back discipline in miniature: "the plugin said it uninstalled" is not evidence.
 * The evidence is that its options, tables, cron events and user meta are gone.
 *
 * WHAT THIS CAN AND CANNOT SEE (R7a). Orphan detection is complete only on a site where the
 * plugin under test has NEVER been activated. On a reused site it sees only the state created
 * during this run: the baseline is captured after a deactivate, so anything an earlier
 * activation left behind is already in `before` and is never reported.
 *
 * WHY CORE'S OWN LAZY WRITES ARE NOT REPORTED AS THE PLUGIN'S. WordPress writes state of its
 * own during a run — `recently_activated` is written by every deactivate, wp-cli's included
 * (verified on WP 7.1 by deleting the option, running `wp plugin deactivate`, and watching it
 * come back). It is never attributed here, and not by luck: `captureBaseline` runs its
 * `deactivate()` BEFORE it snapshots, so that option exists in `before` on any site this runner
 * has ever baselined. The ordering is the guarantee — which is why `captureBaseline` owns the
 * deactivate rather than leaving it to a caller.
 */
import { Actor } from '../actors/roles.ts';
import type { AgentClient } from '../agent/client.ts';
import { hasOrphans, orphansAfterUninstall } from '../discovery/snapshot.ts';
import type { Journey } from '../journeys/index.ts';
import { runAsActor } from '../journeys/support.ts';
import type { Baseline } from './baseline.ts';

/**
 * @param baseline captured with the plugin DEACTIVATED (see captureBaseline)
 * @param uninstall deactivates and uninstalls the plugin under test
 */
export function lifecycle(plugin: string, baseline: Baseline, uninstall: () => Promise<void>): Journey {
  const name = `lifecycle:${plugin}`;
  return {
    name,
    actor: Actor.ADMINISTRATOR,
    surface: 'admin',
    run: async (browser, cfg, agent: AgentClient) => {
      const result = await runAsActor(browser, cfg, agent, name, Actor.ADMINISTRATOR, 'admin', async (page, sentinel, note) => {
        // Touch the dashboard while active: an activation fatal usually shows here first.
        await sentinel.visit(page, '/wp-admin/');

        // NOTE: this runs wp-cli with the page still open, which provokes
        // net::ERR_NETWORK_CHANGED on any in-flight subresource. That is why the classifiers
        // suppress it — the noise is self-inflicted and unavoidable here.
        await uninstall();

        const after = await agent.snapshot(plugin);
        // The orphan diff below assumes the plugin is GONE: its code no longer loaded, so a
        // hook it still answers is not mistaken for core's. Unknown is not gone.
        if (after.pluginActive === undefined) {
          throw new Error(`the agent could not say whether ${plugin} is still active after the uninstall — the orphan check cannot be trusted`);
        }
        if (after.pluginActive) {
          throw new Error(`${plugin} is still active after the uninstall — it was never removed, so nothing about its leftovers was checked`);
        }
        const orphans = orphansAfterUninstall(baseline.snapshot, after);
        if (hasOrphans(orphans)) {
          // Thrown, not pushed: `runAsActor` records a thrown body as an `assertion` finding
          // (R3), so this lands in `findings` like every other defect and the sentinel is
          // still drained afterwards.
          throw new Error(
            `${plugin} left state behind after uninstall: ` +
              `options=${orphans.options.join(', ') || 'none'}; ` +
              `tables=${orphans.tables.join(', ') || 'none'}; ` +
              `cron=${orphans.cron.join(', ') || 'none'}; ` +
              `userMeta=${orphans.userMeta.join(', ') || 'none'}`,
          );
        }
        if (!baseline.activeAtStart) {
          note(`sound only if ${plugin} was never activated on this site before this run: state an earlier activation left behind is already in the baseline`);
        }
        return 0;
      });
      // R75. A baseline taken with the plugin ACTIVE already contains whatever its activation
      // created, which is exactly what an uninstall routine must remove, so a clean diff here
      // proves nothing. A skip, never an ok — and orphans it found anyway still fail, because a
      // finding wins over a skip in outcomeOf.
      if (!baseline.activeAtStart) return result;
      const why = `${plugin} was already active when the baseline was taken, so state its activation created `
        + 'predates the baseline and its leftovers are invisible — run on a site where it was never activated';
      if (result.findings.length > 0) {
        // A red row prints no skipReason, so the caveat travels as a note: the orphans it lists
        // are real, but the list may be incomplete.
        return { ...result, notes: [...(result.notes ?? []), `orphans listed here may be incomplete: ${why}`] };
      }
      return { ...result, skipped: true, skipReason: why };
    },
  };
}

/**
 * Capture what the site looks like WITHOUT the plugin under test.
 *
 * Everything the conformance suite attributes to a plugin is a delta against this. Skipping it
 * would blame the theme's deprecations and another plugin's admin screens on whatever happens
 * to be under test.
 *
 * Three deltas are anchored here, and each of them is a whole class of false result:
 *  - the SURFACE, so another plugin's screens are never driven as this one's;
 *  - the SNAPSHOT, so another plugin's options and tables are never reported as this one's
 *    uninstall orphans;
 *  - the per-request LOG NOISE (R45), so a deprecation this site writes on every request is not
 *    reported once per journey as a defect of the plugin under test.
 */
import { ALL_ACTORS, isAnonymous } from '../actors/roles.ts';
import type { AgentClient } from '../agent/client.ts';
import type { Snapshot } from '../discovery/snapshot.ts';
import { projectSurface } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { classifyPhpLogLine, type Finding } from '../sentinel/phplog.ts';

export interface Baseline {
  surface: Surface;
  snapshot: Snapshot;
  /**
   * The debug.log diagnostics this site writes on EVERY request, with the plugin under test
   * off. Subtracted from a journey's findings by `withoutBaselineNoise`.
   */
  logNoise: string[];
}

/**
 * Create the runner's own users BEFORE the snapshot is taken (R36).
 *
 * `ensureActor` stamps `wpj_actor` user meta, and the snapshot reports user-meta KEY NAMES. A
 * baseline captured before the actors exist would see `wpj_actor` appear afterwards and report
 * it as state the plugin under test left behind — a false orphan on every plugin.
 *
 * It is done here rather than left to the caller for the same reason `runAsActor` owns its
 * sentinel: an ordering rule that a caller must remember is an ordering rule that will be got
 * wrong, and getting it wrong is silent.
 */
async function provisionActors(agent: AgentClient): Promise<void> {
  for (const actor of ALL_ACTORS) {
    // Anonymous has no user, and asking for one is refused by the agent.
    if (isAnonymous(actor)) continue;
    await agent.ensureActor(actor);
  }
}

/**
 * What this site writes to debug.log during one ordinary request.
 *
 * The sentinel's own `logDelta` round trip is itself a WordPress request, so anything the site
 * emits per request is written around that read and lands in the window — with nothing to
 * distinguish it from a diagnostic the journey's navigation provoked. Measuring it against the
 * same shape of request is what makes it subtractable.
 *
 * An unavailable log signal yields no noise rather than a guess: under-subtracting costs a
 * false red, which the sentinel is already reporting loudly, and over-subtracting would cost a
 * false green.
 */
async function measureLogNoise(agent: AgentClient): Promise<string[]> {
  // Size-only, never logDelta(0): that pulls the whole file back to learn a length (R33).
  const start = await agent.logDelta('end');
  if (!start.available) return [];
  await agent.status();
  const delta = await agent.logDelta(start.offset);
  if (!delta.available) return [];

  const texts = new Set<string>();
  for (const line of delta.lines) {
    const finding = classifyPhpLogLine(line);
    if (finding) texts.add(finding.text);
  }
  return [...texts];
}

/**
 * @param deactivate turn the plugin under test OFF (caller supplies; usually a wp-cli call)
 * @param activate   turn it back ON
 */
export async function captureBaseline(
  agent: AgentClient,
  deactivate: () => Promise<void>,
  activate: () => Promise<void>,
): Promise<Baseline> {
  await deactivate();
  try {
    await provisionActors(agent);
    const surface = projectSurface(await agent.discover());
    const snapshot = await agent.snapshot();
    const logNoise = await measureLogNoise(agent);
    return { surface, snapshot, logNoise };
  } finally {
    // Even when the read failed. A baseline that threw half way through would otherwise leave
    // the plugin under test deactivated, and every journey after it would drive a site the
    // plugin is not even installed on — and pass.
    await activate();
  }
}

/**
 * Drop the diagnostics this site writes whatever is under test (R45).
 *
 * Only the `phplog` signal is subtracted: the baseline is measured from debug.log alone, so it
 * is evidence about nothing else. EVERY occurrence goes, not one per baseline line — a journey
 * that loads three pages writes the site's per-request notice three times, and taking one off
 * would leave two false reds behind.
 *
 * The trade-off, stated plainly: a diagnostic from the plugin under test whose text is
 * character-for-character one the site already emits without it is subtracted too. By
 * definition that text is not attributable to the plugin, which is the same rule the surface
 * and snapshot deltas follow.
 */
export function withoutBaselineNoise(findings: readonly Finding[], baseline: Baseline): Finding[] {
  const noise = new Set(baseline.logNoise);
  return findings.filter((finding) => !(finding.kind === 'phplog' && noise.has(finding.text)));
}

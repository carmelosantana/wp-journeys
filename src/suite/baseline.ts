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
import type { Config } from '../config.ts';
import type { Snapshot } from '../discovery/snapshot.ts';
import { projectSurface } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { messageOf } from '../errors.ts';
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

/** One shape of ordinary WordPress request, used to see what it writes to the log. */
type Probe = () => Promise<void>;

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
 * Drive one request and classify the debug.log window it produced, or `null` when the log
 * signal was unavailable and this sample therefore says nothing.
 */
async function sampleWindow(agent: AgentClient, probe: Probe): Promise<Set<string> | null> {
  // Size-only, never logDelta(0): that pulls the whole file back to learn a length (R33).
  const start = await agent.logDelta('end');
  if (!start.available) return null;
  await probe();
  const delta = await agent.logDelta(start.offset);
  if (!delta.available) return null;

  const texts = new Set<string>();
  for (const line of delta.lines) {
    const finding = classifyPhpLogLine(line);
    if (finding) texts.add(finding.text);
  }
  return texts;
}

/**
 * What this site writes to debug.log on EVERY request of a given shape.
 *
 * Each probe is sampled TWICE and only the intersection is kept (R48). debug.log is shared:
 * WP-Cron firing during a window, or the deactivate wp-cli call's own tail, drops in a line
 * that is not per-request noise at all — and because the subtraction then removes every
 * occurrence of that text for the whole run, a single-sample probe is the one route by which
 * this mechanism could hide a genuine defect. Two samples make "per request" a measurement
 * rather than an inference from n=1.
 *
 * An unavailable log signal yields no noise rather than a guess: under-subtracting costs a
 * false red, which the sentinel is already reporting loudly, and over-subtracting would cost a
 * false green.
 */
async function measureLogNoise(agent: AgentClient, probes: Probe[]): Promise<string[]> {
  const noise = new Set<string>();
  for (const probe of probes) {
    const first = await sampleWindow(agent, probe);
    const second = await sampleWindow(agent, probe);
    if (!first || !second) continue;
    for (const text of first) {
      if (second.has(text)) noise.add(text);
    }
  }
  return [...noise];
}

/**
 * @param cfg        the target site; only its base URL is used, to drive a front-end render
 * @param deactivate turn the plugin under test OFF (caller supplies; usually a wp-cli call)
 * @param activate   turn it back ON
 * @param fetchImpl  injectable so the probe is testable without a network
 */
export async function captureBaseline(
  agent: AgentClient,
  cfg: Config,
  deactivate: () => Promise<void>,
  activate: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): Promise<Baseline> {
  const probes: Probe[] = [
    // The shape the sentinel's own logDelta round trip makes, which is why its noise lands in
    // every journey's window.
    async () => { await agent.status(); },
    // A front-end render (R49). wp_head, the theme and the whole template path never run on a
    // REST request, so a REST-only probe is structurally blind to the most common source of
    // per-request noise on a real site.
    async () => {
      const response = await fetchImpl(cfg.baseUrl);
      // Drain the body: the render, and every diagnostic it writes, must be complete before
      // the log window is read.
      await response.text();
    },
  ];

  let failure: unknown;
  try {
    // INSIDE the try (R47). wp-cli can deactivate the plugin and still exit non-zero — a
    // shutdown notice, a deactivation-hook warning, a timeout after the write landed. With this
    // call outside, the site keeps the plugin OFF and every later journey drives a site the
    // plugin is not even on, and passes.
    await deactivate();
    await provisionActors(agent);
    const surface = projectSurface(await agent.discover());
    const snapshot = await agent.snapshot();
    const logNoise = await measureLogNoise(agent, probes);
    return { surface, snapshot, logNoise };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await activate();
    } catch (reactivation) {
      // Both facts matter: why the baseline was abandoned, and that the site is now missing the
      // plugin it was testing. Reporting only the second hides the first.
      if (failure === undefined) throw reactivation;
      throw new Error(
        `${messageOf(failure)}\n…and the plugin under test could not be reactivated afterwards: ${messageOf(reactivation)}`,
      );
    }
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
 * and snapshot deltas follow — and the two-sample rule above is what keeps a one-off line from
 * ever entering this set.
 */
export function withoutBaselineNoise(findings: readonly Finding[], baseline: Baseline): Finding[] {
  const noise = new Set(baseline.logNoise);
  return findings.filter((finding) => !(finding.kind === 'phplog' && noise.has(finding.text)));
}

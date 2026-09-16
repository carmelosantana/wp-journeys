/**
 * Capture what the site looks like WITHOUT the plugin under test.
 *
 * Everything the conformance suite attributes to a plugin is a delta against this. Skipping it
 * would blame the theme's deprecations and another plugin's admin screens on whatever happens
 * to be under test.
 *
 * Several deltas are anchored here, and each of them is a whole class of false result:
 *  - the SURFACE, so another plugin's screens are never driven as this one's;
 *  - the SNAPSHOT, so another plugin's options and tables are never reported as this one's
 *    uninstall orphans;
 *  - the per-request LOG NOISE (R45), so a deprecation this site writes on every request is not
 *    reported once per journey as a defect of the plugin under test;
 *  - the per-request BODY NOISE (R60), the same thing for a diagnostic PRINTED into the response
 *    instead of logged — which is what `WP_DEBUG_DISPLAY` does, and which the log signal cannot
 *    reach because nothing need be written to the log at all.
 */
import type { Browser } from '@playwright/test';

import { ALL_ACTORS, isAnonymous } from '../actors/roles.ts';
import {
  AGENT_TIMEOUT_MS, AgentBadResponseError, AgentTimeoutError, isAbort, redirectOrigin, type AgentClient,
} from '../agent/client.ts';
import type { Config } from '../config.ts';
import type { Snapshot } from '../discovery/snapshot.ts';
import { projectSurface } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { messageOf } from '../errors.ts';
import { openActorSession } from '../journeys/support.ts';
import { scanBody } from '../sentinel/classify.ts';
import { classifyPhpLogLine, type Finding } from '../sentinel/phplog.ts';

export interface Baseline {
  surface: Surface;
  snapshot: Snapshot;
  /**
   * The debug.log diagnostics this site writes on EVERY request, with the plugin under test
   * off. Subtracted from a journey's findings by `withoutBaselineNoise`.
   */
  logNoise: string[];
  /**
   * The same, for diagnostics PRINTED into the response body. Held as URL-INDEPENDENT keys, not
   * as finding texts: `scanBody` embeds the URL it scanned, and the baseline only ever probes
   * the site root, so a text-keyed set would never match the same per-request warning seen on
   * `/wp-admin/` and the false red would survive everywhere but the home page.
   */
  bodyNoise: string[];
  /**
   * Whether the plugin under test was ACTIVE when the baseline was taken (R75). If it was,
   * whatever its activation created is already in `snapshot`, so the orphan check cannot see
   * it. An agent that cannot say is read as `true`: unknown must never earn a pass.
   */
  activeAtStart: boolean;
}

/** One shape of ordinary WordPress request, used to see what it emits. */
interface Probe {
  /** Where the body came from; only used to build the finding `bodyNoiseKey` then strips. */
  url: string;
  /** Drive the request, returning a body to scan, or `null` when there is none worth scanning. */
  run(): Promise<string | null>;
}

/** What one probe emitted through each signal. */
interface Sample {
  /** `null` means the log signal was LOST for this window — which is not the same as clean. */
  log: Set<string> | null;
  body: Set<string>;
}

/**
 * A body finding reduced to what is comparable across URLs.
 *
 * `scanBody` puts the URL it scanned inside `text`, so two sightings of one per-request warning
 * differ by exactly that. Replacing the finding's own URL with a placeholder is what makes them
 * compare equal — the baseline only ever probes the site root, so a whole-text key would never
 * match the same warning seen on `/wp-admin/`.
 *
 * WHAT MUST SURVIVE THAT STRIPPING (R63). Everything identifying the defect — message, file and
 * line — because whatever is left IS the key. While `scanBody`'s text held only the severity and
 * the URL, stripping the URL left the bare word `Warning`, and a per-request theme warning
 * observed once by the baseline then deleted a plugin's genuine `Undefined array key` from every
 * journey at every URL, silently and run-wide. R48's twice-sampled rule is no guard here: it
 * governs what ENTERS the noise set, never how much a single entry then matches.
 */
function bodyNoiseKey(finding: Finding): string {
  return finding.url ? finding.text.split(finding.url).join('<url>') : finding.text;
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

/** Where a warm-up login lands: the dashboard, whose widgets write their own user meta. */
const WARM_UP_SCREEN = '/wp-admin/';

/**
 * Log every logged-in actor in ONCE, through the ordinary session, before the snapshot (I8).
 *
 * The snapshot reports user-meta KEY NAMES across all users. On a site where nobody has logged
 * in yet, the runner's own first logins — made AFTER the baseline — write core's per-user keys:
 * `session_tokens`, `wp_dashboard_quick_press_last_post_id` and `community-events-location` when
 * the dashboard renders. The orphan check then blamed all three on the plugin under test. Logging
 * in here, with the plugin deactivated, puts them in the baseline where they belong.
 *
 * A warm-up that fails is a failed baseline, loudly: the suite's own logins would fail the same
 * way, and a baseline taken without them reintroduces the false orphans. What the visits observe
 * is otherwise not judged — the plugin is off, so nothing here is attributable to it.
 */
async function warmUpLogins(browser: Browser, cfg: Config, agent: AgentClient): Promise<void> {
  for (const actor of ALL_ACTORS) {
    if (isAnonymous(actor)) continue;
    const opened = await openActorSession(browser, cfg, agent, actor);
    if (!opened.ok) {
      throw new Error(
        `warm-up login as ${actor} failed, so the baseline cannot hold the user meta a first login writes — `
          + opened.findings.map((finding) => finding.text).join('; '),
      );
    }
    const { session } = opened;
    try {
      session.sentinel.expect({ denyExpected: false });
      const verdict = await session.sentinel.visit(session.page, WARM_UP_SCREEN);
      if (verdict.length > 0) {
        throw new Error(
          `warm-up visit to ${WARM_UP_SCREEN} as ${actor} failed — ${verdict.map((finding) => finding.text).join('; ')}`,
        );
      }
    } finally {
      await session.close();
    }
  }
}

/**
 * Drive one request and classify what it emitted through both signals.
 *
 * The two are independent evidence and are kept that way: the probe runs even when the log
 * signal is unavailable, so a site with `WP_DEBUG_LOG` off still gets its body noise measured.
 * Coupling them would withhold one subtraction because the other could not be made.
 */
async function sampleWindow(agent: AgentClient, probe: Probe): Promise<Sample> {
  // Size-only, never logDelta(0): that pulls the whole file back to learn a length (R33).
  const start = await agent.logDelta('end');
  const body = await probe.run();

  const bodyKeys = new Set<string>();
  if (body !== null) {
    // EVERY diagnostic the render printed (R64). Measuring only the first leaves the rest
    // unmeasured, and an unmeasured per-request diagnostic is reported as a defect of whatever
    // plugin happens to be under test, on every journey, for the whole run.
    for (const finding of scanBody(body, probe.url)) bodyKeys.add(bodyNoiseKey(finding));
  }

  if (!start.available) return { log: null, body: bodyKeys };
  const delta = await agent.logDelta(start.offset);
  if (!delta.available) return { log: null, body: bodyKeys };

  const texts = new Set<string>();
  for (const line of delta.lines) {
    const finding = classifyPhpLogLine(line);
    if (finding) texts.add(finding.text);
  }
  return { log: texts, body: bodyKeys };
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
async function measureNoise(
  agent: AgentClient,
  probes: Probe[],
): Promise<{ log: string[]; body: string[] }> {
  const log = new Set<string>();
  const body = new Set<string>();
  for (const probe of probes) {
    const first = await sampleWindow(agent, probe);
    const second = await sampleWindow(agent, probe);
    if (first.log && second.log) {
      for (const text of first.log) {
        if (second.log.has(text)) log.add(text);
      }
    }
    // The same twice-sampled discipline, for the same reason: the subtraction removes EVERY
    // occurrence for the whole run, so a one-off body diagnostic entering this set would strip a
    // genuine defect carrying that severity from every journey.
    for (const key of first.body) {
      if (second.body.has(key)) body.add(key);
    }
  }
  return { log: [...log], body: [...body] };
}

/**
 * @param cfg        the target site; only its base URL is used, to drive a front-end render
 * @param plugin     the plugin under test's slug, asked about BEFORE the deactivate erases the answer
 * @param deactivate turn the plugin under test OFF (caller supplies; usually a wp-cli call)
 * @param activate   turn it back ON
 * @param browser    drives the warm-up logins (I8); launched before the site is touched
 * @param fetchImpl  injectable so the probe is testable without a network
 */
export async function captureBaseline(
  agent: AgentClient,
  cfg: Config,
  plugin: string,
  deactivate: () => Promise<void>,
  activate: () => Promise<void>,
  browser: Browser,
  fetchImpl: typeof fetch = fetch,
): Promise<Baseline> {
  const probes: Probe[] = [
    // The shape the sentinel's own logDelta round trip makes, which is why its noise lands in
    // every journey's window. Its body is JSON from the agent, not a rendered page, so there is
    // nothing there the body scanner should judge.
    { url: cfg.baseUrl, run: async () => { await agent.status(); return null; } },
    // A front-end render (R49). wp_head, the theme and the whole template path never run on a
    // REST request, so a REST-only probe is structurally blind to the most common source of
    // per-request noise on a real site.
    {
      url: cfg.baseUrl,
      run: async () => {
        // Never followed, and bounded, like every agent request: a redirected home page is not
        // the render this probe exists to measure, and a hang is not a measurement.
        let response: Response;
        try {
          response = await fetchImpl(cfg.baseUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
          });
        } catch (error) {
          if (isAbort(error)) {
            throw new AgentTimeoutError(
              `the front-end probe of ${cfg.baseUrl} did not answer within ${AGENT_TIMEOUT_MS / 1000} s — is the site up?`,
            );
          }
          throw error;
        }
        if (response.status >= 300 && response.status < 400) {
          throw new AgentBadResponseError(
            `the front-end probe of ${cfg.baseUrl} redirected (HTTP ${response.status}) to `
              + `${redirectOrigin(response.headers.get('location'), cfg.baseUrl)}, so it measured no render. `
              + 'WPJ_BASE_URL is probably wrong: set it to the site\'s canonical home address.',
          );
        }
        // Drained for two reasons now: the render and every diagnostic it writes must be
        // complete before the log window is read, AND the body itself is evidence (R60). It used
        // to be read and thrown away, which is why body noise cost nothing to start measuring.
        return response.text();
      },
    },
  ];

  let failure: unknown;
  try {
    // INSIDE the try (R47). wp-cli can deactivate the plugin and still exit non-zero — a
    // shutdown notice, a deactivation-hook warning, a timeout after the write landed. With this
    // call outside, the site keeps the plugin OFF and every later journey drives a site the
    // plugin is not even on, and passes.
    // R75: read BEFORE the deactivate, which makes every plugin look inactive.
    const activeAtStart = (await agent.status(plugin)).pluginActive !== false;
    await deactivate();
    await provisionActors(agent);
    // After the users exist and BEFORE the snapshot: a first login's own user meta is baseline.
    await warmUpLogins(browser, cfg, agent);
    const surface = projectSurface(await agent.discover());
    const snapshot = await agent.snapshot();
    const noise = await measureNoise(agent, probes);
    return { surface, snapshot, logNoise: noise.log, bodyNoise: noise.body, activeAtStart };
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
 * Drop the diagnostics this site emits whatever is under test (R45, R60).
 *
 * Two signals are subtracted, each against evidence measured through that same signal and no
 * other: `phplog` against what the baseline saw in debug.log, and `bodyscan` against what it saw
 * printed into a rendered body. Neither vouches for the other — a body diagnostic is not
 * subtracted because a log line happened to carry the same words, and vice versa. Every other
 * signal (`response`, `console`, `pageerror`, `requestfailed`, `assertion`) is left entirely
 * alone: the baseline is not evidence about any of them. A `pageerror` in particular is NEVER
 * noise — an uncaught exception is the page's own code failing, and the baseline never measures
 * the browser at all.
 *
 * EVERY occurrence goes, not one per baseline entry — a journey that loads three pages emits the
 * site's per-request notice three times, and taking one off would leave two false reds behind.
 *
 * The trade-off, stated plainly: a diagnostic from the plugin under test that is
 * indistinguishable from one the site already emits without it is subtracted too. By definition
 * it is not attributable to the plugin, which is the same rule the surface and snapshot deltas
 * follow — and the two-sample rule above is what keeps a one-off from ever entering either set.
 */
export function withoutBaselineNoise(
  findings: readonly Finding[], baseline: Pick<Baseline, 'logNoise' | 'bodyNoise'>,
): Finding[] {
  const logNoise = new Set(baseline.logNoise);
  const bodyNoise = new Set(baseline.bodyNoise);
  return findings.filter((finding) => {
    if (finding.kind === 'phplog') return !logNoise.has(finding.text);
    if (finding.kind === 'bodyscan') return !bodyNoise.has(bodyNoiseKey(finding));
    return true;
  });
}

/** How much of one subtracted text a note quotes. */
const NOTE_TEXT_LIMIT = 120;

/**
 * The row note that says what `withoutBaselineNoise` removed, or `null` when it removed nothing.
 *
 * The subtraction is correct and still must not be silent: a plugin making the same core misuse
 * as the theme has that finding erased, and a row reading `ok` with no trace of it is a false
 * green in the making. A note never changes the outcome; it makes the discount visible.
 *
 * @param before the journey's findings as it reported them
 * @param after  what `withoutBaselineNoise` kept of them (the same objects)
 */
export function baselineNoiseNote(before: readonly Finding[], after: readonly Finding[]): string | null {
  const kept = new Set(after);
  const removed = before.filter((finding) => !kept.has(finding));
  if (removed.length === 0) return null;
  const texts = [...new Set(removed.map((finding) => finding.text))].map((text) => (
    text.length > NOTE_TEXT_LIMIT ? `${text.slice(0, NOTE_TEXT_LIMIT)}…` : text
  ));
  const counted = removed.length === 1
    ? '1 finding matched this site\'s baseline noise and was not counted'
    : `${removed.length} findings matched this site's baseline noise and were not counted`;
  return `${counted}: ${texts.join('; ')}`;
}

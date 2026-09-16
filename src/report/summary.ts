/**
 * The run summary: pure, deterministic, and the only thing most people will read.
 *
 * It gives three things: a header that counts pass/fail/skip separately, one line per
 * journey, and an indented breakdown of every finding under the journey that produced it —
 * so a PHP notice is chaseable from the terminal without opening a trace.
 *
 * PURITY IS A REQUIREMENT, NOT A STYLE. Nothing here reads a clock, a duration, a path or an
 * environment variable, and nothing iterates a Map or an object whose key order is incidental:
 * the journey lines come out in the order the caller ran them. Identical input therefore gives
 * a byte-identical string, which is what makes this diffable between runs and testable without
 * a fixture.
 *
 * It does NOT decide outcomes. `outcomeOf` does, and this module calls it for every result —
 * including the skip tally. Reading `result.skipped` directly here would reintroduce exactly
 * the defect the global constraints forbid: a journey that skipped AND lost a signal would
 * print as a benign skip instead of the failure it is.
 */
import type { Surface } from '../discovery/types.ts';
import { outcomeOf } from '../journeys/index.ts';
import type { JourneyResult, Outcome, SurfaceAxis } from '../journeys/index.ts';
import type { Finding } from '../sentinel/phplog.ts';

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The finding's own `text`, which every signal is contracted to make self-contained. The kind
 * is prefixed so a reader can tell an observation (`phplog`, `response`) from the journey's own
 * verdict (`assertion`) at a glance.
 */
export function renderFinding(finding: Finding): string {
  return `      - [${finding.kind}] ${finding.text}`;
}

/**
 * The three outcomes get three visibly different labels. `skip` is deliberately not `ok` and
 * not blank — a permanently-skipping journey must stay legible as a journey that asserted
 * NOTHING, which is the whole reason skip is a third outcome rather than a flavour of pass.
 */
function labelFor(outcome: Outcome, findingCount: number): string {
  if (outcome === 'fail') return `FAIL(${findingCount})`;
  return outcome === 'skip' ? 'skip' : 'ok';
}

/** One journey's row, exactly as the summary prints it — also the MCP `run_journey` result (R88). */
export function renderJourney(result: JourneyResult): string {
  const outcome = outcomeOf(result);
  const label = labelFor(outcome, result.findings.length);
  let head = `  ${label.padEnd(8)} ${result.name} (${result.actor}/${result.surface}) entitiesCreated=${result.entitiesCreated}`;
  if (outcome === 'skip') {
    // A skip with no reason is a legal shape, so the fallback is a real sentence rather than an
    // empty pair of brackets that would read as a rendering bug and invite dismissal.
    head += ` — skipped (${result.skipReason ?? 'no reason given'})`;
  }
  const lines = [head, ...(result.notes ?? []).map((note) => `      · ${note}`)];
  if (outcome === 'fail') lines.push(...result.findings.map(renderFinding));
  return lines.join('\n');
}

interface SurfaceCoverage {
  /** Journeys that actually drove this half — passed or failed. */
  exercised: number;
  /** Journeys aimed at this half, skips included. */
  total: number;
}

/**
 * How much of each half of WordPress was actually EXERCISED, and how much was merely aimed at
 * (R58). `both` counts toward each half.
 *
 * A skipped journey asserted nothing about its surface, so counting it as coverage is the
 * binding constraint's defect relocated into a statistic: a header reading `admin: 8` beside six
 * skipped sweeps tells a reader the admin surface is well covered when one journey ran. Both
 * numbers are rendered rather than the skips being hidden, because the gap is the interesting
 * part — it is what says "this plugin registered no admin screens", not "the admin half is fine".
 */
function coverage(
  results: JourneyResult[],
  outcomes: Outcome[],
): Record<Exclude<SurfaceAxis, 'both'>, SurfaceCoverage> {
  const counts = {
    admin: { exercised: 0, total: 0 },
    frontend: { exercised: 0, total: 0 },
  };
  results.forEach((result, index) => {
    // A failure IS coverage: the journey drove the surface and found something there. Only a
    // skip drove nothing.
    const exercised = outcomes[index] !== 'skip';
    for (const half of ['admin', 'frontend'] as const) {
      if (result.surface !== half && result.surface !== 'both') continue;
      counts[half].total += 1;
      if (exercised) counts[half].exercised += 1;
    }
  });
  return counts;
}

/** Said out loud, because `0 journeys: 0 passed…` otherwise reads like a clean run. */
const EMPTY_RUN =
  '  no journeys ran — a suite that registers nothing asserts nothing, and must not report success';

/**
 * What the run attributed to the plugin, listed (first contact). Without it an `ok` admin sweep
 * says nothing about what it swept: a discovery that found one screen of three reads exactly
 * like one that found all three. REST routes are counted, not listed — no journey drives them
 * yet, and a real plugin registers dozens.
 */
function renderSurface(surface: Surface): string[] {
  const lines = [
    `  discovered: ${plural(surface.screens.length, 'admin screen')}, ${plural(surface.shortcodes.length, 'shortcode')}`
      + `, ${plural(surface.blocks.length, 'block')}, ${plural(surface.restRoutes.length, 'REST route')}`,
  ];
  for (const screen of surface.screens) lines.push(`    screen    ${screen.url} (${screen.capability})`);
  for (const tag of surface.shortcodes) lines.push(`    shortcode [${tag}]`);
  for (const block of surface.blocks) lines.push(`    block     ${block}`);
  return lines;
}

/**
 * @param surface what the run attributed to the plugin under test; listed under the header
 *   when given
 */
export function renderSummary(results: JourneyResult[], surface?: Surface): string {
  const outcomes = results.map(outcomeOf);
  const failed = outcomes.filter((o) => o === 'fail').length;
  const skipped = outcomes.filter((o) => o === 'skip').length;
  const passed = outcomes.filter((o) => o === 'pass').length;
  const surfaces = coverage(results, outcomes);

  const header =
    `${plural(results.length, 'journey')}: ${passed} passed, ${failed} failed, ${skipped} skipped` +
    ` — coverage admin: ${surfaces.admin.exercised} of ${surfaces.admin.total}` +
    `, frontend: ${surfaces.frontend.exercised} of ${surfaces.frontend.total}`;

  const discovered = surface ? renderSurface(surface) : [];
  if (results.length === 0) return [header, ...discovered, EMPTY_RUN].join('\n');
  return [header, ...discovered, ...results.map(renderJourney)].join('\n');
}

/**
 * A skip does not fail a run, but it is never silent — the summary always names it.
 *
 * The exit code is derived from the same `outcomeOf` the text is, so the number and the words
 * can never disagree. A green exit beside a printed FAIL would be the worst outcome of all: CI
 * would believe the number.
 */
export function exitCodeFor(results: JourneyResult[]): number {
  // The floor. A run with no journeys at all asserted nothing, and the exit code is the one
  // signal CI believes — a suite that silently registered nothing would otherwise be
  // indistinguishable from a suite that ran clean.
  if (results.length === 0) return 1;
  return results.some((r) => outcomeOf(r) === 'fail') ? 1 : 0;
}

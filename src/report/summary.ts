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
import { outcomeOf } from '../journeys/index.ts';
import type { JourneyResult, Outcome, SurfaceAxis } from '../journeys/index.ts';
import type { Finding } from '../sentinel/phplog.ts';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The finding's own `text`, which every signal is contracted to make self-contained. The kind
 * is prefixed so a reader can tell an observation (`phplog`, `response`) from the journey's own
 * verdict (`assertion`) at a glance.
 */
function renderFinding(finding: Finding): string {
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

function renderJourney(result: JourneyResult): string {
  const outcome = outcomeOf(result);
  const label = labelFor(outcome, result.findings.length);
  let head = `  ${label.padEnd(8)} ${result.name} (${result.actor}/${result.surface}) entitiesCreated=${result.entitiesCreated}`;
  if (outcome === 'skip') {
    // A skip with no reason is a legal shape, so the fallback is a real sentence rather than an
    // empty pair of brackets that would read as a rendering bug and invite dismissal.
    head += ` — skipped (${result.skipReason ?? 'no reason given'})`;
  }
  if (outcome !== 'fail') return head;
  return `${head}\n${result.findings.map(renderFinding).join('\n')}`;
}

/** How many journeys touched each half of WordPress. `both` counts for each. */
function coverage(results: JourneyResult[]): Record<Exclude<SurfaceAxis, 'both'>, number> {
  const counts = { admin: 0, frontend: 0 };
  for (const result of results) {
    if (result.surface === 'admin' || result.surface === 'both') counts.admin += 1;
    if (result.surface === 'frontend' || result.surface === 'both') counts.frontend += 1;
  }
  return counts;
}

export function renderSummary(results: JourneyResult[]): string {
  const outcomes = results.map(outcomeOf);
  const failed = outcomes.filter((o) => o === 'fail').length;
  const skipped = outcomes.filter((o) => o === 'skip').length;
  const passed = outcomes.filter((o) => o === 'pass').length;
  const surfaces = coverage(results);

  const header =
    `${plural(results.length, 'journey')}: ${passed} passed, ${failed} failed, ${skipped} skipped` +
    ` — coverage admin: ${surfaces.admin}, frontend: ${surfaces.frontend}`;

  return [header, ...results.map(renderJourney)].join('\n');
}

/**
 * A skip does not fail a run, but it is never silent — the summary always names it.
 *
 * The exit code is derived from the same `outcomeOf` the text is, so the number and the words
 * can never disagree. A green exit beside a printed FAIL would be the worst outcome of all: CI
 * would believe the number.
 */
export function exitCodeFor(results: JourneyResult[]): number {
  return results.some((r) => outcomeOf(r) === 'fail') ? 1 : 0;
}

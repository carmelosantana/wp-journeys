/** The journey registry and the single definition of a run's outcome. */
import type { Journey, JourneyResult } from './types.ts';

export type { Journey, JourneyResult, SurfaceAxis } from './types.ts';

/**
 * The ONE place pass/fail/skip is decided.
 *
 * A finding always wins over a skip: if a journey skipped because its plugin is absent but
 * the gate probe itself hit a 5xx, that is a real failure of the core, not an absent plugin.
 *
 * A half-declared skip — `skipReason` set but `skipped` not `true` — is refused rather than
 * read as a pass. Nothing downstream can tell that shape from a clean run, so the one place
 * that could catch it must throw (R39).
 */
export function outcomeOf(result: JourneyResult): 'pass' | 'fail' | 'skip' {
  if (result.skipReason !== undefined && result.skipped !== true) {
    throw new Error(
      `journey "${result.name}" carries skipReason "${result.skipReason}" without skipped: true — a half-declared skip would render as a pass.`,
    );
  }
  if (result.findings.length > 0) return 'fail';
  if (result.skipped) return 'skip';
  return 'pass';
}

/**
 * Build a registry keyed by name, refusing duplicates loudly.
 *
 * The accumulator has no prototype: on a plain `{}` a journey named `toString` reads as already
 * present, and one named `__proto__` swaps the prototype instead of becoming a key and vanishes
 * from `Object.keys` — the silent drop the duplicate check exists to prevent.
 */
export function register(...journeys: Journey[]): Record<string, Journey> {
  const registry: Record<string, Journey> = Object.create(null);
  for (const journey of journeys) {
    if (Object.hasOwn(registry, journey.name)) {
      throw new Error(`duplicate journey name "${journey.name}" — names are the registry key.`);
    }
    registry[journey.name] = journey;
  }
  return registry;
}

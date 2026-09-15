/** The journey registry and the single definition of a run's outcome. */
import type { Journey, JourneyResult } from './types.ts';

export type { Journey, JourneyResult, SurfaceAxis } from './types.ts';

/**
 * The ONE place pass/fail/skip is decided.
 *
 * A finding always wins over a skip: if a journey skipped because its plugin is absent but
 * the gate probe itself hit a 5xx, that is a real failure of the core, not an absent plugin.
 */
export function outcomeOf(result: JourneyResult): 'pass' | 'fail' | 'skip' {
  if (result.findings.length > 0) return 'fail';
  if (result.skipped) return 'skip';
  return 'pass';
}

/** Build a registry keyed by name, refusing duplicates loudly. */
export function register(...journeys: Journey[]): Record<string, Journey> {
  const registry: Record<string, Journey> = {};
  for (const journey of journeys) {
    if (registry[journey.name]) {
      throw new Error(`duplicate journey name "${journey.name}" — names are the registry key.`);
    }
    registry[journey.name] = journey;
  }
  return registry;
}

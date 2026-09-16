/** The built-in conformance suite: the SDK's first consumer. */
import { ALL_ACTORS } from '../actors/roles.ts';
import { surfaceDelta } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { register } from '../journeys/index.ts';
import type { Journey } from '../journeys/index.ts';
import type { Baseline } from './baseline.ts';
import { frontendRenders } from './frontend-renders.ts';
import { lifecycle } from './lifecycle.ts';
import { adminSweep, shortcodeRender } from './rendered-surface.ts';

export type { AccessCase } from './admin-access-matrix.ts';
export { accessMatrix } from './admin-access-matrix.ts';

/**
 * What the suite drives: the screens the plugin ADDED, judged against the site's REAL
 * capability map.
 *
 * Both halves matter, and they come from different places. `surfaceDelta` is what keeps another
 * plugin's screens from being driven as this one's — but its `caps` are a delta too, reporting
 * only the capabilities the plugin ADDED to each role. Handing that straight to `accessMatrix`
 * would say the administrator holds nothing, and every screen would come out as an expected
 * denial for its own administrator: the entire sweep inverted, and quietly.
 *
 * So the capability map is taken from `after` — the site as it is with the plugin active, which
 * is the site the sweep actually drives.
 *
 * @param before the surface with the plugin under test DEACTIVATED (`baseline.surface`)
 * @param after  the surface with it active
 */
export function conformanceSurface(before: Surface, after: Surface): Surface {
  return { ...surfaceDelta(before, after), caps: after.caps };
}

export function coreSuite(
  plugin: string,
  delta: Surface,
  baseline: Baseline,
  uninstall: () => Promise<void>,
): Record<string, Journey> {
  return register(
    frontendRenders,
    ...ALL_ACTORS.map((actor) => adminSweep(plugin, delta, actor)),
    shortcodeRender(plugin, delta),
    // Uninstall runs last: it removes the plugin the other journeys need.
    lifecycle(plugin, baseline, uninstall),
  );
}

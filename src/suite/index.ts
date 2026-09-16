/** The built-in conformance suite: the SDK's first consumer. */
import { ALL_ACTORS, Actor } from '../actors/roles.ts';
import { surfaceDelta } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { register } from '../journeys/index.ts';
import type { Journey } from '../journeys/index.ts';
import type { Baseline } from './baseline.ts';
import { frontendRenders } from './frontend-renders.ts';
import { lifecycle } from './lifecycle.ts';
import { adminSweep, blockRender, deprecatedShortcodeRender, shortcodeRender } from './rendered-surface.ts';

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
/** Who renders the discovered blocks and shortcodes (R77). */
const RENDER_ACTORS = [Actor.ADMINISTRATOR, Actor.ANONYMOUS] as const;

export function conformanceSurface(before: Surface, after: Surface): Surface {
  return { ...surfaceDelta(before, after), caps: after.caps };
}

/**
 * @param deprecatedShortcodes tags the manifest declares deprecated (R74); each renders on its own row
 * @param authored the plugin's own journeys, from its manifest. They run after the discovered
 *   surface and BEFORE the lifecycle journey, which uninstalls the plugin every other journey
 *   needs. A name that collides with a core journey is refused by `register`, never dropped.
 */
export function coreSuite(
  plugin: string,
  delta: Surface,
  baseline: Baseline,
  uninstall: () => Promise<void>,
  authored: readonly Journey[] = [],
  deprecatedShortcodes: readonly string[] = [],
): Record<string, Journey> {
  return register(
    frontendRenders,
    ...ALL_ACTORS.map((actor) => adminSweep(plugin, delta, actor)),
    // R77: logged in AND anonymously, as the spec's core-suite step says.
    ...RENDER_ACTORS.flatMap((actor) => [
      shortcodeRender(plugin, delta, actor, deprecatedShortcodes),
      // R74, R80: each declared-deprecated tag on its own row, so its discount reaches only it.
      ...deprecatedShortcodes.map((tag) => deprecatedShortcodeRender(plugin, tag, actor)),
    ]),
    ...RENDER_ACTORS.map((actor) => blockRender(plugin, delta, actor)),
    ...authored,
    // Uninstall runs last: it removes the plugin the other journeys need.
    lifecycle(plugin, baseline, uninstall),
  );
}

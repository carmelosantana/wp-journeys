/**
 * Decide, for every screen the plugin added and every actor, whether that actor should be
 * allowed in or denied.
 *
 * Pure, and deliberately so: this is the whole judgement of the permission sweep, and it is
 * worth far more test coverage than the browser code that carries it out.
 *
 * The `Surface` handed in must carry the SITE'S capability map, not `surfaceDelta`'s — that
 * one reports only the capabilities a plugin ADDED, so `caps.administrator` there is usually
 * empty and every screen would come out as a denial for its own administrator. `conformanceSurface`
 * (src/suite/index.ts) is what pairs the added screens with the live capability map.
 */
import { isAnonymous, type Actor } from '../actors/roles.ts';
import type { AdminScreen, Surface } from '../discovery/types.ts';

export interface AccessCase {
  screen: AdminScreen;
  actor: Actor;
  /** True when this actor must be refused. The sentinel turns that into a passing assertion. */
  denyExpected: boolean;
}

export function accessMatrix(delta: Surface, actors: readonly Actor[]): AccessCase[] {
  const cases: AccessCase[] = [];
  for (const screen of delta.screens) {
    for (const actor of actors) {
      // Anonymous holds no capabilities, so wp-admin is always a denial for it. A role the
      // site does not define at all is read the same way — absent means nothing held, never
      // "unrestricted", or a genuine permission hole would pass as an expected 200.
      const held = isAnonymous(actor) ? [] : (delta.caps[actor] ?? []);
      cases.push({ screen, actor, denyExpected: !held.includes(screen.capability) });
    }
  }
  return cases;
}

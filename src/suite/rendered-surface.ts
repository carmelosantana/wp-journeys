/**
 * Drive every admin screen the plugin added, as one actor, asserting allow or deny per the
 * matrix; and render every shortcode it added on the frontend.
 */
import { Actor, isAnonymous } from '../actors/roles.ts';
import type { Surface } from '../discovery/types.ts';
import type { Journey, JourneyResult, SurfaceAxis } from '../journeys/index.ts';
import { runAsActor } from '../journeys/support.ts';
import { accessMatrix } from './admin-access-matrix.ts';

/**
 * A journey whose SUBJECT is absent, declared as the third outcome rather than run.
 *
 * A body with nothing to assert returns cleanly and renders as `ok`, which is the one thing
 * this runner must never do. `skipped` and `skipReason` travel together, because `outcomeOf`
 * throws on a half-declared skip (R39).
 */
function skipped(name: string, actor: Actor, surface: SurfaceAxis, reason: string): JourneyResult {
  return { name, actor, surface, entitiesCreated: 0, findings: [], skipped: true, skipReason: reason };
}

/** One assertion the sweep makes: a URL, and whether this actor must be refused there. */
export interface SweepStep {
  url: string;
  denyExpected: boolean;
}

/**
 * A screen every logged-in role can reach, and no logged-out visitor can (R54).
 *
 * `profile.php` needs only `read`, which subscriber upwards all hold, and WordPress bounces an
 * anonymous request for it to wp-login.php.
 */
const CONTROL_SCREEN = '/wp-admin/profile.php';

/**
 * What an actor's sweep will assert, in order. Pure, so the interesting part is testable.
 *
 * Two things the naive "one visit per AccessCase" loop got wrong:
 *
 * THE CONTROL VISIT (R54). Every denial this sweep expects is also satisfied by WordPress's
 * login redirect, so a sweep whose login was silently refused runs as an anonymous visitor and
 * passes having proved nothing — for four of the six actors. One screen asserted as ALLOWED,
 * which only a real session can reach, makes that impossible: a secretly-anonymous sweep fails
 * on its first step. Anonymous gets no control visit, having no session to prove.
 *
 * ONE URL, ONE ASSERTION (R56). A promoted container and its first submenu are two SCREENS at
 * one URL. Visiting it twice asserts nothing extra, and if the two ever carried different
 * capabilities the second expectation would be a guaranteed false defect against the plugin
 * under test. (`projectSurface` moves the submenu's capability with its URL so they agree; this
 * is the second half of that guarantee.)
 */
export function sweepPlan(delta: Surface, actor: Actor): SweepStep[] {
  const steps: SweepStep[] = [];
  if (!isAnonymous(actor)) steps.push({ url: CONTROL_SCREEN, denyExpected: false });

  const asserted = new Set<string>();
  for (const testCase of accessMatrix(delta, [actor])) {
    const { url } = testCase.screen;
    if (asserted.has(url)) continue;
    asserted.add(url);
    steps.push({ url, denyExpected: testCase.denyExpected });
  }
  return steps;
}

/** One journey per actor: that actor sweeps every screen the plugin added. */
export function adminSweep(plugin: string, delta: Surface, actor: Actor): Journey {
  const name = `admin-sweep:${plugin}:${actor}`;
  return {
    name,
    actor,
    surface: 'admin',
    run: async (browser, cfg, agent) => {
      if (delta.screens.length === 0) {
        return skipped(name, actor, 'admin', `${plugin} added no admin screens to sweep`);
      }
      return runAsActor(browser, cfg, agent, name, actor, 'admin', async (page, sentinel) => {
        for (const step of sweepPlan(delta, actor)) {
          sentinel.expect({ denyExpected: step.denyExpected });
          // visit() asserts the status against that expectation — a permitted screen must be
          // 2xx (so a mistyped discovered URL fails loudly) and a denied one must be 403/401,
          // or WordPress's login redirect, which is how it refuses a logged-out visitor.
          await sentinel.visit(page, step.url);
        }
        return 0;
      });
    },
  };
}

/** The frontend URL that renders `[tag]` through the agent's render endpoint. */
export function shortcodeRenderUrl(tag: string): string {
  return `/?wpj_render=${encodeURIComponent(`[${tag}]`)}`;
}

/**
 * Why a render of `[tag]` proved nothing, or `null` when it expanded.
 *
 * The render itself is not the assertion (R5). If the agent's guard refused, `?wpj_render=`
 * serves the ordinary home page with a perfectly good 200 and the journey would pass having
 * rendered nothing at all. So each tag is proven twice over:
 *  - `[data-wpj-render]` is present, which only the agent's endpoint emits — the proof it ran;
 *  - the literal `[tag]` is gone, which is the proof the shortcode EXPANDED. WordPress returns
 *    an unregistered shortcode verbatim, so a tag that never registered reads as its own text.
 *
 * Pure, and shared with the manifest interpreter so a manifest's shortcodes are held to the
 * same proof as the discovered ones.
 */
export function shortcodeRenderDefect(html: string, tag: string): string | null {
  if (!html.includes('data-wpj-render')) {
    return `rendering [${tag}] produced no wp-journeys render marker — the agent's render `
      + 'endpoint did not run, so nothing about this shortcode was actually asserted';
  }
  if (html.includes(`[${tag}]`)) {
    return `the shortcode [${tag}] came back verbatim — WordPress returns an unregistered `
      + 'shortcode unchanged, so it never expanded';
  }
  return null;
}

/** Render every shortcode the plugin added, on the front end, as an administrator. */
export function shortcodeRender(plugin: string, delta: Surface): Journey {
  const name = `shortcode-render:${plugin}`;
  return {
    name,
    actor: Actor.ADMINISTRATOR,
    surface: 'both',
    run: async (browser, cfg, agent) => {
      if (delta.shortcodes.length === 0) {
        return skipped(name, Actor.ADMINISTRATOR, 'both', `${plugin} registered no shortcodes`);
      }
      return runAsActor(browser, cfg, agent, name, Actor.ADMINISTRATOR, 'both', async (page, sentinel) => {
        // Render through the front end so the shortcode runs in its real context.
        for (const tag of delta.shortcodes) {
          await sentinel.visit(page, shortcodeRenderUrl(tag));
          const defect = shortcodeRenderDefect(await page.content(), tag);
          if (defect) throw new Error(defect);
        }
        return 0;
      });
    },
  };
}

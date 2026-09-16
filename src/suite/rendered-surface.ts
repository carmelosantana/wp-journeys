/**
 * Drive every admin screen the plugin added, as one actor, asserting allow or deny per the
 * matrix; and render every shortcode and every block it added on the frontend.
 */
import { Actor, isAnonymous } from '../actors/roles.ts';
import { blockRenderUrl, blockRenderVerdict, shortcodeRenderDefect, shortcodeRenderUrl } from '../agent/render.ts';
import type { Surface } from '../discovery/types.ts';
import type { Journey, JourneyResult, SurfaceAxis } from '../journeys/index.ts';
import { CONTROL_SCREEN, runAsActor } from '../journeys/support.ts';
import { accessMatrix } from './admin-access-matrix.ts';
import { discountDeclaredDeprecation } from './deprecation.ts';

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

/**
 * Render every shortcode the plugin added, on the front end, as `actor`.
 *
 * The core suite runs this as an administrator AND anonymously (R77, spec: "render every
 * discovered block and shortcode on the frontend, anonymously and logged in"). The render itself
 * is not the assertion (R5): `shortcodeRenderDefect` is what proves the endpoint ran and the tag
 * expanded. It touches only the frontend, and says so in its surface.
 */
export function shortcodeRender(
  plugin: string, delta: Surface, actor: Actor, deprecated: readonly string[] = [],
): Journey {
  const name = `shortcode-render:${plugin}:${actor}`;
  // A declared-deprecated tag renders on its own row (R80), never here: this row discounts
  // nothing, so a deprecation notice from any tag rendered in it stays a finding.
  const tags = delta.shortcodes.filter((tag) => !deprecated.includes(tag));
  return {
    name,
    actor,
    surface: 'frontend',
    run: async (browser, cfg, agent) => {
      if (delta.shortcodes.length === 0) {
        return skipped(name, actor, 'frontend', `${plugin} registered no shortcodes`);
      }
      if (tags.length === 0) {
        return skipped(name, actor, 'frontend',
          `every shortcode ${plugin} registered is declared deprecated, and each renders on its own row`);
      }
      return runAsActor(browser, cfg, agent, name, actor, 'frontend', async (page, sentinel) => {
        // Render through the front end so the shortcode runs in its real context.
        for (const tag of tags) {
          await sentinel.visit(page, shortcodeRenderUrl(tag));
          const defect = shortcodeRenderDefect(await page.content(), tag);
          if (defect) throw new Error(defect);
        }
        return 0;
      });
    },
  };
}

/**
 * Render ONE shortcode the manifest declares deprecated, on its own row (R74, R80).
 *
 * Its own journey means its own sentinel and its own log window, so a notice here was raised by
 * this render and no other, and the discount below can reach nothing but this tag's findings.
 * Only core's deprecation notice naming this tag is discounted; everything else still fails, and
 * the row says what it discounted — or that the notice it was declared for never came.
 */
export function deprecatedShortcodeRender(plugin: string, tag: string, actor: Actor): Journey {
  const name = `shortcode-render:${plugin}:${actor}:[${tag}]`;
  return {
    name,
    actor,
    surface: 'frontend',
    run: async (browser, cfg, agent) => {
      const result = await runAsActor(browser, cfg, agent, name, actor, 'frontend', async (page, sentinel) => {
        await sentinel.visit(page, shortcodeRenderUrl(tag));
        const defect = shortcodeRenderDefect(await page.content(), tag);
        if (defect) throw new Error(defect);
        return 0;
      });
      const { kept, discounted } = discountDeclaredDeprecation(result.findings, tag);
      const note = discounted.length > 0
        ? `discounted ${discounted.length} deprecation notice${discounted.length === 1 ? '' : 's'} naming [${tag}], `
          + 'which the manifest declares deprecated (deprecated.shortcodes)'
        : `[${tag}] is declared deprecated, but its render raised no deprecation notice naming it`;
      return { ...result, findings: kept, notes: [...(result.notes ?? []), note] };
    },
  };
}

/**
 * Render every block the plugin added, on the front end, as `actor` (R57, R77, R78).
 *
 * Symmetric with `shortcodeRender`. What it can prove is narrower, and the row says so: the door
 * exits before wp_head and wp_footer, so no frontend asset is exercised; and a STATIC block's
 * frontend output is saved post content the door cannot produce, so for it only registration is
 * checked. A row whose every block is static proved nothing about rendering, and is a skip.
 */
export function blockRender(plugin: string, delta: Surface, actor: Actor): Journey {
  const name = `block-render:${plugin}:${actor}`;
  return {
    name,
    actor,
    surface: 'frontend',
    run: async (browser, cfg, agent) => {
      if (delta.blocks.length === 0) {
        return skipped(name, actor, 'frontend', `${plugin} registered no blocks`);
      }
      let dynamicCount = 0;
      const result = await runAsActor(browser, cfg, agent, name, actor, 'frontend', async (page, sentinel, note) => {
        const statics: string[] = [];
        for (const block of delta.blocks) {
          await sentinel.visit(page, blockRenderUrl(block));
          const verdict = blockRenderVerdict(await page.content(), block);
          if (verdict.defect) throw new Error(verdict.defect);
          if (verdict.dynamic) dynamicCount += 1;
          else statics.push(block);
        }
        if (dynamicCount > 0) {
          note('the block render door exits before wp_head and wp_footer, so no block\'s frontend assets were exercised');
        }
        for (const block of statics) {
          note(`${block} is static: its frontend output is saved post content, which the render door cannot produce — only its registration was checked`);
        }
        return 0;
      });
      if (dynamicCount > 0 || result.findings.length > 0) return result;
      // Every block was static and nothing went wrong: nothing about rendering was asserted.
      return {
        ...result,
        skipped: true,
        skipReason: `every block ${plugin} added is static, so there was no server render to exercise — only registration was checked`,
      };
    },
  };
}

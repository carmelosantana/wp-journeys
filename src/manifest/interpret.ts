/**
 * Turn a parsed manifest into runnable Journeys.
 *
 * Pure with respect to its input: no filesystem, no network, no clock. A `module` entry is
 * resolved lazily inside `run`, so an interpreter test needs no module on disk.
 *
 * Every step asserts something, because the schema refused every entry that would not:
 *  - a screen names this journey's actor in `allow` or `deny`, and `visit()` asserts the
 *    document's status against that expectation — declared per visit, since the sentinel's
 *    expectation is one-shot and a leaked denial would accept a login bounce on the next screen;
 *  - a settings entry is a READ-BACK that detects CHANGE (R66): the value, suffixed per write,
 *    must be absent from the frontend URL's visible text before the write and present after.
 *    A 2xx on the save is never accepted as evidence — a WordPress validation or capability
 *    failure answers with a redirect back to the form, not a 5xx, and would otherwise look
 *    exactly like success; and a post-state check alone would pass on every run after the
 *    first, whether or not the submit still worked;
 *  - a shortcode is proven to have rendered THROUGH the agent and to have expanded, by the same
 *    check the discovered-surface journey uses (R5).
 *
 * Authentication is `runAsActor`'s, and a control visit to a screen the actor must be SERVED
 * opens every non-anonymous journey the INTERPRETER runs (R67), so a manifest denial for a
 * logged-in actor cannot be satisfied by an anonymous visitor: a refused, bounced or
 * sessionless login fails before the first screen. An escape-hatch module never reaches that
 * path — it owns its whole run, and is responsible for its own control visit.
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Page } from '@playwright/test';

import { isAnonymous } from '../actors/roles.ts';
import { shortcodeRenderDefect, shortcodeRenderUrl } from '../agent/render.ts';
import { messageOf } from '../errors.ts';
import type { Journey, JourneyResult } from '../journeys/index.ts';
import { CONTROL_SCREEN, runAsActor } from '../journeys/support.ts';
import type { Manifest, ManifestJourney } from './schema.ts';

/**
 * Load the escape-hatch module and return its Journey, or throw naming the journey and the
 * module. Resolved against the MANIFEST's directory (R8, R70): a relative path passed straight
 * to `import()` would resolve against this file's own URL, not the plugin's.
 *
 * And confined to it. The hatch runs author code by design, but a manifest is data from the
 * plugin under test, and `resolve` would happily follow `../` into a sibling checkout or take
 * an absolute path to any file on the machine.
 */
async function loadModule(entry: ManifestJourney, module: string, manifestDir: string): Promise<Journey> {
  const root = resolve(manifestDir);
  const target = resolve(root, module);
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`journey "${entry.name}": module "${module}" resolves outside the manifest directory ${root}`);
  }

  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(target).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`journey "${entry.name}": could not load module "${module}" — ${messageOf(error)}`);
  }
  const journey = loaded.default;
  if (typeof journey !== 'object' || journey === null || typeof (journey as Journey).run !== 'function') {
    throw new Error(`journey "${entry.name}": module "${module}" does not default-export a Journey`);
  }
  return journey as Journey;
}

/**
 * The module's result, checked for shape and re-labelled with the MANIFEST's identity.
 *
 * The summary must list what the manifest named: a journey the author called `acme-custom`
 * would otherwise appear under whatever the module called itself. And a malformed result is
 * refused at this boundary, where the module can be named: left alone it would reach
 * `outcomeOf` inside the CLI's per-journey guard and fail the same row, but as a contract
 * error about a half-declared skip, with no word of which module produced it.
 */
function asManifestResult(entry: ManifestJourney, module: string, raw: unknown): JourneyResult {
  const refuse = (why: string): never => {
    throw new Error(
      `journey "${entry.name}": module "${module}" returned something that is not a JourneyResult — ${why}`,
    );
  };
  if (typeof raw !== 'object' || raw === null) return refuse(`got ${typeof raw}`);
  const result = raw as Partial<JourneyResult>;
  if (!Array.isArray(result.findings)) return refuse('"findings" is not an array');
  if (typeof result.entitiesCreated !== 'number') return refuse('"entitiesCreated" is not a number');
  if (result.skipReason !== undefined && result.skipped !== true) {
    return refuse('"skipReason" is set without "skipped: true", which would render as a pass');
  }
  const relabelled: JourneyResult = {
    name: entry.name, actor: entry.actor, surface: entry.surface,
    entitiesCreated: result.entitiesCreated, findings: result.findings,
  };
  if (result.skipped !== undefined) relabelled.skipped = result.skipped;
  if (result.skipReason !== undefined) relabelled.skipReason = result.skipReason;
  return relabelled;
}

/** A suffix no earlier run, and no earlier write in this run, can have left on the site. */
function freshNonce(): string {
  return `wpj-${randomBytes(4).toString('hex')}`;
}

/**
 * How long to wait for a `<body>` on a page that has ALREADY finished loading (`visit()`
 * awaited networkidle). Playwright's 30s default is for a body that is still arriving; here a
 * body that is not there yet is a body that is not coming.
 */
const BODY_TIMEOUT_MS = 5_000;

/**
 * The body's VISIBLE text, which is what a setting reaches. Matching the raw HTML source
 * instead would let a short or common value — "1", "Home", the plugin's own name — read back
 * out of a class name, a script body, a comment or the head, regardless of the setting.
 *
 * A read-back URL that serves a feed, a REST route or anything XML/JSON has no `<body>`. The
 * locator would wait out its full timeout and then fail with a message about a locator, naming
 * neither the read-back nor the URL — so the wait is short and the failure is named here.
 */
async function visibleText(page: Page, entry: ManifestJourney, url: string): Promise<string> {
  try {
    return await page.locator('body').innerText({ timeout: BODY_TIMEOUT_MS });
  } catch (error) {
    throw new Error(
      `journey "${entry.name}": the read-back page ${url} served no HTML body (${messageOf(error)}) — `
        + 'a readBack must be an HTML page',
      { cause: error },
    );
  }
}

/**
 * Both sides of a read-back comparison, made comparable. `innerText` is RENDERED text: a
 * theme's `text-transform: uppercase` returns a case that was never written, and a wrap
 * inserts a newline mid-value. Neither is a failed save. Lower-cased, whitespace runs
 * collapsed, trimmed — on the written value too, so both sides ask the same question. The
 * nonce is lowercase hex and survives unchanged.
 */
function comparable(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether `written` reads back in `text`, after both are made comparable. */
function readsBack(text: string, written: string): boolean {
  return comparable(text).includes(comparable(written));
}

function journeyFor(entry: ManifestJourney, manifestDir: string, nonce: () => string): Journey {
  return {
    name: entry.name,
    actor: entry.actor,
    surface: entry.surface,
    run: async (browser, cfg, agent) => {
      if (entry.module !== undefined) {
        const loaded = await loadModule(entry, entry.module, manifestDir);
        let raw: unknown;
        try {
          raw = await loaded.run(browser, cfg, agent);
        } catch (error) {
          // Third-party code. Unwrapped, the operator gets a stack from a file they have to go
          // and find, with neither the journey nor the module named; the original stays as the
          // cause so nothing is lost.
          throw new Error(
            `journey "${entry.name}": module "${entry.module}" threw — ${messageOf(error)}`, { cause: error },
          );
        }
        return asManifestResult(entry, entry.module, raw);
      }
      return runAsActor(browser, cfg, agent, entry.name, entry.actor, entry.surface, async (page, sentinel) => {
        // The control visit (R67): one screen this actor MUST be served, before any step. A
        // deny-only journey would otherwise be satisfied by the login bounce even when the mint
        // redirected away without a session — and the shipped example is deny-only.
        if (!isAnonymous(entry.actor)) {
          sentinel.expect({ denyExpected: false });
          await sentinel.visit(page, CONTROL_SCREEN);
        }

        for (const screen of entry.screens ?? []) {
          // The schema guarantees the actor is in exactly one of the two lists.
          sentinel.expect({ denyExpected: screen.deny.includes(entry.actor) });
          await sentinel.visit(page, screen.url);
        }

        for (const setting of entry.settings ?? []) {
          // A fresh suffix per write (R66), so the read-back proves THIS run's write and not a
          // value the site has held since the first successful run — after which a submit that
          // silently stopped working would stay green forever.
          const written = `${setting.value} ${nonce()}`;

          // Absent BEFORE the write. Change detection, not a state check; and the place a
          // matcher that finds everything would show itself first.
          await sentinel.visit(page, setting.readBack);
          if (readsBack(await visibleText(page, entry, setting.readBack), written)) {
            throw new Error(
              `read-back for "${entry.name}": ${JSON.stringify(written)} was already visible at ${setting.readBack} `
                + 'before it was written — its appearance afterwards could prove nothing, so the write was not made',
            );
          }

          await sentinel.visit(page, setting.url);
          await page.fill(setting.field, written);
          // The submit is NEVER retried — a retried submit writes twice.
          await page.keyboard.press('Enter');
          await page.waitForLoadState('networkidle');

          // Present AFTER. This is the assertion the whole entry exists for.
          await sentinel.visit(page, setting.readBack);
          if (!readsBack(await visibleText(page, entry, setting.readBack), written)) {
            throw new Error(
              `read-back failed for "${entry.name}": wrote ${JSON.stringify(written)} to ${setting.field} `
                + `on ${setting.url}, but it never appeared at ${setting.readBack}. Either the save was refused — a `
                + 'validation or capability failure answers with a redirect back to the form, not an error — or the '
                + 'submit never happened: Enter submits an <input> inside a <form>, not a <textarea> or a field without one.',
            );
          }
        }

        for (const tag of entry.shortcodes ?? []) {
          await sentinel.visit(page, shortcodeRenderUrl(tag));
          const defect = shortcodeRenderDefect(await page.content(), tag);
          if (defect) throw new Error(defect);
        }

        // A settings save creates no entity; a manifest journey is read-only by construction.
        return 0;
      });
    },
  };
}

/**
 * @param manifestDir the directory `wp-journeys.json` was read from. REQUIRED, with no default:
 *   it once defaulted to `'.'`, which silently resolved and confined every module path against
 *   the runner's own working directory — a module beside the manifest was simply not found.
 * @param nonce drawn inside `run`, once per settings write, so `interpret` itself stays pure and
 *   deterministic; a parameter only so a test can pin the suffix and assert the exact value.
 */
export function interpret(manifest: Manifest, manifestDir: string, nonce: () => string = freshNonce): Journey[] {
  return manifest.journeys.map((entry) => journeyFor(entry, manifestDir, nonce));
}

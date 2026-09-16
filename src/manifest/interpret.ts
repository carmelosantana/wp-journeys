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
 *  - a settings entry is a READ-BACK: write the field, then load the frontend URL and prove the
 *    value actually arrived. A 2xx on the save is never accepted as evidence — a WordPress
 *    validation or capability failure answers with a redirect back to the form, not a 5xx, and
 *    would otherwise look exactly like success;
 *  - a shortcode is proven to have rendered THROUGH the agent and to have expanded, by the same
 *    check the discovered-surface journey uses (R5).
 *
 * Authentication is `runAsActor`'s, so a manifest denial for a logged-in actor cannot be
 * satisfied by an anonymous visitor: a refused or bounced login stops the journey before its
 * first screen.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { messageOf } from '../errors.ts';
import type { Journey } from '../journeys/index.ts';
import { runAsActor } from '../journeys/support.ts';
import { shortcodeRenderDefect, shortcodeRenderUrl } from '../suite/rendered-surface.ts';
import type { Manifest, ManifestJourney } from './schema.ts';

/**
 * Load the escape-hatch module and return its Journey, or throw naming the journey and the
 * module. Resolved against the PLUGIN directory (R8): a relative path passed straight to
 * `import()` would resolve against this file's own URL, not the plugin's.
 */
async function loadModule(entry: ManifestJourney, module: string, pluginDir: string): Promise<Journey> {
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(resolve(pluginDir, module)).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`journey "${entry.name}": could not load module "${module}" — ${messageOf(error)}`);
  }
  const journey = loaded.default;
  if (typeof journey !== 'object' || journey === null || typeof (journey as Journey).run !== 'function') {
    throw new Error(`journey "${entry.name}": module "${module}" does not default-export a Journey`);
  }
  return journey as Journey;
}

function journeyFor(entry: ManifestJourney, pluginDir: string): Journey {
  return {
    name: entry.name,
    actor: entry.actor,
    surface: entry.surface,
    run: async (browser, cfg, agent) => {
      if (entry.module !== undefined) {
        const loaded = await loadModule(entry, entry.module, pluginDir);
        return loaded.run(browser, cfg, agent);
      }
      return runAsActor(browser, cfg, agent, entry.name, entry.actor, entry.surface, async (page, sentinel) => {
        let created = 0;

        for (const screen of entry.screens ?? []) {
          // The schema guarantees the actor is in exactly one of the two lists.
          sentinel.expect({ denyExpected: screen.deny.includes(entry.actor) });
          await sentinel.visit(page, screen.url);
        }

        for (const setting of entry.settings ?? []) {
          await sentinel.visit(page, setting.url);
          await page.fill(setting.field, setting.value);
          // The submit is NEVER retried — a retried submit writes twice.
          await page.keyboard.press('Enter');
          await page.waitForLoadState('networkidle');
          created += 1;

          // The read-back. This is the assertion the whole entry exists for.
          await sentinel.visit(page, setting.readBack);
          const body = await page.content();
          if (!body.includes(setting.value)) {
            throw new Error(
              `read-back failed for "${entry.name}": wrote ${JSON.stringify(setting.value)} to ${setting.field} `
                + `on ${setting.url}, but it never appeared at ${setting.readBack}. `
                + 'The save answered without an error, which is exactly how a validation or capability failure looks.',
            );
          }
        }

        for (const tag of entry.shortcodes ?? []) {
          await sentinel.visit(page, shortcodeRenderUrl(tag));
          const defect = shortcodeRenderDefect(await page.content(), tag);
          if (defect) throw new Error(defect);
        }

        return created;
      });
    },
  };
}

export function interpret(manifest: Manifest, pluginDir = '.'): Journey[] {
  return manifest.journeys.map((entry) => journeyFor(entry, pluginDir));
}

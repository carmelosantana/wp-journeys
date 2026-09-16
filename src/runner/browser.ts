/**
 * Launch the browser, and say plainly when it was never fetched.
 *
 * Installing `@playwright/test` does not download a browser; the browser is fetched by an
 * explicit command (`pnpm browser`), never by a lifecycle script. On a fresh clone, Playwright's
 * launch fails with a multi-line boxed banner that recommends `npx playwright install`, which
 * fetches every browser. The runner needs only Chromium, so it says exactly that, on one line.
 *
 * And it names the CLONE's own script, never `npx playwright`: run outside the clone, npx pulls
 * the registry's latest Playwright, bypassing the lockfile and the release-age gate, and may
 * fetch a browser build this pinned Playwright cannot even launch.
 */
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';

/** The clone this module runs from: where `pnpm browser` uses the pinned Playwright. */
const CLONE = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

export const MISSING_BROWSER =
  `wpj could not launch Chromium: Playwright's browser is not installed. Run \`pnpm --dir ${CLONE} browser\` once, then run wpj again.`;

/**
 * Playwright's own wording for a browser binary that is not on disk, and the path it looked at:
 * the rest of that first line. The path is what makes a PLAYWRIGHT_BROWSERS_PATH mismatch
 * visible, so it stays in the one line.
 */
const NOT_ON_DISK = /Executable doesn't exist(?: at ([^\r\n]+))?/;

export async function launchChromium(launch: () => Promise<Browser> = () => chromium.launch()): Promise<Browser> {
  try {
    return await launch();
  } catch (error) {
    const missing = error instanceof Error ? NOT_ON_DISK.exec(error.message) : null;
    if (missing) {
      const where = missing[1] ? ` Playwright looked for it at ${missing[1].trim()}` : '';
      throw new Error(`${MISSING_BROWSER}${where}`, { cause: error });
    }
    throw error;
  }
}

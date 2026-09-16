/**
 * Launch the browser, and say plainly when it was never fetched.
 *
 * Installing `@playwright/test` does not download a browser; the browser is fetched by an
 * explicit command (`pnpm browser`), never by a lifecycle script. On a fresh clone, Playwright's
 * launch fails with a multi-line boxed banner that recommends `npx playwright install`, which
 * fetches every browser. The runner needs only Chromium, so it says exactly that, on one line.
 */
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';

export const MISSING_BROWSER =
  'wpj could not launch Chromium: Playwright\'s browser is not installed. Run `npx playwright install chromium` once, then run wpj again.';

/** Playwright's own wording for a browser binary that is not on disk. */
const NOT_ON_DISK = /Executable doesn't exist/;

export async function launchChromium(launch: () => Promise<Browser> = () => chromium.launch()): Promise<Browser> {
  try {
    return await launch();
  } catch (error) {
    if (error instanceof Error && NOT_ON_DISK.test(error.message)) {
      throw new Error(MISSING_BROWSER, { cause: error });
    }
    throw error;
  }
}

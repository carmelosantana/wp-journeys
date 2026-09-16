import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import { launchChromium, MISSING_BROWSER } from '../src/runner/browser.ts';

/** This clone's root, which is where the pinned Playwright lives. */
const CLONE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Playwright 1.63's own message when the browser was never fetched, verbatim in shape. */
const PLAYWRIGHT_MISSING = 'browserType.launch: Executable doesn\'t exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell\n'
  + '╔════════════════════════════════════════════════════════════╗\n'
  + '║ Looks like Playwright was just installed or updated.       ║\n'
  + '║ Please run the following command to download new browsers: ║\n'
  + '║                                                            ║\n'
  + '║     npx playwright install                                 ║\n'
  + '║                                                            ║\n'
  + '║ <3 Playwright Team                                         ║\n'
  + '╚════════════════════════════════════════════════════════════╝';

describe('launchChromium', () => {
  it('turns Playwright\'s missing-executable banner into one line naming the install command', async () => {
    const error = await launchChromium(() => Promise.reject(new Error(PLAYWRIGHT_MISSING))).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Where Playwright looked, so a PLAYWRIGHT_BROWSERS_PATH mismatch can be seen (R103).
    expect(message).toBe(`${MISSING_BROWSER} Playwright looked for it at /home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`);
    // Through the clone's own pinned Playwright: an npx outside it fetches the registry's latest,
    // bypassing the lockfile and the release-age gate.
    expect(message).toContain(`pnpm --dir ${CLONE} browser`);
    expect(message).not.toContain('npx');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('╔');
    // The original is kept as the cause, so nothing is lost for someone debugging.
    expect(((error as Error).cause as Error).message).toBe(PLAYWRIGHT_MISSING);
  });

  it('still gives the one line when the message names no path', async () => {
    const error = await launchChromium(() => Promise.reject(new Error('Executable doesn\'t exist'))).catch((e: unknown) => e);
    expect((error as Error).message).toBe(MISSING_BROWSER);
  });

  it('passes any other launch failure through untouched', async () => {
    const other = new Error('browserType.launch: Target page, context or browser has been closed');
    await expect(launchChromium(() => Promise.reject(other))).rejects.toBe(other);
  });

  it('hands back the browser when the launch works', async () => {
    const browser = { fake: true } as unknown as Browser;
    await expect(launchChromium(() => Promise.resolve(browser))).resolves.toBe(browser);
  });
});

import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { launchChromium, MISSING_BROWSER } from '../src/runner/browser.ts';

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
    expect(message).toBe(MISSING_BROWSER);
    expect(message).toContain('npx playwright install chromium');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('╔');
    // The original is kept as the cause, so nothing is lost for someone debugging.
    expect(((error as Error).cause as Error).message).toBe(PLAYWRIGHT_MISSING);
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

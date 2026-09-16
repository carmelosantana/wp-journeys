/**
 * The core conformance suite against a real WordPress, plus the proofs that each half of it
 * can go RED.
 *
 * Unit tests prove the classifiers and the matrix. Only a live sweep proves the WordPress
 * behaviour they were written against: that a low-privilege role really is refused with a 403,
 * that a logged-out visitor really is bounced to wp-login.php, that a container menu's projected
 * URL really is a screen, and that the orphan detector really catches the fixture's known leak.
 *
 * Every green assertion here is paired with a red one (R53). A proof that cannot fail is not a
 * proof, so each red case asserts the SPECIFIC finding it expects rather than merely "not pass".
 *
 * Needs a live target and a wp-cli for it:
 *   set -a; . ./.env; set +a
 *   WPJ_WP_CLI="node /path/to/wph.js wp wpjtest --" pnpm e2e
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Browser } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';

import { ALL_ACTORS, Actor } from '../../src/actors/roles.ts';
import type { AgentClient } from '../../src/agent/client.ts';
import { createAgentClient } from '../../src/agent/client.ts';
import { loadConfig } from '../../src/config.ts';
import { projectSurface } from '../../src/discovery/surface.ts';
import type { Surface } from '../../src/discovery/types.ts';
import { outcomeOf } from '../../src/journeys/index.ts';
import type { JourneyResult } from '../../src/journeys/index.ts';
import { runAsActor } from '../../src/journeys/support.ts';
import type { Baseline } from '../../src/suite/baseline.ts';
import { captureBaseline } from '../../src/suite/baseline.ts';
import { conformanceSurface } from '../../src/suite/index.ts';
import { lifecycle } from '../../src/suite/lifecycle.ts';
import { adminSweep, blockRender, shortcodeRender } from '../../src/suite/rendered-surface.ts';

const PLUGIN = 'wpj-fixture';
/** The ONE site these proofs may mutate. They uninstall a plugin and delete a cron event. */
const TARGET = 'wpjtest';
const cfg = loadConfig(process.env);
const agent = createAgentClient(cfg.baseUrl, cfg.secret);
const execFileAsync = promisify(execFile);

/**
 * The wp-cli for the target site. There is no portable way to find one, so without it these
 * proofs SKIP loudly rather than quietly passing — a skip is visible; a silent pass is not.
 */
const WP_CLI = (process.env.WPJ_WP_CLI ?? '').split(' ').filter(Boolean);

/** Run wp-cli, failing the test if it fails. */
async function wp(...args: string[]): Promise<void> {
  const [command, ...prefix] = WP_CLI;
  await execFileAsync(command as string, [...prefix, ...args]);
}

/**
 * Run wp-cli where a non-zero exit is an expected outcome — "the plugin is already inactive",
 * "that cron event does not exist". Used ONLY to reach a known starting state, never to hide
 * the failure of something being asserted.
 */
async function wpTolerant(...args: string[]): Promise<void> {
  try {
    await wp(...args);
  } catch {
    // Already in the state we were asking for.
  }
}

/** The findings, pretty-printed, so a failure names the defect instead of a length mismatch. */
function detail(result: JourneyResult): string {
  return JSON.stringify(result.findings, null, 2);
}

let browser: Browser;
let baseline: Baseline;
let delta: Surface;

test.beforeAll(async () => {
  test.skip(WP_CLI.length === 0, 'set WPJ_WP_CLI to a wp-cli invocation for the target site');
  test.setTimeout(240_000);

  // Structural rather than conventional: these proofs uninstall a plugin and delete a cron
  // event, and only wpjtest may be mutated. Trusting whatever WPJ_WP_CLI happens to name would
  // let one mistyped environment variable run all of that against a real site.
  expect(WP_CLI, `WPJ_WP_CLI must target ${TARGET}`).toContain(TARGET);
  expect(cfg.baseUrl, `WPJ_BASE_URL must target ${TARGET}`).toContain(TARGET);

  // Start from a site the fixture has never been activated on (R7a): uninstall removes the
  // option, table and user meta, and the cron event is deleted by hand because the fixture's
  // uninstall.php deliberately leaves it behind. Without this the fixture's activation state is
  // already in the baseline snapshot, and its known leak could never be detected.
  // --skip-delete on every uninstall, always (R6): wp-harness bind-mounts plugins read-write,
  // so a plain uninstall would delete the host checkout.
  await wpTolerant('plugin', 'uninstall', PLUGIN, '--deactivate', '--skip-delete');
  await wpTolerant('cron', 'event', 'delete', 'wpj_fixture_daily');

  browser = await chromium.launch();

  // The plugin is already off, so the baseline's deactivate is a no-op it must tolerate. Its
  // activate() is what runs the activation hook and creates the state the lifecycle journey
  // then checks the removal of.
  baseline = await captureBaseline(
    agent,
    cfg,
    PLUGIN,
    () => wpTolerant('plugin', 'deactivate', PLUGIN),
    () => wp('plugin', 'activate', PLUGIN),
  );

  delta = conformanceSurface(baseline.surface, projectSurface(await agent.discover()));
});

test.afterAll(async () => {
  await browser?.close();
  // R31: leave wpjtest as it was found — the fixture inactive, and none of its state behind.
  await wpTolerant('plugin', 'uninstall', PLUGIN, '--deactivate', '--skip-delete');
  await wpTolerant('cron', 'event', 'delete', 'wpj_fixture_daily');
});

test('the delta is the fixture’s documented surface, so the sweep below has real subjects', () => {
  // A sweep over an empty delta SKIPS, and a skip is not a pass — but saying so here names the
  // cause instead of leaving six mysterious skips.
  expect(delta.screens.map((screen) => screen.slug).sort()).toEqual([
    'wpj-fixture',
    'wpj-fixture-admin-only',
    'wpj-fixture-container',
    'wpj-fixture-container-home',
    'wpj-fixture-file-child',
    'wpj-fixture-options',
    'wpj-fixture-served',
    'wpj-fixture-served-child',
    'wpj-fixture-settings',
    'wpj-fixture/wpj-fixture.php',
  ]);
  expect(delta.shortcodes).toEqual(['wpj_fixture']);
});

/**
 * R23: the whole permission sweep, live, for each of the six actors.
 *
 * The administrator is allowed everywhere; editor, author, contributor and subscriber are each
 * refused by wp_die's 403; anonymous is refused by the login redirect. All six are a PASS —
 * an expected denial is a pass, which is the rule this suite is built on.
 */
for (const actor of ALL_ACTORS) {
  test(`the admin sweep passes as ${actor}`, async () => {
    test.setTimeout(180_000);
    const result = await adminSweep(PLUGIN, delta, actor).run(browser, cfg, agent);

    expect(outcomeOf(result), detail(result)).toBe('pass');
  });
}

test('a WRONG expectation goes red, so the six green sweeps above mean something', async () => {
  // R23's known negative: an AccessCase that claims the editor may reach a manage_options
  // screen. The assertion names the 403 it expects, so a case that failed for some other
  // reason — a 404 from a mistyped URL, a 502 — would not be mistaken for this proof working.
  const screen = delta.screens.find((s) => s.capability === 'manage_options');
  expect(screen, 'the fixture registers a manage_options screen').toBeDefined();

  const result = await runAsActor(
    browser, cfg, agent, 'known-negative', Actor.EDITOR, 'admin',
    async (page, sentinel) => {
      sentinel.expect({ denyExpected: false });
      await sentinel.visit(page, screen!.url);
      return 0;
    },
  );

  expect(outcomeOf(result), detail(result)).toBe('fail');
  expect(result.findings, detail(result)).toContainEqual(
    expect.objectContaining({ kind: 'response', status: 403 }),
  );
});

test('a sweep whose login token was REFUSED goes red, not green (R54)', async () => {
  // The false green this guard exists for, and the reason a 12/12 green run could not catch it.
  // wpj_consume_login returned SILENTLY on a refused token; WordPress then rendered the ordinary
  // home page at the token URL with HTTP 200 — no login page, no 5xx, nothing for a classifier
  // to report. The sweep ran as an ANONYMOUS visitor, and a logged-out visitor's login redirect
  // satisfies every denial the subscriber sweep expects. It reported `pass` having asserted
  // nothing about permissions at all. Only the administrator sweep would have gone red.
  const sabotaged: AgentClient = {
    ...agent,
    mintLogin: async (userId: number) => {
      const { url } = await agent.mintLogin(userId);
      // Well-formed but never minted: 32 hex characters the agent has no transient for.
      return { url: url.replace(/wpj_login=[^&]*/, `wpj_login=${'0'.repeat(32)}`) };
    },
  };

  const result = await adminSweep(PLUGIN, delta, Actor.SUBSCRIBER).run(browser, cfg, sabotaged);

  expect(outcomeOf(result), detail(result)).toBe('fail');
  expect(JSON.stringify(result.findings)).toContain('could not authenticate as subscriber');
});

test('a container menu’s projected URL is a screen that answers, not a 404 (R28)', async () => {
  // WordPress links a container at its first submenu. Projecting it at its own slug sends the
  // sweep to /wp-admin/wpj-fixture-container, which answers 404 — reported as a defect of the
  // plugin under test, when the plugin is fine.
  const container = delta.screens.find((s) => s.slug === 'wpj-fixture-container');
  expect(container, 'the fixture registers a container menu').toBeDefined();
  expect(container!.url).toBe('/wp-admin/admin.php?page=wpj-fixture-container-home');

  const result = await runAsActor(
    browser, cfg, agent, 'container-menu', Actor.ADMINISTRATOR, 'admin',
    async (page, sentinel) => {
      await sentinel.visit(page, container!.url);
      return 0;
    },
  );

  expect(outcomeOf(result), detail(result)).toBe('pass');
});

test('every shortcode the plugin added renders through the front end', async () => {
  const result = await shortcodeRender(PLUGIN, delta).run(browser, cfg, agent);

  expect(outcomeOf(result), detail(result)).toBe('pass');
});

test('a shortcode that never registered goes red, rather than passing on a 200 (R5)', async () => {
  // The hazard the marker exists for: a tag that does not expand still comes back HTTP 200,
  // and WordPress returns an unregistered shortcode verbatim. Asserting only "the page loaded"
  // would pass having rendered nothing at all.
  const result = await shortcodeRender(PLUGIN, { ...delta, shortcodes: ['wpj_not_a_shortcode'] })
    .run(browser, cfg, agent);

  expect(outcomeOf(result), detail(result)).toBe('fail');
  expect(JSON.stringify(result.findings)).toContain('came back verbatim');
});

test('every block the plugin added renders through the front end (R57)', async () => {
  expect(delta.blocks).toEqual(['wpj-fixture/hello']);
  const result = await blockRender(PLUGIN, delta).run(browser, cfg, agent);

  expect(outcomeOf(result), detail(result)).toBe('pass');
});

test('a block that is not registered goes red, rather than rendering "cleanly" as nothing (R57)', async () => {
  const result = await blockRender(PLUGIN, { ...delta, blocks: ['wpj-fixture/not-a-block'] }).run(browser, cfg, agent);

  expect(outcomeOf(result), detail(result)).toBe('fail');
  expect(JSON.stringify(result.findings)).toContain('wpj-fixture/not-a-block is not registered');
});

/**
 * Runs LAST: it uninstalls the plugin every test above needs.
 *
 * The fixture's uninstall.php removes its option, table and user meta but deliberately leaves
 * the `wpj_fixture_daily` cron event — the detector's one known positive. So this journey must
 * FAIL, and it must fail naming that event.
 */
test('the lifecycle journey catches the fixture’s known uninstall leak', async () => {
  test.setTimeout(120_000);
  const result = await lifecycle(
    PLUGIN,
    baseline,
    () => wp('plugin', 'uninstall', PLUGIN, '--deactivate', '--skip-delete'),
  ).run(browser, cfg, agent);

  expect(outcomeOf(result), detail(result)).toBe('fail');
  expect(JSON.stringify(result.findings)).toContain('wpj_fixture_daily');
  // The three it DOES remove are the known negatives: reporting them would be a false orphan.
  expect(JSON.stringify(result.findings)).not.toContain('wpj_fixture_version');
  expect(JSON.stringify(result.findings)).not.toContain('wpj_fixture_seen');
});

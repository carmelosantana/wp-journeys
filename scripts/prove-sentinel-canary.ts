/**
 * Step 6, the non-optional proof: watch the sentinel go RED for the right reason, then green.
 *
 * A green suite proves nothing until you have seen it fail on a real defect. `wpj-canary` is a
 * committed mu-plugin that emits an undefined-variable warning during `wp_head` on every
 * front-end render, armed by the `wpj_canary_armed` option and disarmed by deleting it (R22).
 * A second option, `wpj_canary_js`, makes it print a script on `wp_footer` that throws, which
 * proves the `pageerror` signal the same way.
 *
 * ── THE ORDERING CONSTRAINT (R62) — the whole reason this script exists ──
 *
 * The canary MUST be armed AFTER `captureBaseline` has run, and disarmed before the green leg.
 *
 * `captureBaseline` measures what this site emits on EVERY request — through the log and,
 * since R60, through the rendered body — and `withoutBaselineNoise` subtracts it, so that a
 * diagnostic the site produces whatever is under test is not blamed on the plugin under test.
 * The canary is an mu-plugin: it cannot be deactivated the way a real plugin under test is
 * deactivated during the baseline window. Arm it first and its warning is measured as ordinary
 * per-request noise, subtracted from every journey, and the proof goes green having proved the
 * exact opposite of what it claims.
 *
 * That is not hypothetical — it happened. Arming the canary before the baseline produced a
 * fully green run that was structurally incapable of reporting ANY body-printed warning.
 *
 * Arming after the baseline is what mirrors a real plugin under test, which is deactivated
 * during that window and active for the journeys. The ordering lives here, in the proof, so no
 * general caller has to remember it.
 *
 * The canary stays on `wp_head` rather than `admin_head` deliberately: the front-end render path
 * is where most WordPress warnings actually appear, and is exactly what R49's front-end probe
 * exists to measure. A proof that only covered the admin surface would be a weaker instrument.
 *
 * ── R53: a proof that cannot go red must fail loudly ──
 *
 * This script ASSERTS the armed run went red, and names the diagnostic it expects. An armed
 * canary that produces a clean run is a FAILED PROOF, not a passing suite, and exits non-zero.
 *
 * Usage (wpjtest only — it writes an option on the target site):
 *   set -a; . ./.env; set +a
 *   WPJ_WP="node /path/to/wph.js wp wpjtest" node scripts/prove-sentinel-canary.ts
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium } from '@playwright/test';

import { createAgentClient } from '../src/agent/client.ts';
import { loadConfig } from '../src/config.ts';
import { outcomeOf } from '../src/journeys/index.ts';
import type { JourneyResult } from '../src/journeys/index.ts';
import { captureBaseline, withoutBaselineNoise } from '../src/suite/baseline.ts';
import type { Baseline } from '../src/suite/baseline.ts';
import { frontendRenders } from '../src/suite/frontend-renders.ts';

/** The ONE site this may mutate. It writes and deletes an option. */
const TARGET = 'wpjtest';
const ARMED_OPTION = 'wpj_canary_armed';
/** Arms the canary's CLIENT-side defect: an inline script on wp_footer that throws. */
const JS_OPTION = 'wpj_canary_js';
/** The JS canary's own thrown message, and the only kind that may carry it. */
const EXPECTED_JS = /wpj-canary: deliberate uncaught JavaScript error/;
/**
 * What the CANARY'S OWN defect says — and nothing more general.
 *
 * This is the specificity assertion that stops the proof passing for the wrong reason, so it
 * must not match text that every body finding carries. It once included `printed into the
 * response body`, which `scanBody` puts in EVERY bodyscan: any unrelated body diagnostic then
 * satisfied the armed leg, so a canary that silently failed to arm — R53's original hazard, the
 * WP_DEBUG and wp_get_environment_type gate — still printed PROOF OK. It also made the baseline
 * guard below abort with a misleading verdict on a site that merely has unrelated body noise.
 */
const EXPECTED = /notset|Undefined variable|array offset/i;

const run = promisify(execFile);
const cfg = loadConfig(process.env);
const agent = createAgentClient(cfg.baseUrl, cfg.secret);
const wp = process.env.WPJ_WP ?? '';

if (!wp) throw new Error('WPJ_WP is not set — this proof needs a wp-cli command for the target.');
// Structural, not conventional: one mistyped variable must not arm a canary on a real site.
if (!wp.includes(TARGET)) throw new Error(`WPJ_WP must target ${TARGET}, got: ${wp}`);
if (!cfg.baseUrl.includes(TARGET)) throw new Error(`WPJ_BASE_URL must target ${TARGET}`);

async function wpCli(args: string): Promise<void> {
  await run('sh', ['-c', `${wp} ${args}`]);
}
/** For a command whose non-zero exit only means "already in that state". */
async function wpTolerant(args: string): Promise<void> {
  try {
    await wpCli(args);
  } catch {
    // Already there.
  }
}

const arm = () => wpCli(`option update ${ARMED_OPTION} 1`);
const armJs = () => wpCli(`option update ${JS_OPTION} 1`);
/** Both defects, always together: no leg may leave either one armed. */
const disarm = async (): Promise<void> => {
  await wpTolerant(`option delete ${ARMED_OPTION}`);
  await wpTolerant(`option delete ${JS_OPTION}`);
};

/** Run the front-end journey and settle it exactly as the CLI's runSuite does. */
async function runJourney(baseline: Baseline): Promise<JourneyResult> {
  const browser = await chromium.launch();
  try {
    const raw = await frontendRenders.run(browser, cfg, agent);
    return { ...raw, findings: withoutBaselineNoise(raw.findings, baseline) };
  } finally {
    await browser.close();
  }
}

function describe(result: JourneyResult): string {
  return result.findings.map((f) => `      - [${f.kind}] ${f.text}`).join('\n') || '      (none)';
}

async function main(): Promise<number> {
  const failures: string[] = [];

  // Start disarmed, so the baseline below measures the site WITHOUT the deliberate defect.
  await disarm();

  // No-op plugin toggles: the subject of this proof is the canary, an mu-plugin, so there is no
  // plugin under test to deactivate. Passing no-ops keeps the proof from mutating any plugin's
  // activation state, and the baseline still measures the log and body noise it needs.
  const baseline = await captureBaseline(agent, cfg, 'wpj-canary', async () => {}, async () => {});
  console.log(`baseline captured with the canary DISARMED — logNoise=${baseline.logNoise.length}, bodyNoise=${baseline.bodyNoise.length}`);
  if (baseline.bodyNoise.some((key) => EXPECTED.test(key))) {
    failures.push('the canary\'s diagnostic is in the baseline noise — it was armed too early, and the proof is void');
  }

  // ── RED leg: arm AFTER the baseline, exactly as a real plugin under test becomes active. ──
  await arm();
  try {
    const armed = await runJourney(baseline);
    const armedOutcome = outcomeOf(armed);
    console.log(`\nARMED   -> ${armedOutcome}\n${describe(armed)}`);

    if (armedOutcome !== 'fail') {
      failures.push(`the armed canary produced "${armedOutcome}" — a proof that cannot go red is not a proof (R53)`);
    }
    if (!armed.findings.some((f) => EXPECTED.test(f.text))) {
      failures.push('the armed run went red but named no canary diagnostic — it failed for the wrong reason');
    }
  } finally {
    // Never leave the scratch site armed, whatever happened above.
    await disarm();
  }

  // ── RED leg, client side: an uncaught JavaScript error must be a `pageerror` naming it. ──
  // Playwright never reports an uncaught exception through `console`, so this leg is what
  // proves the sixth signal is wired up on a real browser, not only on a fake page.
  await armJs();
  try {
    const armedJs = await runJourney(baseline);
    const jsOutcome = outcomeOf(armedJs);
    console.log(`\nARMED JS -> ${jsOutcome}\n${describe(armedJs)}`);

    if (jsOutcome !== 'fail') {
      failures.push(`the armed JS canary produced "${jsOutcome}" — an uncaught error went unseen`);
    }
    if (!armedJs.findings.some((f) => f.kind === 'pageerror' && EXPECTED_JS.test(f.text))) {
      failures.push('the armed JS run named no pageerror carrying the canary\'s thrown message — it failed for the wrong reason, or not at all');
    }
  } finally {
    await disarm();
  }

  // ── GREEN leg: the same journey, same baseline, both defects removed. ──
  const clean = await runJourney(baseline);
  const cleanOutcome = outcomeOf(clean);
  console.log(`\nDISARMED -> ${cleanOutcome}\n${describe(clean)}`);
  if (cleanOutcome !== 'pass') {
    failures.push(`the disarmed run produced "${cleanOutcome}" — green does not return, so the red leg proves nothing`);
  }

  if (failures.length > 0) {
    console.error('\nPROOF FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log('\nPROOF OK: red with each canary armed (phplog/bodyscan, then pageerror), green with both disarmed.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  async (error: unknown) => {
    // A throw must not leave the canary armed on the scratch site.
    await disarm().catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

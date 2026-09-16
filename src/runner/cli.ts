/**
 * The impure shell: read config, wire the agent, run the suite, print the summary, exit.
 * All judgement lives in the pure modules this calls.
 *
 * This module has NO top-level side effect. `bin/wpj.js` calls `main()`; importing it does
 * nothing, which is what lets the guard below — the code standing between a crashed journey and
 * a lost run — be tested without a browser, a site, or a process to exit.
 *
 * Nothing here ever prints the shared secret. It travels from the environment into one request
 * header inside `createAgentClient` and appears in no message, no usage text and no error.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';

import { createAgentClient } from '../agent/client.ts';
import type { AgentClient } from '../agent/client.ts';
import { loadConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { projectSurface } from '../discovery/surface.ts';
import { messageOf } from '../errors.ts';
import { outcomeOf } from '../journeys/index.ts';
import type { Journey, JourneyResult } from '../journeys/index.ts';
import { exitCodeFor, renderSummary } from '../report/summary.ts';
import { captureBaseline, withoutBaselineNoise } from '../suite/baseline.ts';
import type { Baseline } from '../suite/baseline.ts';
import { conformanceSurface, coreSuite } from '../suite/index.ts';

const run = promisify(execFile);

/**
 * wp-harness's own slug rule. The slug is interpolated into a `sh -c` string to toggle the
 * plugin, so it is validated BEFORE any wp-cli call rather than trusted — `acme; rm -rf ~` is
 * not a plugin slug under any reading, and the shell would not have asked.
 */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export type ParsedArgs = { ok: true; plugin: string } | { ok: false; reason: string };

/**
 * The runner has exactly one command today. An unrecognised one is refused rather than
 * defaulted: `wpj skills install` arrives in Task 16, and quietly running the conformance suite
 * because the first word was not understood would be a surprising and destructive answer.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command] = argv;
  if (command !== 'run') {
    return {
      ok: false,
      reason: command === undefined ? 'no command given' : `unknown command ${JSON.stringify(command)}`,
    };
  }

  const at = argv.indexOf('--plugin');
  if (at === -1) return { ok: false, reason: '--plugin <slug> is required' };

  const plugin = argv[at + 1];
  if (plugin === undefined) return { ok: false, reason: '--plugin needs a slug after it' };
  if (!SLUG.test(plugin)) {
    // JSON-quoted, so a slug carrying control or escape characters cannot rewrite the terminal
    // on its way to being rejected.
    return {
      ok: false,
      reason: `${JSON.stringify(plugin)} is not a plugin slug — expected ${String(SLUG)}`,
    };
  }
  return { ok: true, plugin };
}

/** The three wp-cli invocations the runner makes, and the only ones. */
export interface WpCommands {
  activate: string;
  deactivate: string;
  uninstall: string;
}

/**
 * `--skip-delete` is NOT optional (R6). wp-harness bind-mounts plugins READ-WRITE, so a plain
 * `wp plugin uninstall` deletes the developer's host checkout — irreversibly, and for a plugin
 * under development that is a live repo. The runner wants the uninstall ROUTINE to run so it
 * can look for orphaned state; it never wants the files removed.
 *
 * Building all three here rather than at their call sites is what makes that testable as a
 * property of the runner instead of a habit at one line.
 */
export function wpCommands(wp: string, plugin: string): WpCommands {
  return {
    activate: `${wp} plugin activate ${plugin}`,
    deactivate: `${wp} plugin deactivate ${plugin}`,
    uninstall: `${wp} plugin uninstall ${plugin} --deactivate --skip-delete`,
  };
}

/**
 * Run every journey, and hand back results the summary can always render.
 *
 * Three things happen inside ONE guard per journey, and the grouping is the point:
 *
 *  - `journey.run()` — a throw here is THIS journey's failure, not the run's (R3b). Without the
 *    guard, one crashed journey takes the other eight with it and the summary never prints, so
 *    a run that found eight real defects reports nothing at all.
 *  - `withoutBaselineNoise()` — BEFORE the outcome is decided (R45). A deprecation this site
 *    writes on every request is not a defect of the plugin under test; subtracting it after the
 *    outcome had been computed would change nothing and leave the false red standing. This is
 *    the shipping path's only consumer of the baseline's log noise.
 *  - `outcomeOf()` — which is PARTIAL: it THROWS on a half-declared skip (R39). The renderer
 *    calls it for every result, so a malformed result that got past here would abort the entire
 *    summary. Calling it inside the guard converts that into one failed journey.
 *
 * The result built in the catch carries neither `skipped` nor `skipReason`, so it is well-formed
 * by construction — including when what threw was the malformed shape itself.
 */
export async function runSuite(
  suite: Record<string, Journey>,
  browser: Browser,
  cfg: Config,
  agent: AgentClient,
  baseline: Baseline,
): Promise<JourneyResult[]> {
  const results: JourneyResult[] = [];

  for (const journey of Object.values(suite)) {
    try {
      const raw = await journey.run(browser, cfg, agent);
      const settled: JourneyResult = {
        ...raw,
        findings: withoutBaselineNoise(raw.findings, baseline),
      };
      // Called for its REFUSAL, not its value: this is where a half-declared skip is caught,
      // while it can still be reported as one journey's failure.
      outcomeOf(settled);
      results.push(settled);
    } catch (error) {
      results.push({
        name: journey.name,
        actor: journey.actor,
        surface: journey.surface,
        entitiesCreated: 0,
        findings: [{ kind: 'assertion', text: messageOf(error) }],
      });
    }
  }

  return results;
}

function usage(reason: string): void {
  process.stderr.write(`${reason}\n\n`);
  process.stdout.write(
    'usage:\n' +
      '  wpj run --plugin <slug>    run the conformance suite against a plugin\n' +
      '\nenvironment:\n' +
      '  WPJ_BASE_URL      the target site; local hostnames only\n' +
      '  WPJ_AGENT_SECRET  the shared secret the companion mu-plugin expects\n' +
      '  WPJ_WP            the wp-cli command used to toggle the plugin under test\n',
  );
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    usage(parsed.reason);
    return 2;
  }
  const { plugin } = parsed;

  const cfg = loadConfig(env);
  const agent = createAgentClient(cfg.baseUrl, cfg.secret);

  // wp-cli is used ONLY to toggle the plugin under test — everything else goes through the
  // agent, so a target without wp-cli loses only this one capability, loudly.
  const wp = env.WPJ_WP;
  if (!wp) {
    process.stderr.write(
      'WPJ_WP is not set — the runner needs a wp-cli command to toggle the plugin.\n',
    );
    return 2;
  }

  const commands = wpCommands(wp, plugin);
  const shell = (command: string) => async (): Promise<void> => {
    await run('sh', ['-c', command]);
  };

  // The baseline owns the deactivate/activate pair: everything attributable to the plugin is a
  // delta against the site WITHOUT it, and that ordering is a guarantee rather than a habit.
  const baseline = await captureBaseline(agent, cfg, shell(commands.deactivate), shell(commands.activate));

  // conformanceSurface, NOT surfaceDelta: the screens are the delta, but the capability map must
  // come from the site as it IS with the plugin active. A raw delta reports only the caps the
  // plugin ADDED, which for most plugins is none — and the access matrix would then expect the
  // administrator to be denied its own settings screen, inverting the entire sweep.
  const delta = conformanceSurface(baseline.surface, projectSurface(await agent.discover()));

  const browser = await chromium.launch();
  let results: JourneyResult[];
  try {
    const suite = coreSuite(plugin, delta, baseline, shell(commands.uninstall));
    results = await runSuite(suite, browser, cfg, agent, baseline);
  } finally {
    await browser.close();
  }

  process.stdout.write(`${renderSummary(results)}\n`);
  return exitCodeFor(results);
}

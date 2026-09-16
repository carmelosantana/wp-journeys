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

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Browser } from '@playwright/test';

import { createAgentClient } from '../agent/client.ts';
import type { AgentClient } from '../agent/client.ts';
import { BASE_URL_VAR, loadConfig, SECRET_VAR } from '../config.ts';
import type { Config } from '../config.ts';
import { projectSurface } from '../discovery/surface.ts';
import type { Surface } from '../discovery/types.ts';
import { messageOf } from '../errors.ts';
import { outboundText } from '../outbound.ts';
import { outcomeOf } from '../journeys/index.ts';
import { interpret } from '../manifest/interpret.ts';
import { loadManifest } from '../manifest/load.ts';
import type { Journey, JourneyResult } from '../journeys/index.ts';
import { exitCodeFor, renderSummary } from '../report/summary.ts';
import type { Finding } from '../sentinel/phplog.ts';
import { captureBaseline, withoutBaselineNoise } from '../suite/baseline.ts';
import type { Baseline } from '../suite/baseline.ts';
import { conformanceSurface, coreSuite } from '../suite/index.ts';
import { launchChromium } from './browser.ts';

const run = promisify(execFile);

/** The variables `wpj` reads beyond config.ts's two, named once (see config.ts). */
export const WP_VAR = 'WPJ_WP';
export const MANIFEST_DIR_VAR = 'WPJ_MANIFEST_DIR';
export const HOME_VAR = 'HOME';

/** Every variable the CLI reads, in the order usage() lists them. */
export const CLI_ENV = [BASE_URL_VAR, SECRET_VAR, WP_VAR, HOME_VAR, MANIFEST_DIR_VAR] as const;

/**
 * wp-harness's own slug rule. The slug is interpolated into a `sh -c` string to toggle the
 * plugin, so it is validated BEFORE any wp-cli call rather than trusted — `acme; rm -rf ~` is
 * not a plugin slug under any reading, and the shell would not have asked.
 */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export type ParsedArgs = { ok: true; plugin: string } | { ok: false; reason: string };

/**
 * The `run` command's arguments. `mcp` and `skills` are routed by `main` before this is called.
 * An unrecognised command is refused rather than defaulted: quietly running the conformance
 * suite because the first word was not understood would be a surprising and destructive answer.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command] = argv;
  if (command !== 'run') {
    return {
      ok: false,
      reason: command === undefined ? 'no command given' : `unknown command ${JSON.stringify(command)}`,
    };
  }

  // Every argument must be ACCOUNTED FOR, not merely searched for. Scanning with
  // `indexOf('--plugin')` silently ignores every other token, so `--pluginn other` would run the
  // whole destructive suite against the wrong plugin without a word. A missing --plugin and an
  // unknown command already fail loudly; an unconsumed argument fails the same way.
  const rest = argv.slice(1);
  if (rest.length === 0) return { ok: false, reason: '--plugin <slug> is required' };
  if (rest[0] !== '--plugin') {
    return {
      ok: false,
      reason: `unexpected argument ${JSON.stringify(rest[0])} — wpj run takes only --plugin <slug>`,
    };
  }

  const plugin = rest[1];
  if (plugin === undefined) return { ok: false, reason: '--plugin needs a slug after it' };
  if (rest.length > 2) {
    return {
      ok: false,
      reason: `unexpected argument ${JSON.stringify(rest[2])} — wpj run takes only --plugin <slug>`,
    };
  }
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
 * The plugin's own journeys and declarations, from the manifest in `WPJ_MANIFEST_DIR`.
 *
 * R70, first contact's first finding: "the plugin directory" is TWO paths on a real plugin. The
 * directory wp-harness MOUNTS is the plugin root; the directory holding `wp-journeys.json` is
 * wherever the plugin keeps its tests (Alpaca Bot: `tests/e2e`). This variable names the second,
 * and only the second — it is where the manifest is read from, and the directory escape-hatch
 * module paths resolve against and are confined under. It was `WPJ_PLUGIN_DIR`, a name that
 * invited exactly the wrong path; the old name is refused rather than ignored, because ignoring
 * it runs no authored journey and says nothing.
 *
 * Every refusal here is loud for the same reason the schema's are: an author who named a
 * manifest believes it ran. So a named directory with no manifest in it is an error, not the
 * zero-authoring case (that is what leaving the variable unset means), and a manifest written
 * for another plugin is refused before its journeys can drive this one.
 */
const NO_SURFACE: Surface = { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} };
const NO_BASELINE: Baseline = {
  surface: NO_SURFACE, snapshot: { options: [], tables: [], cron: [], userMeta: [] },
  logNoise: [], bodyNoise: [], activeAtStart: true,
};

export interface ManifestPlan {
  /** The plugin's own journeys, interpreted. */
  journeys: Journey[];
  /** Shortcode tags the manifest declares deprecated (R74). */
  deprecatedShortcodes: string[];
}

export async function manifestPlan(env: NodeJS.ProcessEnv, plugin: string): Promise<ManifestPlan> {
  if (env.WPJ_PLUGIN_DIR !== undefined) {
    throw new Error(
      'WPJ_PLUGIN_DIR is no longer read — set WPJ_MANIFEST_DIR to the directory that holds '
        + 'wp-journeys.json (which is not necessarily the plugin root you mounted).',
    );
  }
  const dir = env[MANIFEST_DIR_VAR];
  if (dir === undefined) return { journeys: [], deprecatedShortcodes: [] };
  // Set but empty is a mistake, not "unset": the operator named a manifest and got none.
  if (dir === '') {
    throw new Error(`${MANIFEST_DIR_VAR} is set but empty — name the directory holding wp-journeys.json, or unset it.`);
  }

  const manifest = await loadManifest(dir);
  if (manifest === null) {
    throw new Error(
      `${MANIFEST_DIR_VAR} is set, but ${join(dir, 'wp-journeys.json')} does not exist — `
        + 'name the directory the manifest is in, or unset the variable to run the core suite alone.',
    );
  }
  if (manifest.plugin !== plugin) {
    throw new Error(
      `${join(dir, 'wp-journeys.json')} declares plugin "${manifest.plugin}", but the run is against "${plugin}".`,
    );
  }
  // The directory is passed EXPLICITLY: interpret() resolves and confines module paths
  // against it, and the runner's own cwd is not where any plugin keeps its journeys.
  const plan = { journeys: interpret(manifest, dir), deprecatedShortcodes: manifest.deprecated?.shortcodes ?? [] };
  // Build the suite's shape now, so a collision is refused here — before the baseline
  // deactivates anything — rather than inside coreSuite after it has.
  suiteShape(plugin, plan);
  return plan;
}

/**
 * Every journey a run against `plugin` would register, built WITHOUT touching the site.
 *
 * The names (and each journey's declared `uninstallsPlugin`) do not depend on the surface, only
 * on the plugin and the manifest plan, so they can be known before any baseline. Its journeys
 * are NOT runnable: they were built against an empty surface and a no-op uninstall. Refuses a
 * name collision, as `coreSuite` always does.
 */
export function suiteShape(plugin: string, plan: ManifestPlan): Record<string, Journey> {
  return coreSuite(plugin, NO_SURFACE, NO_BASELINE, async () => {}, plan.journeys, plan.deprecatedShortcodes);
}

/** The three things a run does to the site through wp-cli. */
export interface SiteActions {
  deactivate: () => Promise<void>;
  activate: () => Promise<void>;
  uninstall: () => Promise<void>;
}

async function shell(command: string): Promise<void> {
  await run('sh', ['-c', command]);
}

/** `wpCommands`, made runnable. `runShell` is injectable so a test runs no shell. */
export function siteActions(
  wp: string, plugin: string, runShell: (command: string) => Promise<void> = shell,
): SiteActions {
  const commands = wpCommands(wp, plugin);
  return {
    deactivate: () => runShell(commands.deactivate),
    activate: () => runShell(commands.activate),
    uninstall: () => runShell(commands.uninstall),
  };
}

export interface PreparedSuite {
  suite: Record<string, Journey>;
  baseline: Baseline;
  /** What the run attributes to the plugin: the delta's screens, the site's real caps. */
  surface: Surface;
}

/**
 * Capture the baseline and build the runnable suite — the ONE way a run is prepared, used by
 * `wpj run` and by the MCP server's `run_journey` (R88).
 *
 * This DEACTIVATES and then REACTIVATES the plugin under test (the baseline owns that pair), so
 * the plugin is left active whatever its state before.
 *
 * @param fetchImpl injectable so a test can drive the baseline's front-end probe without a network
 */
export async function prepareSuite(
  agent: AgentClient,
  cfg: Config,
  plugin: string,
  plan: ManifestPlan,
  actions: SiteActions,
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedSuite> {
  // The baseline owns the deactivate/activate pair: everything attributable to the plugin is a
  // delta against the site WITHOUT it, and that ordering is a guarantee rather than a habit.
  const baseline = await captureBaseline(agent, cfg, plugin, actions.deactivate, actions.activate, fetchImpl);

  // conformanceSurface, NOT surfaceDelta: the screens are the delta, but the capability map must
  // come from the site as it IS with the plugin active. A raw delta reports only the caps the
  // plugin ADDED, which for most plugins is none — and the access matrix would then expect the
  // administrator to be denied its own settings screen, inverting the entire sweep.
  const surface = conformanceSurface(baseline.surface, projectSurface(await agent.discover()));

  const suite = coreSuite(plugin, surface, baseline, actions.uninstall, plan.journeys, plan.deprecatedShortcodes);
  return { suite, baseline, surface };
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
 * by construction — including when what threw was the malformed shape itself. It DOES carry
 * whatever findings the journey had already collected: the journey fails either way, so no
 * pass/fail signal is at stake, but discarding the real defects it found on its way to being
 * refused would throw away the only thing anyone reads the summary for.
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
    // Held outside the try so the catch can still see what the journey got through before it
    // failed. Both stay at their defaults when it was `run()` itself that threw.
    let raw: JourneyResult | undefined;
    let carried: Finding[] = [];
    try {
      raw = await journey.run(browser, cfg, agent);
      carried = withoutBaselineNoise(raw.findings, baseline);
      const settled: JourneyResult = { ...raw, findings: carried };
      // Called for its REFUSAL, not its value: this is where a half-declared skip is caught,
      // while it can still be reported as one journey's failure.
      outcomeOf(settled);
      results.push(settled);
    } catch (error) {
      const failed: JourneyResult = {
        name: journey.name,
        actor: journey.actor,
        surface: journey.surface,
        entitiesCreated: raw?.entitiesCreated ?? 0,
        // Filtered here as well as on the way out: the result is also what MCP hands back, and a
        // journey's own message may quote a minted URL.
        findings: [...carried, { kind: 'assertion', text: outboundText(messageOf(error), cfg?.secret) }],
      };
      if (raw?.notes) failed.notes = raw.notes;
      results.push(failed);
    }
  }

  return results;
}

/**
 * All of it to stderr. stdout carries the run summary and nothing else, so a CI job parsing
 * stdout is never handed usage text on the exit-2 path.
 *
 * It also states what a completed run DOES, which nothing told the operator before: the
 * lifecycle journey uninstalls the plugin under test. `--skip-delete` keeps the files (R6) but
 * the uninstall routine itself runs, and that is not a read-only operation.
 */
function usage(reason: string): string {
  return (
    `${reason}\n\n` +
      'usage:\n' +
      '  wpj run --plugin <slug>    run the conformance suite against a plugin\n' +
      '  wpj mcp                    serve the runner as MCP tools over stdio\n' +
      '  wpj skills install         link this package\'s agent skills into ~/.claude/skills\n' +
      '\nenvironment:\n' +
      `  ${BASE_URL_VAR.padEnd(18)}the target site; local hostnames only\n` +
      `  ${SECRET_VAR.padEnd(18)}the shared secret the companion mu-plugin expects\n` +
      `  ${WP_VAR.padEnd(18)}the wp-cli command used to toggle the plugin under test\n` +
      `  ${HOME_VAR.padEnd(18)}\`skills install\` links into $${HOME_VAR}/.claude/skills\n` +
      `  ${MANIFEST_DIR_VAR.padEnd(18)}optional: the directory holding the plugin's wp-journeys.json. Not\n` +
      '                    necessarily the plugin root you mounted; escape-hatch module paths\n' +
      '                    resolve against, and must stay inside, this directory\n' +
      '\nA completed run UNINSTALLS the plugin under test. The last journey deactivates it and\n' +
      'runs its uninstall routine, so its options, tables, cron events and user meta are really\n' +
      'deleted and it is left inactive; only the plugin FILES are kept. It also creates six\n' +
      'WordPress users. Point this at a scratch site, never at anything you care about.\n' +
      '\nThe orphan check is only sound on a site where the plugin has never been activated:\n' +
      'whatever an earlier activation created is already in the baseline and cannot be seen.\n' +
      'If the plugin is active when the run starts, the lifecycle row is a skip, not a pass.\n' +
      'Mount it INACTIVE on a fresh site (or remove its state first). `wph mount` is not such a\n' +
      'workflow on its own: it activates the plugin it mounts — deactivate it and clear its\n' +
      'state before the first run.\n'
  );
}

/** Where `main` writes, every byte through `outboundText`. */
interface Streams {
  out(text: string): void;
  err(text: string): void;
}

function streamsFor(env: NodeJS.ProcessEnv): Streams {
  const secret = env[SECRET_VAR];
  return {
    out: (text) => { process.stdout.write(outboundText(text, secret)); },
    err: (text) => { process.stderr.write(outboundText(text, secret)); },
  };
}

/**
 * `wpj skills install` (R99). Routed from `main`'s own argv like every other command, and only
 * from the command line: it writes into a home directory, which no MCP tool may do.
 */
async function skillsCommand(args: string[], env: NodeJS.ProcessEnv, io: Streams): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    io.err(usage('wpj skills needs a subcommand — the only one is `install`'));
    return 2;
  }
  if (sub !== 'install') {
    io.err(usage(`unknown skills subcommand ${JSON.stringify(sub)} — the only one is \`install\``));
    return 2;
  }
  if (rest.length > 0) {
    io.err(usage(`unexpected argument ${JSON.stringify(rest[0])} — wpj skills install takes no arguments`));
    return 2;
  }
  const { installSkills } = await import('../commands/skills.ts');
  // The env main was given, not process.env: that is what a test (and `HOME=… wpj`) controls.
  return installSkills(env[HOME_VAR] || homedir());
}

/**
 * @param createAgent injectable so a test can drive the run up to the first wp-cli call without a
 *   site; production always uses the real client
 * @param launch injectable so a test can prove when, and whether, a browser is launched
 * @param fetchImpl injectable so a test can drive a whole run without a network
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  createAgent: (baseUrl: string, secret: string) => AgentClient = createAgentClient,
  launch: () => Promise<Browser> = launchChromium,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const io = streamsFor(env);
  // Before parseArgs, config and everything else: the server must start even when configuration
  // is broken (R89), and in this mode stdout belongs to the protocol alone (R90).
  if (argv[0] === 'mcp') {
    if (argv.length > 1) {
      io.err(usage(`unexpected argument ${JSON.stringify(argv[1])} — wpj mcp takes no arguments`));
      return 2;
    }
    const { serve } = await import('../mcp/server.ts');
    await serve(undefined, { env, createAgent, launchBrowser: launch });
    return 0;
  }

  if (argv[0] === 'skills') return skillsCommand(argv.slice(1), env, io);

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(usage(parsed.reason));
    return 2;
  }
  const { plugin } = parsed;

  const cfg = loadConfig(env);
  const agent = createAgent(cfg.baseUrl, cfg.secret);

  // wp-cli is used ONLY to toggle the plugin under test — everything else goes through the
  // agent, so a target without wp-cli loses only this one capability, loudly.
  const wp = env[WP_VAR];
  if (!wp) {
    io.err(`${WP_VAR} is not set — the runner needs a wp-cli command to toggle the plugin.\n`);
    return 2;
  }

  // Before anything touches the site: a manifest that cannot run must not cost the operator a
  // deactivate, a baseline and a whole suite first.
  const plan = await manifestPlan(env, plugin);

  // The browser too: a browser that was never fetched must not cost the operator a
  // deactivate and a reactivate of the plugin under test first.
  const browser = await launch();
  let results: JourneyResult[];
  let surface: Surface;
  try {
    const prepared = await prepareSuite(agent, cfg, plugin, plan, siteActions(wp, plugin), fetchImpl);
    surface = prepared.surface;
    results = await runSuite(prepared.suite, browser, cfg, agent, prepared.baseline);
  } finally {
    await browser.close();
  }

  io.out(`${renderSummary(results, surface)}\n`);
  return exitCodeFor(results);
}

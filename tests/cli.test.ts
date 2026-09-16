import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { register } from '../src/journeys/index.ts';
import type { AgentClient } from '../src/agent/client.ts';
import type { RawRegistries } from '../src/discovery/types.ts';
import type { Journey, JourneyResult } from '../src/journeys/index.ts';
import { skillsRoot, skillTarget } from '../src/commands/skills.ts';
import { main, manifestPlan, parseArgs, prepareSuite, runSuite, siteActions, suiteShape, wpCommands } from '../src/runner/cli.ts';
import type { Baseline } from '../src/suite/baseline.ts';
import { SPAWN_TIMEOUT_MS } from './helpers/timeouts.ts';
import { FakeBrowser, FakePage, fakeAgent } from './helpers/fakes.ts';

/** A per-request deprecation this site writes whatever is under test (R45). */
const NOISE_TEXT = 'PHP Deprecated: Creation of dynamic property Acme::$x is deprecated';

const BASELINE: Baseline = {
  surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
  snapshot: { options: [], tables: [], cron: [], userMeta: [] },
  activeAtStart: false,
  logNoise: [NOISE_TEXT],
  bodyNoise: [],
};

/** Nothing in these journeys touches the browser, config or agent, so none is supplied. */
const nothing = undefined as never;

/** A journey whose run() is scripted: it returns a result, or throws. */
function scripted(name: string, body: () => Promise<JourneyResult>): Journey {
  return { name, actor: Actor.ADMINISTRATOR, surface: 'admin', run: body };
}

function resultOf(name: string, over: Partial<JourneyResult> = {}): JourneyResult {
  return {
    name, actor: Actor.ADMINISTRATOR, surface: 'admin', entitiesCreated: 0, findings: [], ...over,
  };
}

describe('parseArgs', () => {
  it('accepts the one command the runner has: run --plugin <slug>', () => {
    expect(parseArgs(['run', '--plugin', 'wpj-fixture'])).toEqual({ ok: true, plugin: 'wpj-fixture' });
  });

  it('accepts the dots, digits and underscores real plugin slugs carry', () => {
    expect(parseArgs(['run', '--plugin', 'w3-total-cache.2'])).toEqual({ ok: true, plugin: 'w3-total-cache.2' });
    // R10's class is [a-z0-9._-], which includes the underscore — this repo's own fixture is
    // `wpj-fixture`, but a slug like `really_simple_ssl` is ordinary and must not be refused.
    expect(parseArgs(['run', '--plugin', 'really_simple_ssl'])).toEqual({ ok: true, plugin: 'really_simple_ssl' });
  });

  it('refuses an argument it did not consume, rather than silently ignoring it', () => {
    // `indexOf('--plugin')` scans for one flag and ignores every other token, so a typo runs the
    // whole destructive suite against the wrong plugin without a word of complaint. A missing
    // --plugin and an unknown command already fail loudly; an unconsumed argument must too.
    expect(parseArgs(['run', '--plugin', 'acme', '--pluginn', 'other']).ok).toBe(false);
    expect(parseArgs(['run', '--pluginn', 'other', '--plugin', 'acme']).ok).toBe(false);
    expect(parseArgs(['run', '--verbose', '--plugin', 'acme']).ok).toBe(false);
    expect(parseArgs(['run', '--plugin', 'acme', 'extra']).ok).toBe(false);

    // It names the argument it could not account for, so the typo is obvious.
    const refusal = parseArgs(['run', '--plugin', 'acme', '--pluginn', 'other']);
    expect(refusal.ok === false && refusal.reason).toContain('--pluginn');
  });

  it('refuses a missing command, an unknown command and a missing --plugin', () => {
    expect(parseArgs([]).ok).toBe(false);
    // parseArgs is `run`'s parser. `wpj skills install` is routed by main() before it is called
    // (R99), so here it is an unknown command and must not be silently treated as `run`.
    expect(parseArgs(['skills', 'install']).ok).toBe(false);
    expect(parseArgs(['run']).ok).toBe(false);
    expect(parseArgs(['run', '--plugin']).ok).toBe(false);
  });

  it('refuses a slug that does not match wp-harness’s slug rule before any shell sees it (R10)', () => {
    // The slug is interpolated into a `sh -c` string to toggle the plugin. Validating it here,
    // ahead of every wp-cli call, is what keeps that from being a command-injection hole — and
    // `; rm -rf` is not a plugin slug under any reading.
    for (const bad of [
      'Acme',            // uppercase
      '-acme',           // leading dash
      '.acme',           // leading dot
      'acme plugin',     // space
      'acme;id',         // command separator
      'acme$(id)',       // substitution
      'acme`id`',        // backtick substitution
      'acme&&id',        // conjunction
      'acme/../../etc',  // traversal
      'acme|id',         // pipe
      'acme\nid',        // newline: a second command to `sh -c`
      '',
    ]) {
      expect(parseArgs(['run', '--plugin', bad]).ok, bad).toBe(false);
    }
  });
});

describe('the wpj entry point', { timeout: SPAWN_TIMEOUT_MS }, () => {
  const wpj = fileURLToPath(new URL('../bin/wpj.js', import.meta.url));

  /** Run the real binary. With no valid command it exits before touching config or the site. */
  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [wpj, ...args], { encoding: 'utf8' });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it('sends the whole of usage to stderr, leaving stdout for the summary alone', () => {
    // A CI job parsing stdout expects a run summary there. Usage text arriving on stdout on the
    // exit-2 path hands it something that is neither a summary nor nothing.
    const { code, stdout, stderr } = runCli([]);

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('usage:');
    expect(stderr).toContain('no command given');
  });

  it('warns in usage that a completed run UNINSTALLS the plugin under test', () => {
    // The lifecycle journey runs `wp plugin uninstall --deactivate --skip-delete` last. The
    // files survive — that is all R6 protects — but the plugin's options, tables, cron events
    // and user meta are genuinely deleted and it is left inactive. Nothing said so before.
    const { stderr } = runCli([]);

    expect(stderr).toMatch(/uninstall/i);
    expect(stderr).toMatch(/scratch|disposable|throwaway/i);
  });

  it('explains the fresh-site precondition of the orphan check, and why a mount that activates is not one (R75)', () => {
    const { stderr } = runCli([]);

    expect(stderr).toMatch(/never been activated/);
    expect(stderr).toMatch(/wph mount.*activates/s);
  });

  it('scrubs the secret from a fatal error on its way to stderr (M1)', () => {
    // The loader quotes the refused hostname, and here the operator pasted the secret into it.
    const secret = 'fixture-secret-not-real-0123456789';
    const result = spawnSync(process.execPath, [wpj, 'run', '--plugin', 'acme'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', WPJ_BASE_URL: `https://${secret}.example.com/`, WPJ_AGENT_SECRET: secret },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing a non-local target: <REDACTED>\.example\.com/);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('redacts a login token from a fatal error on its way to stderr (R95e)', () => {
    // The manifest loader's refusal quotes the directory it was given — here, one carrying a
    // token. It is refused before anything touches the site.
    const result = spawnSync(process.execPath, [wpj, 'run', '--plugin', 'acme'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '', WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: 'x'.repeat(16),
        WPJ_WP: 'false', WPJ_MANIFEST_DIR: '/nonexistent/?wpj_login=TOK-fatal-123',
      },
    });

    expect(result.status).toBe(1);
    // The value runs to the next delimiter, so the `:` after it goes too.
    expect(result.stderr).toMatch(/^\/nonexistent\/\?wpj_login=<REDACTED>/);
    expect(result.stderr).toContain('manifest directory does not exist');
    expect(result.stdout + result.stderr).not.toContain('TOK-fatal-123');
  });

  it('names `wpj skills install` in usage', () => {
    expect(runCli([]).stderr).toMatch(/wpj skills install +link this package's agent skills into ~\/\.claude\/skills/);
  });

  it('installs the skills end to end into the HOME it is given, and only there', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const result = spawnSync(process.execPath, [wpj, 'skills', 'install'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`linked ${skillTarget(home, 'wp-journeys-running')} -> ${join(skillsRoot(), 'wp-journeys-running')}`);
    expect(await readlink(skillTarget(home, 'wp-journeys-authoring'))).toBe(join(skillsRoot(), 'wp-journeys-authoring'));
  });

  it('names the environment variables without ever carrying a value for the secret', () => {
    const { stdout, stderr } = runCli([]);
    const all = stdout + stderr;

    expect(all).toContain('WPJ_AGENT_SECRET');
    expect(all).not.toMatch(/WPJ_AGENT_SECRET\s*[=:]\s*\S/);
  });
});

describe('wpj mcp (R90)', { timeout: SPAWN_TIMEOUT_MS }, () => {
  const wpj = fileURLToPath(new URL('../bin/wpj.js', import.meta.url));

  it('answers the brief\'s tools/list handshake with only JSON-RPC on stdout, even with no configuration', () => {
    const result = spawnSync(process.execPath, [wpj, 'mcp'], {
      encoding: 'utf8',
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
      // R89: the server starts with configuration missing entirely.
      env: { PATH: process.env.PATH ?? '' },
    });

    expect(result.status).toBe(0);
    const frames = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(1);
    expect(frames[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'discover_surface', 'drain_sentinel', 'login_as', 'navigate', 'read_page', 'run_journey', 'status',
    ]);
  });

  it('refuses an argument it does not take, on stderr', () => {
    const result = spawnSync(process.execPath, [wpj, 'mcp', '--plugin', 'acme'], { encoding: 'utf8', input: '' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/wpj mcp takes no arguments/);
  });

  it('is named in usage', () => {
    const result = spawnSync(process.execPath, [wpj], { encoding: 'utf8' });
    expect(result.stderr).toMatch(/wpj mcp +serve the runner as MCP tools over stdio/);
  });
});

/** Swallow what main() writes, and hand it back. */
async function quietly<T>(body: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const out = process.stdout.write;
  const err = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string) => { stdout += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    return { value: await body(), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** A createAgent / launch that must never be reached. */
const noAgent = (): AgentClient => { throw new Error('an agent was created'); };
const noLaunch = (): Promise<never> => { throw new Error('a browser was launched'); };

describe('wpj skills (R99: routed through main\'s own argv)', () => {
  it('installs into the HOME main was given, touching neither the site nor a browser', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));

    const { value, stdout, stderr } = await quietly(() => main(['skills', 'install'], { HOME: home }, noAgent, noLaunch));

    expect(value).toBe(0);
    expect(stderr).toBe('');
    expect(await readlink(skillTarget(home, 'wp-journeys-running'))).toBe(join(skillsRoot(), 'wp-journeys-running'));
    expect(stdout).toContain(`linked ${skillTarget(home, 'wp-journeys-authoring')}`);
  });

  it('exits non-zero when the installer refuses, and keeps the user\'s directory (R98)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));
    const mine = skillTarget(home, 'wp-journeys-running');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, 'SKILL.md'), 'mine');

    const { value, stderr } = await quietly(() => main(['skills', 'install'], { HOME: home }, noAgent, noLaunch));

    expect(value).not.toBe(0);
    expect(stderr).toContain(mine);
    expect(await readFile(join(mine, 'SKILL.md'), 'utf8')).toBe('mine');
    expect((await lstat(mine)).isSymbolicLink()).toBe(false);
  });

  it.each([
    [['skills'], /wpj skills needs a subcommand/],
    [['skills', 'uninstall'], /unknown skills subcommand "uninstall"/],
    [['skills', 'install', '--force'], /unexpected argument "--force"/],
  ])('refuses %j loudly, with usage, and installs nothing', async (argv, reason) => {
    const home = await mkdtemp(join(tmpdir(), 'wpj-home-'));

    const { value, stdout, stderr } = await quietly(() => main(argv, { HOME: home }, noAgent, noLaunch));

    expect(value).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(reason);
    expect(stderr).toContain('usage:');
    await expect(lstat(join(home, '.claude'))).rejects.toThrow(/ENOENT/);
  });

  it('is not an MCP tool: the server offers no way to write into a home directory', async () => {
    const { TOOLS } = await import('../src/mcp/tools.ts');
    expect(Object.keys(TOOLS).filter((name) => /skill|install/i.test(name))).toEqual([]);
  });
});

describe('the browser', () => {
  it('prints usage for a bare `wpj` without launching anything', async () => {
    let launched = false;
    const { value } = await quietly(() => main([], {}, noAgent, async () => { launched = true; return noLaunch(); }));

    expect(value).toBe(2);
    expect(launched).toBe(false);
  });

  it('launches BEFORE the run touches the site, so a missing browser costs no plugin toggle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wpj-launch-'));
    const marker = join(dir, 'wp-cli-ran');
    const agent = new Proxy({}, { get: () => () => Promise.reject(new Error('the agent was asked something')) }) as AgentClient;

    const outcome = await main(['run', '--plugin', 'acme'], {
      WPJ_BASE_URL: 'https://site.test', WPJ_AGENT_SECRET: 'x'.repeat(16), WPJ_WP: `touch ${marker} #`,
    }, () => agent, () => Promise.reject(new Error('wpj could not launch Chromium (test)'))).then(() => 'resolved', (error: unknown) => error);

    expect(String(outcome)).toContain('wpj could not launch Chromium (test)');
    await expect(access(marker)).rejects.toThrow();
  });
});

describe('what wpj run writes (one outbound filter)', () => {
  it('never prints a login token or the secret, even when a journey\'s error quotes both', async () => {
    const secret = 'cli-outbound-secret-0123456789';
    const token = 'SECRETTOKENabcdef';
    /** A page whose every mint navigation fails the way Playwright words it: quoting the URL. */
    class Refusing extends FakePage {
      override async goto(url: string): Promise<unknown> {
        if (url.includes('wpj_login=')) throw new Error(`page.goto: net::ERR_UNSAFE_PORT at ${url} (sent ${secret})`);
        return super.goto(url);
      }
    }
    const withScreen: RawRegistries = {
      menu: [['Acme', 'manage_options', 'acme']], submenu: {}, blocks: [], shortcodes: [], routes: {},
      roles: { administrator: ['manage_options', 'read'], subscriber: ['read'] }, pluginPages: ['acme'],
    };
    const bare: RawRegistries = { ...withScreen, menu: [], pluginPages: [] };
    let discovered = 0;
    const { agent } = fakeAgent({
      status: async () => ({ ok: true, wp: '7.1', php: '8.4', debugLog: true, pluginActive: false }),
      discover: async () => (discovered++ === 0 ? bare : withScreen),
      snapshot: async () => ({ options: [], tables: [], cron: [], userMeta: [] }),
      mintLogin: async () => ({ url: `http://s.test:6000/?wpj_login=${token}` }),
    });
    const browser = new FakeBrowser(new Refusing());
    const fetchImpl = (async () => new Response('<html><body>home</body></html>')) as unknown as typeof fetch;

    const { value, stdout, stderr } = await quietly(() => main(['run', '--plugin', 'acme'], {
      WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: secret, WPJ_WP: 'true #',
    }, () => agent, async () => browser.asBrowser(), fetchImpl));

    expect(value).toBe(1);
    expect(stdout).toContain('could not authenticate as');
    expect(stdout).toContain('ERR_UNSAFE_PORT');
    expect(stdout + stderr).not.toContain(token);
    expect(stdout + stderr).not.toContain(secret);
  });
});

describe('wpCommands', () => {
  it('builds the toggle commands against the operator’s wp-cli command', () => {
    const cmds = wpCommands('wp --path=/srv', 'acme');
    expect(cmds.activate).toBe('wp --path=/srv plugin activate acme');
    expect(cmds.deactivate).toBe('wp --path=/srv plugin deactivate acme');
  });

  it('never emits an uninstall without --skip-delete (R6)', () => {
    // wp-harness bind-mounts plugins READ-WRITE, so a plain `wp plugin uninstall` deletes the
    // developer's host checkout — irreversibly, and for Task 14 that is a live repo. This is
    // pinned on the whole command set, not just the one call site, so a later command that
    // uninstalls cannot be added without tripping it.
    const cmds = wpCommands('wp', 'acme');
    expect(cmds.uninstall).toContain('--skip-delete');
    expect(cmds.uninstall).toContain('--deactivate');

    for (const [name, command] of Object.entries(cmds)) {
      if (command.includes('plugin uninstall')) {
        expect(command, name).toContain('--skip-delete');
      }
    }
  });
});

describe('runSuite', () => {
  it('runs every journey in registry order and returns one result each', async () => {
    const suite = register(
      scripted('a', async () => resultOf('a')),
      scripted('b', async () => resultOf('b')),
      scripted('c', async () => resultOf('c')),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('turns a journey that THREW into that journey’s failure, and keeps running (R3b)', async () => {
    // One journey blowing up must not take the other eight with it. Without this the summary
    // never prints at all, and a run that found eight real defects reports nothing.
    const suite = register(
      scripted('a', async () => resultOf('a')),
      scripted('boom', async () => { throw new Error('chromium crashed'); }),
      scripted('c', async () => resultOf('c')),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results.map((r) => r.name)).toEqual(['a', 'boom', 'c']);
    const boom = results[1]!;
    expect(boom.findings).toEqual([{ kind: 'assertion', text: 'chromium crashed' }]);
    expect(boom.actor).toBe(Actor.ADMINISTRATOR);
    expect(boom.surface).toBe('admin');
    expect(boom.entitiesCreated).toBe(0);
    // And it is never mistaken for a skip: a journey that crashed asserted nothing, but it is
    // not a journey whose subject was absent.
    expect(boom.skipped).toBeUndefined();
  });

  it('gives a thrown non-Error a message rather than an empty finding', async () => {
    // An empty finding text renders as nothing at all under the journey line — a failure that
    // looks like a formatting glitch.
    const suite = register(scripted('boom', async () => { throw ''; }));

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results[0]!.findings[0]!.text).not.toBe('');
  });

  it('subtracts the site’s baseline log noise BEFORE deciding the outcome (R45)', async () => {
    // The order is the whole point. The plugin under test is blameless for a deprecation the
    // site writes on every request; subtracting it AFTER the outcome was computed changes
    // nothing, and the journey stays a false red.
    const suite = register(
      scripted('noisy', async () => resultOf('noisy', {
        findings: [{ kind: 'phplog', text: NOISE_TEXT }, { kind: 'phplog', text: NOISE_TEXT }],
      })),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results[0]!.findings).toEqual([]);
  });

  it('SAYS what the noise subtraction removed, on the row, without changing the outcome', async () => {
    // A plugin making the same core misuse as the theme has that finding erased; the row must
    // not read as a silent ok.
    const suite = register(
      scripted('noisy', async () => resultOf('noisy', {
        notes: ['its own note'],
        findings: [{ kind: 'phplog', text: NOISE_TEXT }, { kind: 'phplog', text: NOISE_TEXT }],
      })),
    );

    const [result] = await runSuite(suite, nothing, nothing, nothing, BASELINE);
    const { outcomeOf } = await import('../src/journeys/index.ts');

    expect(outcomeOf(result!)).toBe('pass');
    expect(result!.notes).toEqual([
      'its own note',
      `2 findings matched this site's baseline noise and were not counted: ${NOISE_TEXT}`,
    ]);
  });

  it('lists each distinct subtracted text once, truncated, and adds no note when nothing was removed', async () => {
    const long = `PHP Deprecated: ${'x'.repeat(300)}`;
    const suite = register(
      scripted('long', async () => resultOf('long', {
        findings: [{ kind: 'phplog', text: long }, { kind: 'phplog', text: NOISE_TEXT }],
      })),
      scripted('quiet', async () => resultOf('quiet', { findings: [{ kind: 'phplog', text: 'PHP Warning: real' }] })),
    );

    const [noisy, quiet] = await runSuite(suite, nothing, nothing, nothing, { ...BASELINE, logNoise: [NOISE_TEXT, long] });

    const note = noisy!.notes?.[0] ?? '';
    expect(note).toMatch(/^2 findings matched this site's baseline noise and were not counted: /);
    expect(note).toContain(`${long.slice(0, 120)}…`);
    expect(note).not.toContain(long);
    expect(note).toContain(NOISE_TEXT);
    expect(quiet!.notes).toBeUndefined();
  });

  it('says so in the singular for one subtracted finding, and on a failed row too', async () => {
    const real = { kind: 'phplog' as const, text: 'PHP Warning: Undefined array key "id"' };
    const suite = register(
      scripted('mixed', async () => resultOf('mixed', { findings: [real, { kind: 'phplog', text: NOISE_TEXT }] })),
    );

    const [result] = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(result!.findings).toEqual([real]);
    expect(result!.notes).toEqual([`1 finding matched this site's baseline noise and was not counted: ${NOISE_TEXT}`]);
  });

  it('keeps a finding the baseline never saw — that is the plugin under test', async () => {
    const real = { kind: 'phplog' as const, text: 'PHP Warning: Undefined array key "id"' };
    const suite = register(
      scripted('noisy', async () => resultOf('noisy', {
        findings: [{ kind: 'phplog', text: NOISE_TEXT }, real],
      })),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results[0]!.findings).toEqual([real]);
  });

  it('turns a skip whose only finding was baseline noise back into a clean skip', async () => {
    // The subtraction runs before the outcome for skips too, so a skipped journey that merely
    // caught the site's own per-request notice is not promoted to a failure.
    const suite = register(
      scripted('absent', async () => resultOf('absent', {
        skipped: true, skipReason: 'acme added no admin screens',
        findings: [{ kind: 'phplog', text: NOISE_TEXT }],
      })),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results[0]!.findings).toEqual([]);
    expect(results[0]!.skipped).toBe(true);
    expect(results[0]!.skipReason).toBe('acme added no admin screens');
  });

  it('fails ONE journey on a half-declared skip instead of aborting the whole summary (R39)', async () => {
    // `outcomeOf` THROWS on `skipReason` without `skipped: true`. It is called by the renderer
    // for every result, so a malformed result that reached the renderer would take down the
    // entire summary — nine journeys' evidence lost to one bad shape. runSuite calls it inside
    // the same guard as run(), so the malformed journey fails and the rest still print.
    const suite = register(
      scripted('a', async () => resultOf('a')),
      scripted('malformed', async () => resultOf('malformed', { skipReason: 'acme is not active' })),
      scripted('c', async () => resultOf('c')),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(results.map((r) => r.name)).toEqual(['a', 'malformed', 'c']);
    const malformed = results[1]!;
    expect(malformed.findings[0]!.kind).toBe('assertion');
    expect(malformed.findings[0]!.text).toMatch(/half-declared skip/);
    // The shape that threw must not survive into the result, or the renderer throws on it next.
    expect(malformed.skipReason).toBeUndefined();
    expect(malformed.skipped).toBeUndefined();
  });

  it('keeps the findings a malformed result had ALREADY collected, not just the error', async () => {
    // The journey fails either way, so no pass/fail signal was ever at stake — but replacing the
    // findings wholesale discards the real defects it found on the way to being malformed, and
    // those are the only reason anyone reads the summary.
    const real = { kind: 'phplog' as const, text: 'PHP Warning: Undefined array key "id"' };
    const suite = register(
      scripted('malformed', async () => resultOf('malformed', {
        skipReason: 'acme is not active',
        entitiesCreated: 3,
        findings: [real, { kind: 'phplog', text: NOISE_TEXT }],
      })),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);
    const malformed = results[0]!;

    // The real finding survives, the baseline noise is still subtracted, the error is appended.
    expect(malformed.findings).toEqual([
      real,
      { kind: 'assertion', text: expect.stringMatching(/half-declared skip/) },
    ]);
    // It ran and created three entities; that fact is not erased by the shape being refused.
    expect(malformed.entitiesCreated).toBe(3);
  });

  it('keeps a malformed result\'s notes when it is turned into a failure', async () => {
    const suite = register(scripted('noted', async () => resultOf('noted', { skipReason: 'half', notes: ['said something'] })));

    const [result] = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(result?.notes).toEqual(['said something']);
  });

  it('returns results the renderer can always consume', async () => {
    // The contract runSuite owes the summary: whatever the journeys did, every result it hands
    // back is well-formed enough for `outcomeOf` — so the summary always prints.
    const { renderSummary, exitCodeFor } = await import('../src/report/summary.ts');
    const suite = register(
      scripted('ok', async () => resultOf('ok')),
      scripted('malformed', async () => resultOf('malformed', { skipReason: 'nope' })),
      scripted('boom', async () => { throw new Error('chromium crashed'); }),
    );

    const results = await runSuite(suite, nothing, nothing, nothing, BASELINE);

    expect(() => renderSummary(results)).not.toThrow();
    expect(exitCodeFor(results)).toBe(1);
    expect(renderSummary(results)).toContain('2 failed');
  });
});

describe('manifestPlan (R70: the manifest directory is not the mount path)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function manifestDir(manifest?: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wpj-cli-'));
    dirs.push(dir);
    if (manifest !== undefined) await writeFile(join(dir, 'wp-journeys.json'), JSON.stringify(manifest));
    return dir;
  }

  const manifest = (plugin: string, journeys: unknown[], extra: Record<string, unknown> = {}) =>
    ({ version: 1, plugin, journeys, ...extra });
  const denial = {
    name: 'acme-editor-is-denied', actor: 'editor', surface: 'admin',
    screens: [{ url: '/wp-admin/admin.php?page=acme', allow: [], deny: ['editor'] }],
  };

  it('authors nothing when no manifest directory is named — the zero-authoring run', async () => {
    expect(await manifestPlan({}, 'acme')).toEqual({ journeys: [], deprecatedShortcodes: [] });
  });

  it('interprets the manifest in WPJ_MANIFEST_DIR, and hands over its declared deprecations (R74)', async () => {
    const dir = await manifestDir(manifest('acme', [denial], { deprecated: { shortcodes: ['acme_old'] } }));

    const plan = await manifestPlan({ WPJ_MANIFEST_DIR: dir }, 'acme');

    expect(plan.journeys.map((j) => `${j.name}:${j.actor}:${j.surface}`)).toEqual(['acme-editor-is-denied:editor:admin']);
    expect(plan.deprecatedShortcodes).toEqual(['acme_old']);
  });

  it('resolves an escape-hatch module against the manifest directory, never the runner\'s cwd', async () => {
    // The wiring trap: interpret(manifest) alone resolved AND confined module paths against
    // process.cwd(), so a module next to the manifest was simply not found.
    const dir = await manifestDir(manifest('acme', [
      { name: 'acme-custom', actor: 'editor', surface: 'admin', module: 'custom.mjs' },
    ]));
    await writeFile(join(dir, 'custom.mjs'), [
      'export default { name: "x", actor: "editor", surface: "admin",',
      '  run: async () => ({ name: "x", actor: "editor", surface: "admin", entitiesCreated: 0,',
      '    findings: [{ kind: "assertion", text: "the module beside the manifest ran" }] }) };',
    ].join('\n'));

    const [journey] = (await manifestPlan({ WPJ_MANIFEST_DIR: dir }, 'acme')).journeys;
    const result = await journey?.run(nothing, nothing, nothing);

    expect(result?.findings).toEqual([{ kind: 'assertion', text: 'the module beside the manifest ran' }]);
  });

  it('refuses a named directory that holds no manifest — the operator meant one to run', async () => {
    // Exactly first contact's first mistake: naming the plugin ROOT when the manifest lives in
    // tests/e2e. loadManifest reads that as "this plugin has none", and the run goes green
    // with not one authored journey in it.
    const dir = await manifestDir();

    await expect(manifestPlan({ WPJ_MANIFEST_DIR: dir }, 'acme'))
      .rejects.toThrow(`WPJ_MANIFEST_DIR is set, but ${join(dir, 'wp-journeys.json')} does not exist`);
  });

  it('refuses WPJ_MANIFEST_DIR set to the empty string, rather than reading it as unset', async () => {
    await expect(manifestPlan({ WPJ_MANIFEST_DIR: '' }, 'acme'))
      .rejects.toThrow(/WPJ_MANIFEST_DIR is set but empty/);
  });

  it('refuses a manifest written for a different plugin', async () => {
    const dir = await manifestDir(manifest('other-plugin', [denial]));

    await expect(manifestPlan({ WPJ_MANIFEST_DIR: dir }, 'acme'))
      .rejects.toThrow(/declares plugin "other-plugin", but the run is against "acme"/);
  });

  it('refuses the old variable name rather than silently running without the manifest', async () => {
    const dir = await manifestDir(manifest('acme', [denial]));

    await expect(manifestPlan({ WPJ_PLUGIN_DIR: dir }, 'acme'))
      .rejects.toThrow(/WPJ_PLUGIN_DIR is no longer read.*WPJ_MANIFEST_DIR/);
  });

  it('refuses an authored name that collides with a core journey\'s, by itself', async () => {
    const dir = await manifestDir(manifest('acme', [{ ...denial, name: 'lifecycle:acme' }]));

    await expect(manifestPlan({ WPJ_MANIFEST_DIR: dir }, 'acme'))
      .rejects.toThrow(/duplicate journey name "lifecycle:acme"/);
  });

  it('refuses that collision BEFORE any wp-cli call touches the site', async () => {
    // It used to be caught inside coreSuite, after the baseline had already deactivated and
    // reactivated the plugin under test. The agent here ANSWERS status(), which the baseline asks
    // first, so a late check would let the run reach the deactivate — the wp-cli command below,
    // which leaves a marker — before failing. Only an early check leaves no marker.
    const dir = await manifestDir(manifest('acme', [{ ...denial, name: 'frontend-renders' }]));
    const marker = join(dir, 'wp-cli-ran');
    const agent = {
      status: async () => ({ ok: true, wp: '7.1', php: '8.4', debugLog: true, pluginActive: false }),
    } as unknown as AgentClient;
    const unreachable = () => Promise.reject(new Error('the agent was asked for more than status()'));
    const answering = new Proxy(agent, {
      get: (target, property) => (property in target ? target[property as keyof AgentClient] : unreachable),
    });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let outcome: unknown;
    try {
      outcome = await main(['run', '--plugin', 'acme'], {
        WPJ_BASE_URL: 'https://site.test', WPJ_AGENT_SECRET: 'x'.repeat(16),
        WPJ_WP: `touch ${marker} #`, WPJ_MANIFEST_DIR: dir,
      }, () => answering).then(() => 'resolved', (error: unknown) => error);
    } finally {
      process.stderr.write = stderr;
    }

    // The ordering first: had any wp-cli command run, the marker would exist.
    await expect(access(marker)).rejects.toThrow();
    expect(String(outcome)).toMatch(/duplicate journey name "frontend-renders"/);
  });
});

describe('the run builder (R88: one way to build a run, shared by `wpj run` and the MCP server)', () => {
  const NO_PLAN = { journeys: [], deprecatedShortcodes: [] };
  const RAW: RawRegistries = {
    menu: [], submenu: {}, blocks: [], shortcodes: [], routes: {}, roles: { administrator: ['read'] }, pluginPages: [],
  };

  it('names the whole suite without touching the site, and marks only lifecycle as uninstalling', () => {
    const shape = suiteShape('acme', NO_PLAN);

    expect(Object.keys(shape)).toContain('lifecycle:acme');
    expect(Object.keys(shape)).toContain('admin-sweep:acme:subscriber');
    const uninstalling = Object.values(shape).filter((journey) => journey.uninstallsPlugin).map((j) => j.name);
    expect(uninstalling).toEqual(['lifecycle:acme']);
  });

  it('includes the manifest\'s authored journeys in the shape', () => {
    const authored = scripted('acme-own', async () => resultOf('acme-own'));
    expect(Object.keys(suiteShape('acme', { journeys: [authored], deprecatedShortcodes: [] }))).toContain('acme-own');
  });

  it('builds the wp-cli actions from the operator\'s command, uninstall included with --skip-delete', async () => {
    const ran: string[] = [];
    const actions = siteActions('wp', 'acme', async (command) => { ran.push(command); });

    await actions.deactivate();
    await actions.activate();
    await actions.uninstall();

    expect(ran).toEqual([
      'wp plugin deactivate acme', 'wp plugin activate acme',
      'wp plugin uninstall acme --deactivate --skip-delete',
    ]);
  });

  it('captures the baseline around a deactivate/activate pair, then builds the suite — and never uninstalls', async () => {
    const order: string[] = [];
    const agent = {
      status: async () => { order.push('status'); return { ok: true, wp: '7.1', php: '8.4', debugLog: true, pluginActive: false }; },
      ensureActor: async () => ({ userId: 5 }),
      discover: async () => { order.push('discover'); return RAW; },
      snapshot: async () => ({ options: [], tables: [], cron: [], userMeta: [] }),
      logDelta: async () => ({ offset: 1, lines: [], available: true }),
    } as unknown as AgentClient;
    const fetchImpl = (async () => new Response('<html><body>home</body></html>')) as typeof fetch;

    const prepared = await prepareSuite(agent, { baseUrl: 'https://s.test/', secret: 'x'.repeat(16) }, 'acme', NO_PLAN, {
      deactivate: async () => { order.push('deactivate'); },
      activate: async () => { order.push('activate'); },
      uninstall: async () => { order.push('UNINSTALL'); },
    }, fetchImpl);

    expect(order[0]).toBe('status');
    expect(order[1]).toBe('deactivate');
    expect(order).toContain('activate');
    expect(order.indexOf('activate')).toBeLessThan(order.lastIndexOf('discover'));
    expect(order).not.toContain('UNINSTALL');
    expect(prepared.baseline.activeAtStart).toBe(false);
    expect(Object.keys(prepared.suite)).toEqual(Object.keys(suiteShape('acme', NO_PLAN)));
    // The capability map is the site's own, not the delta's (conformanceSurface).
    expect(prepared.surface.caps).toEqual({ administrator: ['read'] });
  });
});

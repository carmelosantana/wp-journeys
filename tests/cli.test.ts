import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { register } from '../src/journeys/index.ts';
import type { Journey, JourneyResult } from '../src/journeys/index.ts';
import { parseArgs, runSuite, wpCommands } from '../src/runner/cli.ts';
import type { Baseline } from '../src/suite/baseline.ts';

/** A per-request deprecation this site writes whatever is under test (R45). */
const NOISE_TEXT = 'PHP Deprecated: Creation of dynamic property Acme::$x is deprecated';

const BASELINE: Baseline = {
  surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
  snapshot: { options: [], tables: [], cron: [], userMeta: [] },
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
    // `wpj skills install` arrives in Task 16; today it is not a command and must not be
    // silently treated as `run`.
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

describe('the wpj entry point', () => {
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

  it('names the environment variables without ever carrying a value for the secret', () => {
    const { stdout, stderr } = runCli([]);
    const all = stdout + stderr;

    expect(all).toContain('WPJ_AGENT_SECRET');
    expect(all).not.toMatch(/WPJ_AGENT_SECRET\s*[=:]\s*\S/);
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

import { describe, expect, it } from 'vitest';

import type { AgentClient, AgentStatus, LogDelta } from '../src/agent/client.ts';
import type { Config } from '../src/config.ts';
import type { Snapshot } from '../src/discovery/snapshot.ts';
import type { RawRegistries } from '../src/discovery/types.ts';
import type { Finding } from '../src/sentinel/phplog.ts';
import { captureBaseline, withoutBaselineNoise } from '../src/suite/baseline.ts';

const CFG: Config = { baseUrl: 'https://s.test/', secret: 'x'.repeat(16) };

const RAW: RawRegistries = {
  menu: [['Settings', 'manage_options', 'options-general.php']],
  submenu: {}, blocks: [], shortcodes: [], routes: {}, roles: {}, pluginPages: [],
};

const SNAPSHOT: Snapshot = {
  options: ['siteurl'], tables: ['wp_posts'], cron: ['wp_version_check'], userMeta: ['wpj_actor'],
};

const STATUS: AgentStatus = { ok: true, wp: '7.1', php: '8.4.25', debugLog: true };

/** A deprecation this site writes on EVERY request, whatever is being tested. */
const NOISE_LINE =
  '[15-Sep-2026 22:40:00 UTC] PHP Deprecated:  Creation of dynamic property Acme::$x is deprecated in /wp-content/themes/acme/functions.php on line 12';
const NOISE_TEXT =
  'PHP Deprecated: Creation of dynamic property Acme::$x is deprecated in /wp-content/themes/acme/functions.php on line 12';

/** A line that merely happened to land in one window: WP-Cron, or the wp-cli call's own tail. */
const ONE_OFF_LINE =
  '[15-Sep-2026 22:41:00 UTC] PHP Warning:  Undefined array key "id" in /wp-content/plugins/acme/acme.php on line 7';
const ONE_OFF_TEXT =
  'PHP Warning: Undefined array key "id" in /wp-content/plugins/acme/acme.php on line 7';

/** A theme diagnostic emitted during wp_head — which no REST request can ever reach. */
const RENDER_LINE =
  '[15-Sep-2026 22:42:00 UTC] PHP Deprecated:  strlen(): Passing null to parameter #1 is deprecated in /wp-content/themes/acme/header.php on line 8';
const RENDER_TEXT =
  'PHP Deprecated: strlen(): Passing null to parameter #1 is deprecated in /wp-content/themes/acme/header.php on line 8';

/** The four windows the probe reads, all quiet. */
const QUIET: string[][] = [[], [], [], []];

/**
 * The agent, the plugin toggles and the front-end fetch, all recording into ONE ordered
 * sequence. The ordering is the whole point: a baseline taken with the plugin still active
 * attributes its screens and its deprecations to itself and can never find anything.
 *
 * `windows` scripts what each successive log READ returns, in probe order.
 */
function harness(options: { windows?: string[][]; agent?: Partial<AgentClient> } = {}) {
  const sequence: string[] = [];
  const windows = [...(options.windows ?? QUIET)];

  const base: Partial<AgentClient> = {
    ensureActor: async () => ({ userId: 7 }),
    discover: async () => RAW,
    snapshot: async () => SNAPSHOT,
    status: async () => STATUS,
    logDelta: async (offset: number | 'end') =>
      (offset === 'end'
        ? { offset: 100, lines: [], available: true }
        : { offset: 220, lines: windows.shift() ?? [], available: true }) satisfies LogDelta,
  };
  const arranged = { ...base, ...options.agent } as Record<string, unknown>;
  const agent = new Proxy({}, {
    get(_target, property: string) {
      const method = arranged[property];
      if (typeof method !== 'function') {
        throw new Error(`captureBaseline must not call agent.${property}()`);
      }
      return (...args: unknown[]) => {
        sequence.push(`${property}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
        return (method as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as AgentClient;

  const fetchImpl = (async (url: string) => {
    sequence.push(`GET ${url}`);
    return new Response('<html><head></head><body>home</body></html>');
  }) as unknown as typeof fetch;

  return {
    agent,
    sequence,
    fetchImpl,
    deactivate: async () => { sequence.push('deactivate'); },
    activate: async () => { sequence.push('activate'); },
  };
}

describe('captureBaseline', () => {
  it('reads the site with the plugin under test deactivated, and turns it back on after', async () => {
    const { agent, sequence, fetchImpl, deactivate, activate } = harness();

    await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(sequence).toEqual([
      'deactivate',
      // R36: the runner's own users must already exist when the snapshot is taken.
      'ensureActor("subscriber")',
      'ensureActor("contributor")',
      'ensureActor("author")',
      'ensureActor("editor")',
      'ensureActor("administrator")',
      'discover()',
      'snapshot()',
      // Two REST samples (the shape the sentinel's own round trip makes), then two front-end
      // renders (the shape wp_head runs in, R49). Each sample is bracketed by a size-only
      // baseline and the delta it produced, and each KIND is sampled twice so "per request" is
      // measured rather than inferred from one window (R48).
      'logDelta("end")', 'status()', 'logDelta(100)',
      'logDelta("end")', 'status()', 'logDelta(100)',
      'logDelta("end")', 'GET https://s.test/', 'logDelta(100)',
      'logDelta("end")', 'GET https://s.test/', 'logDelta(100)',
      'activate',
    ]);
  });

  it('provisions every user-backed actor before the snapshot, and never the anonymous one', async () => {
    // ensureActor stamps `wpj_actor` user meta and the snapshot reports user-meta KEY NAMES, so
    // a baseline taken before the actors exist sees `wpj_actor` appear afterwards and reports it
    // as an orphan of the plugin under test — a false red on every plugin, forever (R36).
    // Asking for an anonymous user is refused by the agent: anonymous has no user at all.
    const { agent, sequence, fetchImpl, deactivate, activate } = harness();

    await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(sequence.filter((step) => step.startsWith('ensureActor'))).toEqual([
      'ensureActor("subscriber")', 'ensureActor("contributor")', 'ensureActor("author")',
      'ensureActor("editor")', 'ensureActor("administrator")',
    ]);
    expect(sequence.indexOf('ensureActor("administrator")')).toBeLessThan(sequence.indexOf('snapshot()'));
  });

  it('projects the raw registries, so the baseline is a Surface and not a dump', async () => {
    const { agent, fetchImpl, deactivate, activate } = harness();

    const baseline = await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(baseline.surface.screens).toEqual([
      { slug: 'options-general.php', url: '/wp-admin/options-general.php', capability: 'manage_options', title: 'Settings', parent: null },
    ]);
    expect(baseline.snapshot).toEqual(SNAPSHOT);
  });

  it('records the diagnostics this site writes on every request, which are nobody’s defect', async () => {
    // R45: the sentinel's own logDelta round trip is itself a WordPress request, so a
    // per-request notice lands in EVERY window. Only a baseline captured with the plugin under
    // test deactivated can tell that apart from a notice a visit provoked.
    const { agent, fetchImpl, deactivate, activate } = harness({
      windows: [
        // Core chatter the classifier already ignores rides along in the first window.
        [NOISE_LINE, '[15-Sep-2026 22:40:00 UTC] Automatic updates starting...'],
        [NOISE_LINE], [NOISE_LINE], [NOISE_LINE],
      ],
    });

    const baseline = await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(baseline.logNoise).toEqual([NOISE_TEXT]);
  });

  it('keeps only what BOTH samples of a probe saw, so a one-off line is never subtracted', async () => {
    // R48: debug.log is shared. WP-Cron firing during the window, or the deactivate wp-cli
    // call's own tail, drops in a line that is not per-request noise at all. Subtracting it
    // would strip a genuine defect carrying that text from every journey for the whole run —
    // the one over-subtraction route to a FALSE GREEN.
    const { agent, fetchImpl, deactivate, activate } = harness({
      windows: [[NOISE_LINE, ONE_OFF_LINE], [NOISE_LINE], [], []],
    });

    const baseline = await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(baseline.logNoise).toEqual([NOISE_TEXT]);
    expect(baseline.logNoise).not.toContain(ONE_OFF_TEXT);
  });

  it('measures a front-end render too, which no REST request can reach', async () => {
    // R49: wp_head never runs on a REST request, so a theme's per-render deprecation — the
    // common case on a real site, and the very shape this project's own canary uses — is
    // invisible to a REST-only probe and would be reported once per journey as a defect of the
    // plugin under test.
    const { agent, sequence, fetchImpl, deactivate, activate } = harness({
      windows: [[], [], [RENDER_LINE], [RENDER_LINE]],
    });

    const baseline = await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(baseline.logNoise).toEqual([RENDER_TEXT]);
    expect(sequence.filter((step) => step.startsWith('GET '))).toEqual([
      'GET https://s.test/', 'GET https://s.test/',
    ]);
  });

  it('does not subtract a render diagnostic that only one of the two renders produced', async () => {
    const { agent, fetchImpl, deactivate, activate } = harness({
      windows: [[], [], [RENDER_LINE], []],
    });

    expect((await captureBaseline(agent, CFG, deactivate, activate, fetchImpl)).logNoise).toEqual([]);
  });

  it('records no noise, rather than guessing, when the log signal is unavailable', async () => {
    // Under-subtracting costs a false red, which is loud. Guessing would cost a false green.
    const { agent, fetchImpl, deactivate, activate } = harness({
      agent: {
        logDelta: async () => ({ offset: 0, lines: [], available: false, reason: 'WP_DEBUG_LOG is off' }),
      },
    });

    const baseline = await captureBaseline(agent, CFG, deactivate, activate, fetchImpl);

    expect(baseline.logNoise).toEqual([]);
  });

  it('reactivates the plugin when DEACTIVATE itself fails, not only when the read does', async () => {
    // R47: wp-cli can deactivate the plugin and still exit non-zero — a shutdown notice, a
    // deactivation-hook warning, a timeout after the write landed. With deactivate() outside the
    // try, the site keeps the plugin OFF and every later journey drives a site the plugin is not
    // even on — and passes.
    const { agent, sequence, fetchImpl, activate } = harness();
    const deactivate = async () => {
      sequence.push('deactivate');
      throw new Error('wp-cli exited 1');
    };

    await expect(captureBaseline(agent, CFG, deactivate, activate, fetchImpl))
      .rejects.toThrow('wp-cli exited 1');
    expect(sequence).toEqual(['deactivate', 'activate']);
  });

  it('reactivates the plugin even when the read fails, and still reports the failure', async () => {
    const { agent, sequence, fetchImpl, deactivate, activate } = harness({
      agent: { snapshot: async () => { throw new Error('agent unreachable'); } },
    });

    await expect(captureBaseline(agent, CFG, deactivate, activate, fetchImpl))
      .rejects.toThrow('agent unreachable');
    expect(sequence.at(-1)).toBe('activate');
  });

  it('reports BOTH failures when the read failed and the plugin could not be turned back on', async () => {
    // A reactivation failure that replaced the original error would hide why the baseline was
    // abandoned in the first place, and both facts matter to whoever reads the run.
    const { agent, fetchImpl, deactivate } = harness({
      agent: { snapshot: async () => { throw new Error('agent unreachable'); } },
    });
    const activate = async () => { throw new Error('wp-cli could not reactivate'); };

    await expect(captureBaseline(agent, CFG, deactivate, activate, fetchImpl))
      .rejects.toThrow(/agent unreachable[\s\S]*wp-cli could not reactivate/);
  });
});

describe('withoutBaselineNoise', () => {
  const baseline = {
    surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
    snapshot: SNAPSHOT,
    logNoise: [NOISE_TEXT],
  };

  it('drops EVERY occurrence of a per-request diagnostic, not just the first', async () => {
    // A journey that loads three pages writes the site's per-request notice three times. Taking
    // one off would still leave two false reds on a plugin that did nothing wrong.
    const findings: Finding[] = [
      { kind: 'phplog', text: NOISE_TEXT },
      { kind: 'phplog', text: NOISE_TEXT },
      { kind: 'phplog', text: NOISE_TEXT },
    ];

    expect(withoutBaselineNoise(findings, baseline)).toEqual([]);
  });

  it('keeps a diagnostic the baseline never saw — that is the plugin under test', async () => {
    const findings: Finding[] = [
      { kind: 'phplog', text: NOISE_TEXT },
      { kind: 'phplog', text: ONE_OFF_TEXT },
    ];

    expect(withoutBaselineNoise(findings, baseline)).toEqual([findings[1]]);
  });

  it('subtracts only the log signal, never a finding another signal produced', async () => {
    // The baseline is measured from debug.log alone, so it is evidence about nothing else. A
    // bodyscan or a 500 that happens to carry the same words is a different observation.
    const findings: Finding[] = [
      { kind: 'bodyscan', text: NOISE_TEXT, url: 'https://s.test/' },
      { kind: 'assertion', text: NOISE_TEXT },
    ];

    expect(withoutBaselineNoise(findings, baseline)).toEqual(findings);
  });

  it('is the identity when the baseline recorded no noise', async () => {
    const findings: Finding[] = [{ kind: 'phplog', text: NOISE_TEXT }];

    expect(withoutBaselineNoise(findings, { ...baseline, logNoise: [] })).toEqual(findings);
  });
});

import { describe, expect, it } from 'vitest';

import type { AgentClient, AgentStatus, LogDelta } from '../src/agent/client.ts';
import type { Snapshot } from '../src/discovery/snapshot.ts';
import type { RawRegistries } from '../src/discovery/types.ts';
import type { Finding } from '../src/sentinel/phplog.ts';
import { captureBaseline, withoutBaselineNoise } from '../src/suite/baseline.ts';

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

/**
 * An agent plus the deactivate/activate pair, recording ONE ordered sequence across both. The
 * ordering is the whole point: a baseline taken with the plugin still active attributes its
 * screens and its deprecations to itself and can never find anything.
 */
function harness(over: Partial<AgentClient> = {}) {
  const sequence: string[] = [];
  const base: Partial<AgentClient> = {
    ensureActor: async () => ({ userId: 7 }),
    discover: async () => RAW,
    snapshot: async () => SNAPSHOT,
    status: async () => STATUS,
    logDelta: async (offset: number | 'end') =>
      (offset === 'end'
        ? { offset: 100, lines: [], available: true }
        : { offset: 220, lines: [], available: true }) satisfies LogDelta,
  };
  const arranged = { ...base, ...over } as Record<string, unknown>;
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

  return {
    agent,
    sequence,
    deactivate: async () => { sequence.push('deactivate'); },
    activate: async () => { sequence.push('activate'); },
  };
}

describe('captureBaseline', () => {
  it('reads the site with the plugin under test deactivated, and turns it back on after', async () => {
    const { agent, sequence, deactivate, activate } = harness();

    await captureBaseline(agent, deactivate, activate);

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
      // The noise probe: one ordinary WordPress request, bracketed by a size-only baseline and
      // the delta it produced. It must happen while the plugin is still off.
      'logDelta("end")',
      'status()',
      'logDelta(100)',
      'activate',
    ]);
  });

  it('provisions every user-backed actor before the snapshot, and never the anonymous one', async () => {
    // ensureActor stamps `wpj_actor` user meta and the snapshot reports user-meta KEY NAMES, so
    // a baseline taken before the actors exist sees `wpj_actor` appear afterwards and reports it
    // as an orphan of the plugin under test — a false red on every plugin, forever (R36).
    // Asking for an anonymous user is refused by the agent: anonymous has no user at all.
    const { agent, sequence, deactivate, activate } = harness();

    await captureBaseline(agent, deactivate, activate);

    expect(sequence.filter((step) => step.startsWith('ensureActor'))).toEqual([
      'ensureActor("subscriber")', 'ensureActor("contributor")', 'ensureActor("author")',
      'ensureActor("editor")', 'ensureActor("administrator")',
    ]);
    expect(sequence.indexOf('ensureActor("administrator")')).toBeLessThan(sequence.indexOf('snapshot()'));
  });

  it('projects the raw registries, so the baseline is a Surface and not a dump', async () => {
    const { agent, deactivate, activate } = harness();

    const baseline = await captureBaseline(agent, deactivate, activate);

    expect(baseline.surface.screens).toEqual([
      { slug: 'options-general.php', url: '/wp-admin/options-general.php', capability: 'manage_options', title: 'Settings', parent: null },
    ]);
    expect(baseline.snapshot).toEqual(SNAPSHOT);
  });

  it('records the diagnostics this site writes on every request, which are nobody’s defect', async () => {
    // R45: the sentinel's own logDelta round trip is itself a WordPress request, so a
    // per-request notice lands in EVERY window. Only a baseline captured with the plugin under
    // test deactivated can tell that apart from a notice a visit provoked.
    const { agent, deactivate, activate } = harness({
      logDelta: async (offset: number | 'end') =>
        (offset === 'end'
          ? { offset: 100, lines: [], available: true }
          : {
            offset: 220,
            // The second line is core chatter the classifier already ignores.
            lines: [NOISE_LINE, '[15-Sep-2026 22:40:00 UTC] Automatic updates starting...'],
            available: true,
          }) satisfies LogDelta,
    });

    const baseline = await captureBaseline(agent, deactivate, activate);

    expect(baseline.logNoise).toEqual([NOISE_TEXT]);
  });

  it('records no noise, rather than guessing, when the log signal is unavailable', async () => {
    // Under-subtracting costs a false red, which is loud. Guessing would cost a false green.
    const { agent, deactivate, activate } = harness({
      logDelta: async () => ({ offset: 0, lines: [], available: false, reason: 'WP_DEBUG_LOG is off' }),
    });

    const baseline = await captureBaseline(agent, deactivate, activate);

    expect(baseline.logNoise).toEqual([]);
  });

  it('reactivates the plugin even when the read fails, and still reports the failure', async () => {
    // Leaving the plugin under test deactivated would make every later journey test nothing at
    // all — and pass, which is the worst possible outcome of a failed baseline.
    const { agent, sequence, deactivate, activate } = harness({
      snapshot: async () => { throw new Error('agent unreachable'); },
    });

    await expect(captureBaseline(agent, deactivate, activate)).rejects.toThrow('agent unreachable');
    expect(sequence.at(-1)).toBe('activate');
  });
});

describe('withoutBaselineNoise', () => {
  const baseline = { surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} }, snapshot: SNAPSHOT, logNoise: [NOISE_TEXT] };

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
      { kind: 'phplog', text: 'PHP Warning: Undefined array key "id" in /wp-content/plugins/acme/acme.php on line 7' },
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

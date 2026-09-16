import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import type { Surface } from '../src/discovery/types.ts';
import type { JourneyResult } from '../src/journeys/index.ts';
import { exitCodeFor, renderSummary } from '../src/report/summary.ts';

const pass: JourneyResult = {
  name: 'frontend-renders', actor: Actor.ANONYMOUS, surface: 'frontend',
  entitiesCreated: 0, findings: [],
};
const skip: JourneyResult = {
  name: 'admin-sweep:acme', actor: Actor.EDITOR, surface: 'admin',
  entitiesCreated: 0, findings: [], skipped: true, skipReason: 'acme is not active',
};
const fail: JourneyResult = {
  name: 'lifecycle:acme', actor: Actor.ADMINISTRATOR, surface: 'admin',
  entitiesCreated: 2,
  findings: [{ kind: 'phplog', text: 'PHP Warning: Undefined array key "id"' }],
};

describe('renderSummary', () => {
  it('marks a skip as skip, never as ok', () => {
    const out = renderSummary([skip]);
    expect(out).toContain('skip');
    expect(out).not.toMatch(/\bok\b\s+admin-sweep/);
    expect(out).toContain('acme is not active');
  });

  it('counts pass, fail and skip separately in the header', () => {
    const out = renderSummary([pass, skip, fail]);
    expect(out).toContain('3 journeys');
    expect(out).toContain('1 passed');
    expect(out).toContain('1 failed');
    expect(out).toContain('1 skipped');
  });

  it('breaks down every finding under its failing journey', () => {
    expect(renderSummary([fail])).toContain('[phplog] PHP Warning: Undefined array key "id"');
  });

  it('reports coverage per surface so an unexercised half is visible', () => {
    const out = renderSummary([pass, fail]);
    expect(out).toContain('frontend: 1 of 1');
    expect(out).toContain('admin: 1 of 1');
  });

  it('counts a `both` journey toward each half of the surface axis', () => {
    // A manifest settings round-trip writes in wp-admin and reads back on the frontend: a
    // journey that genuinely spans both halves. (The render journeys are frontend-only now.)
    const both: JourneyResult = { ...pass, name: 'acme-settings-round-trip', surface: 'both' };
    const out = renderSummary([both]);
    expect(out).toContain('admin: 1 of 1');
    expect(out).toContain('frontend: 1 of 1');
  });

  it('never counts a SKIPPED journey as coverage (R58)', () => {
    // The binding constraint applied to the header statistic. A skipped journey asserted
    // nothing about its surface, so counting it as coverage tells a reader scanning the header
    // that the admin half is well exercised when in truth one journey ran — the same "a skip
    // reads as ok" defect, moved out of the per-journey line and into the summary.
    const skips = Array.from({ length: 6 }, (_, i) => ({ ...skip, name: `admin-sweep:acme:${i}` }));
    const out = renderSummary([...skips, pass]);

    expect(out).toContain('admin: 0 of 6');
    expect(out).toContain('frontend: 1 of 1');
    // The bare number that would read as six exercised admin journeys must not appear.
    expect(out).not.toMatch(/admin: 6\b/);
  });

  it('counts a FAILED journey as coverage, because it did exercise the surface', () => {
    // A failure is evidence: the journey drove the surface and found something there. Only a
    // skip asserted nothing at all.
    expect(renderSummary([fail])).toContain('admin: 1 of 1');
  });

  it('shows a run of nothing but skips as zero coverage on both halves', () => {
    const both: JourneyResult = { ...skip, name: 'acme-settings-round-trip', surface: 'both' };
    const out = renderSummary([skip, both]);

    expect(out).toContain('admin: 0 of 2');
    expect(out).toContain('frontend: 0 of 1');
  });

  describe('the discovered surface (first contact: an ok sweep did not say what it swept)', () => {
    const surface: Surface = {
      screens: [
        { slug: 'acme', url: '/wp-admin/admin.php?page=acme', capability: 'edit_posts', title: 'Acme', parent: null },
        { slug: 'acme-settings', url: '/wp-admin/admin.php?page=acme-settings', capability: 'manage_options', title: 'Settings', parent: 'acme' },
      ],
      blocks: ['acme/hello'],
      shortcodes: ['acme', 'acme_legacy'],
      restRoutes: [
        { route: '/acme/v1/chat', methods: ['POST'], guarded: true },
        { route: '/acme/v1/models', methods: ['GET'], guarded: true },
      ],
      caps: { administrator: ['manage_options'] },
    };

    it('names every screen, shortcode and block the run attributed to the plugin, between the header and the journeys', () => {
      const lines = renderSummary([pass], surface).split('\n');

      expect(lines.slice(1, 7)).toEqual([
        '  discovered: 2 admin screens, 2 shortcodes, 1 block, 2 REST routes',
        '    screen    /wp-admin/admin.php?page=acme (edit_posts)',
        '    screen    /wp-admin/admin.php?page=acme-settings (manage_options)',
        '    shortcode [acme]',
        '    shortcode [acme_legacy]',
        '    block     acme/hello',
      ]);
      expect(lines[7]).toContain('frontend-renders');
    });

    it('says so when the plugin added nothing, rather than printing an empty block', () => {
      const none: Surface = { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} };

      expect(renderSummary([pass], none).split('\n')[1])
        .toBe('  discovered: 0 admin screens, 0 shortcodes, 0 blocks, 0 REST routes');
    });

    it('leaves the summary exactly as it was when no surface is given', () => {
      expect(renderSummary([pass, fail])).not.toContain('discovered:');
    });
  });

  it('prints a journey\'s notes under it whatever its outcome — a pass can still say what it did not check', () => {
    const noted = (result: JourneyResult): JourneyResult => ({ ...result, notes: ['precondition: fresh site'] });
    const lines = renderSummary([noted(pass), noted(skip), noted(fail)]).split('\n');

    expect(lines.filter((line) => line === '      · precondition: fresh site')).toHaveLength(3);
    expect(lines.indexOf('      · precondition: fresh site')).toBe(lines.findIndex((l) => l.includes('frontend-renders')) + 1);
  });

  it('is deterministic for the same input', () => {
    expect(renderSummary([pass, skip, fail])).toBe(renderSummary([pass, skip, fail]));
  });

  it('handles an empty run without throwing', () => {
    expect(renderSummary([])).toContain('0 journeys');
  });

  it('renders a skip that carries no reason as a skip, not as an empty cell', () => {
    // `skipped: true` with no `skipReason` is legal and yields 'skip' (R39 only refuses the
    // opposite shape). A blank explanation would read as a rendering bug and invite the reader
    // to dismiss the line; the outcome must still be unmistakably a skip.
    const reasonless: JourneyResult = {
      name: 'admin-sweep:acme', actor: Actor.EDITOR, surface: 'admin',
      entitiesCreated: 0, findings: [], skipped: true,
    };
    const out = renderSummary([reasonless]);
    expect(out).toContain('skip');
    expect(out).toContain('1 skipped');
    expect(out).toMatch(/skipped \(\S[^)]*\)/);
  });

  it('renders a journey that skipped AND produced a finding as a FAIL, never toward the ok tally', () => {
    // The single most dangerous shape this renderer sees. A journey whose gate said "absent"
    // but whose gate probe itself hit a 5xx has lost a signal, and `outcomeOf` calls that a
    // fail. A renderer that read `result.skipped` directly would print `skip`, count it as
    // benign, and exit 0 — the exact "skip shown as ok" defect the constraints forbid.
    const dirty: JourneyResult = {
      name: 'admin-sweep:acme', actor: Actor.EDITOR, surface: 'admin',
      entitiesCreated: 0, skipped: true, skipReason: 'acme is not active',
      findings: [{ kind: 'response', text: 'HTTP 500 on /wp-admin/', status: 500 }],
    };
    const out = renderSummary([dirty]);

    expect(out).toContain('1 failed');
    expect(out).toContain('0 passed');
    expect(out).toContain('0 skipped');
    expect(out).toContain('HTTP 500 on /wp-admin/');
    expect(out).not.toMatch(/\bok\b/);
    expect(exitCodeFor([dirty])).toBe(1);
  });

  it('refuses a half-declared skip rather than rendering it as a pass (R39)', () => {
    // `skipReason` without `skipped: true` is indistinguishable downstream from a clean run.
    // The renderer inherits `outcomeOf`'s throw rather than softening it; the CLI is what
    // catches this, per journey, so one malformed result cannot abort the whole summary.
    const halfDeclared: JourneyResult = {
      name: 'admin-sweep:acme', actor: Actor.EDITOR, surface: 'admin',
      entitiesCreated: 0, findings: [], skipReason: 'acme is not active',
    };
    expect(() => renderSummary([halfDeclared])).toThrow(/half-declared skip/);
  });
});

describe('exitCodeFor', () => {
  it('is 0 when everything passed or skipped', () => {
    expect(exitCodeFor([pass, skip])).toBe(0);
  });

  it('is 1 when anything failed', () => {
    expect(exitCodeFor([pass, fail])).toBe(1);
  });

  it('is NOT 0 for an empty run — a suite that registered nothing must never read as success', () => {
    // The exit code is the one signal CI believes. Task 11's carry-forward warns precisely that
    // a suite which silently registers nothing also "passes" everything it has; without a floor
    // that state is indistinguishable from a clean run.
    expect(exitCodeFor([])).toBe(1);
    expect(renderSummary([])).toContain('0 journeys');
    expect(renderSummary([])).toMatch(/no journeys ran/i);
  });

  it('agrees with the summary text: a run of nothing but skips is not a failure', () => {
    expect(exitCodeFor([skip, skip])).toBe(0);
    expect(renderSummary([skip, skip])).toContain('2 skipped');
  });
});

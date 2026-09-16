import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
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
    expect(out).toContain('frontend: 1');
    expect(out).toContain('admin: 1');
  });

  it('counts a `both` journey toward each half of the surface axis', () => {
    const both: JourneyResult = { ...pass, name: 'shortcode-render:acme', surface: 'both' };
    const out = renderSummary([both]);
    expect(out).toContain('admin: 1');
    expect(out).toContain('frontend: 1');
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

  it('is 0 for an empty run, which asserted nothing but failed nothing either', () => {
    expect(exitCodeFor([])).toBe(0);
  });

  it('agrees with the summary text: a run of nothing but skips is not a failure', () => {
    expect(exitCodeFor([skip, skip])).toBe(0);
    expect(renderSummary([skip, skip])).toContain('2 skipped');
  });
});

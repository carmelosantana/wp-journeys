import { describe, expect, it } from 'vitest';

import { outcomeOf } from '../src/journeys/index.ts';
import type { Snapshot } from '../src/discovery/snapshot.ts';
import type { Baseline } from '../src/suite/baseline.ts';
import { lifecycle } from '../src/suite/lifecycle.ts';
import { CFG, FakeBrowser, FakePage, fakeAgent, landsOn } from './helpers/fakes.ts';

const empty: Snapshot = { options: ['siteurl'], tables: [], cron: [], userMeta: [] };

function baselineWith(over: Partial<Baseline> = {}): Baseline {
  return {
    surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
    snapshot: empty, logNoise: [], bodyNoise: [], activeAtStart: false, ...over,
  };
}

/** Drive lifecycle against fakes; `after` is what the post-uninstall snapshot answers. */
async function runLifecycle(baseline: Baseline, after: Snapshot) {
  const page = new FakePage();
  page.navigations = [landsOn('https://s.test/wp-admin/')];
  const asked: Array<string | undefined> = [];
  const { agent } = fakeAgent({
    snapshot: async (plugin?: string) => { asked.push(plugin); return after; },
  });
  let uninstalled = 0;
  const result = await lifecycle('acme', baseline, async () => { uninstalled += 1; })
    .run(new FakeBrowser(page).asBrowser(), CFG, agent);
  return { result, asked, uninstalled };
}

describe('lifecycle: the plugin must really be gone (R79)', () => {
  it('asks the post-uninstall snapshot about the plugin under test', async () => {
    const { asked, uninstalled } = await runLifecycle(baselineWith(), { ...empty, pluginActive: false });
    expect(uninstalled).toBe(1);
    expect(asked).toEqual(['acme']);
  });

  it('fails loudly when the plugin is still active after the uninstall', async () => {
    const { result } = await runLifecycle(baselineWith(), { ...empty, pluginActive: true });

    expect(outcomeOf(result)).toBe('fail');
    expect(JSON.stringify(result.findings)).toContain('acme is still active after the uninstall');
  });

  it('fails when the agent did not say whether the plugin is still active — unknown is not gone', async () => {
    const { result } = await runLifecycle(baselineWith(), empty);

    expect(outcomeOf(result)).toBe('fail');
    expect(JSON.stringify(result.findings)).toContain('could not say whether acme is still active');
  });
});

describe('lifecycle: what its orphan check can see (R75)', () => {
  const gone: Snapshot = { ...empty, pluginActive: false };

  it('is a visible SKIP when the plugin was already active at the baseline', async () => {
    const { result } = await runLifecycle(baselineWith({ activeAtStart: true }), gone);

    expect(outcomeOf(result)).toBe('skip');
    expect(result.skipReason).toMatch(/acme was already active when the baseline was taken/);
    expect(result.skipReason).toMatch(/leftovers are invisible/);
  });

  it('stays RED when it finds orphans anyway, active at the baseline or not', async () => {
    const { result } = await runLifecycle(
      baselineWith({ activeAtStart: true }), { ...gone, options: [...empty.options, 'acme_version'] },
    );

    expect(outcomeOf(result)).toBe('fail');
    expect(JSON.stringify(result.findings)).toContain('options=acme_version');
    // A red row prints no skipReason, so the caveat must travel as a note: this orphan list can
    // be INCOMPLETE, because whatever activation created was already in the baseline.
    expect(result.notes).toEqual([expect.stringMatching(
      /orphans listed here may be incomplete: acme was already active when the baseline was taken/,
    )]);
  });

  it('may pass when the plugin was inactive at the baseline, but states the precondition it rests on', async () => {
    const { result } = await runLifecycle(baselineWith({ activeAtStart: false }), gone);

    expect(outcomeOf(result)).toBe('pass');
    expect(result.notes).toEqual([
      'sound only if acme was never activated on this site before this run: state an earlier activation left behind is already in the baseline',
    ]);
  });
});

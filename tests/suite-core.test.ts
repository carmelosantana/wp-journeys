import { describe, expect, it } from 'vitest';

import { ALL_ACTORS, Actor } from '../src/actors/roles.ts';
import { surfaceDelta } from '../src/discovery/surface.ts';
import { outcomeOf } from '../src/journeys/index.ts';
import type { Journey } from '../src/journeys/index.ts';
import { CONTROL_SCREEN } from '../src/journeys/support.ts';
import { accessMatrix } from '../src/suite/admin-access-matrix.ts';
import { conformanceSurface, coreSuite } from '../src/suite/index.ts';
import { adminSweep, blockRender, shortcodeRender, sweepPlan } from '../src/suite/rendered-surface.ts';
import { CFG, FakeBrowser, FakePage, fakeAgent, landsOn } from './helpers/fakes.ts';
import type { Surface } from '../src/discovery/types.ts';

const delta: Surface = {
  screens: [
    { slug: 'acme', url: '/wp-admin/admin.php?page=acme', capability: 'manage_options', title: 'Acme', parent: null },
    { slug: 'acme-public', url: '/wp-admin/admin.php?page=acme-public', capability: 'read', title: 'Public', parent: 'acme' },
  ],
  blocks: [], shortcodes: [], restRoutes: [],
  caps: {
    administrator: ['manage_options', 'read', 'edit_posts'],
    editor: ['read', 'edit_posts'],
    subscriber: ['read'],
  },
};

describe('accessMatrix', () => {
  it('expects a denial for every actor lacking the screen’s capability', () => {
    const cases = accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR, Actor.SUBSCRIBER]);

    const acme = cases.filter((c) => c.screen.slug === 'acme');
    expect(acme.find((c) => c.actor === Actor.ADMINISTRATOR)?.denyExpected).toBe(false);
    expect(acme.find((c) => c.actor === Actor.EDITOR)?.denyExpected).toBe(true);
    expect(acme.find((c) => c.actor === Actor.SUBSCRIBER)?.denyExpected).toBe(true);
  });

  it('expects everyone with `read` to reach a `read` screen', () => {
    const cases = accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR, Actor.SUBSCRIBER]);
    for (const c of cases.filter((x) => x.screen.slug === 'acme-public')) {
      expect(c.denyExpected, `${c.actor}`).toBe(false);
    }
  });

  it('always expects a denial for anonymous, which holds no capabilities at all', () => {
    const cases = accessMatrix(delta, [Actor.ANONYMOUS]);
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.denyExpected)).toBe(true);
  });

  it('produces one case per screen per actor', () => {
    expect(accessMatrix(delta, [Actor.ADMINISTRATOR, Actor.EDITOR])).toHaveLength(4);
  });

  it('is empty when the plugin added no admin screens', () => {
    expect(accessMatrix({ ...delta, screens: [] }, [Actor.ADMINISTRATOR])).toEqual([]);
  });

  it('expects a denial for a role the site does not define at all', () => {
    // A role absent from the capability map holds nothing. Reading a missing entry as
    // "unrestricted" would turn every screen into an expected 200 for that actor, and a real
    // permission hole would pass.
    const cases = accessMatrix(delta, [Actor.CONTRIBUTOR]);
    expect(cases.every((c) => c.denyExpected)).toBe(true);
  });
});

describe('conformanceSurface', () => {
  const before: Surface = {
    screens: [{ slug: 'index.php', url: '/wp-admin/index.php', capability: 'read', title: 'Dashboard', parent: null }],
    blocks: [], shortcodes: [], restRoutes: [],
    caps: { administrator: ['manage_options', 'read'], editor: ['read'] },
  };
  const after: Surface = {
    ...before,
    screens: [
      ...before.screens,
      { slug: 'acme', url: '/wp-admin/admin.php?page=acme', capability: 'manage_options', title: 'Acme', parent: null },
    ],
  };

  it('drives only the screens the plugin added', () => {
    expect(conformanceSurface(before, after).screens.map((s) => s.slug)).toEqual(['acme']);
  });

  it('judges them against the SITE’s capabilities, not the delta’s', () => {
    // surfaceDelta reports only the capabilities a plugin ADDED, so its caps are empty for a
    // plugin that added none. Handing that straight to accessMatrix inverts the entire sweep:
    // the administrator comes out expected to be DENIED its own settings screen, and every
    // screen that actually answered 200 is reported as a defect.
    const naive = accessMatrix(surfaceDelta(before, after), [Actor.ADMINISTRATOR]);
    expect(naive[0]?.denyExpected).toBe(true);

    const corrected = accessMatrix(conformanceSurface(before, after), [Actor.ADMINISTRATOR]);
    expect(corrected[0]?.denyExpected).toBe(false);
  });
});

describe('sweepPlan', () => {
  const CONTROL = CONTROL_SCREEN;
  const screensOf = (plan: ReadonlyArray<{ url: string }>) => plan.filter((s) => s.url !== CONTROL);

  it('opens an authenticated sweep with a control visit no anonymous session could pass (R54)', () => {
    // A sweep whose login was silently refused runs as an anonymous visitor — and every denial
    // it expects is then satisfied by WordPress's login redirect, so it goes green having
    // proved nothing. One screen every logged-in role can reach, asserted as ALLOWED, is what
    // makes a secretly-anonymous sweep impossible to pass.
    expect(sweepPlan(delta, Actor.SUBSCRIBER)[0]).toEqual({ url: CONTROL, denyExpected: false });
  });

  it('gives the anonymous actor no control visit, because it has no session to prove', () => {
    expect(sweepPlan(delta, Actor.ANONYMOUS).some((step) => step.url === CONTROL)).toBe(false);
  });

  it('carries the matrix’s verdict for each screen', () => {
    expect(screensOf(sweepPlan(delta, Actor.SUBSCRIBER))).toEqual([
      { url: '/wp-admin/admin.php?page=acme', denyExpected: true },
      { url: '/wp-admin/admin.php?page=acme-public', denyExpected: false },
    ]);
  });

  it('asserts one URL once, however many screens WordPress links there (R56)', () => {
    // A promoted container and its first submenu are two screens at ONE url. Visiting it twice
    // asserts nothing extra, and if their capabilities ever disagreed the second expectation
    // would be a guaranteed false defect against the plugin under test.
    const shared: Surface = {
      ...delta,
      screens: [
        { slug: 'acme-container', url: '/wp-admin/admin.php?page=acme-home', capability: 'read', title: 'Acme', parent: null },
        { slug: 'acme-home', url: '/wp-admin/admin.php?page=acme-home', capability: 'read', title: 'Home', parent: 'acme-container' },
      ],
    };

    expect(screensOf(sweepPlan(shared, Actor.SUBSCRIBER))).toEqual([
      { url: '/wp-admin/admin.php?page=acme-home', denyExpected: false },
    ]);
  });
});

describe('coreSuite', () => {
  const baseline = {
    surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
    snapshot: { options: [], tables: [], cron: [], userMeta: [] },
    logNoise: [],
    bodyNoise: [],
  };

  it('registers the shared journeys plus one admin sweep per actor', () => {
    // register() refuses duplicate names, because the name is the registry key — so a naming
    // scheme that collided between two actors would drop a journey silently without it.
    const suite = coreSuite('acme', delta, baseline, async () => {});

    expect(Object.keys(suite).sort()).toEqual([
      'admin-sweep:acme:administrator',
      'admin-sweep:acme:anonymous',
      'admin-sweep:acme:author',
      'admin-sweep:acme:contributor',
      'admin-sweep:acme:editor',
      'admin-sweep:acme:subscriber',
      'block-render:acme',
      'frontend-renders',
      'lifecycle:acme',
      'shortcode-render:acme',
    ]);
  });

  /** A manifest journey as the CLI hands it over; never run here. */
  const authored = (name: string): Journey => ({
    name, actor: Actor.EDITOR, surface: 'admin', run: () => Promise.reject(new Error('not run in this test')),
  });

  it('runs a plugin\'s authored journeys, and runs them BEFORE the uninstall', () => {
    // The lifecycle journey uninstalls the plugin under test. An authored journey queued after
    // it would drive a site the plugin is no longer on, and fail for a reason that is the
    // runner's, not the plugin's.
    const suite = coreSuite('acme', delta, baseline, async () => {}, [authored('acme-a'), authored('acme-b')]);
    const order = Object.keys(suite);

    expect(order).toContain('acme-a');
    expect(order).toContain('acme-b');
    expect(order.at(-1)).toBe('lifecycle:acme');
    expect(order.indexOf('acme-a')).toBeLessThan(order.indexOf('acme-b'));
  });

  it('refuses an authored journey whose name collides with a core one, rather than dropping either', () => {
    expect(() => coreSuite('acme', delta, baseline, async () => {}, [authored('frontend-renders')]))
      .toThrow(/duplicate journey name "frontend-renders"/);
  });

  it('binds every journey to the actor its name claims', () => {
    const suite = coreSuite('acme', delta, baseline, async () => {});

    for (const actor of ALL_ACTORS) {
      expect(suite[`admin-sweep:acme:${actor}`]?.actor).toBe(actor);
    }
  });
});

describe('a journey whose subject is absent skips, and a skip is never a pass', () => {
  const empty: Surface = { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} };
  // The skip is decided before anything is driven, so no browser, config or agent is touched.
  // Passing nothing is the proof of that: a journey that reached for one would throw here.
  const nothing = undefined as never;

  it('adminSweep skips when the plugin added no admin screens', async () => {
    const result = await adminSweep('acme', empty, Actor.EDITOR).run(nothing, nothing, nothing);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('no admin screens');
    expect(outcomeOf(result)).toBe('skip');
  });

  it('blockRender skips when the plugin registered no blocks (R57)', async () => {
    const result = await blockRender('acme', empty).run(nothing, nothing, nothing);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('no blocks');
    expect(outcomeOf(result)).toBe('skip');
  });

  it('shortcodeRender skips when the plugin registered no shortcodes', async () => {
    const result = await shortcodeRender('acme', empty).run(nothing, nothing, nothing);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('no shortcodes');
    expect(outcomeOf(result)).toBe('skip');
  });
});

describe('blockRender (R57: the discovered block axis is exercised, not only listed)', () => {
  const withBlocks: Surface = { ...delta, blocks: ['acme/hello', 'acme/card'] };

  function arrange(body: string) {
    const page = new FakePage();
    page.navigations = [landsOn('https://s.test/wp-admin/')];
    page.body = body;
    const { agent } = fakeAgent();
    const run = () => blockRender('acme', withBlocks).run(new FakeBrowser(page).asBrowser(), CFG, agent);
    return { page, run };
  }

  it('renders every block the plugin added through the agent, as an administrator', async () => {
    const { page, run } = arrange('<div data-wpj-render-block="1" data-wpj-registered="1" data-wpj-dynamic="1">x</div>');

    const result = await run();

    expect(result.findings).toEqual([]);
    expect(outcomeOf(result)).toBe('pass');
    expect(page.gotos.slice(1)).toEqual(['/?wpj_render_block=acme%2Fhello', '/?wpj_render_block=acme%2Fcard']);
  });

  it('fails when a render proves nothing, naming the block', async () => {
    const { run } = arrange('<html><body>home</body></html>');

    const result = await run();

    expect(outcomeOf(result)).toBe('fail');
    expect(result.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringContaining('the block acme/hello produced no wp-journeys render marker') },
    ]);
  });
});

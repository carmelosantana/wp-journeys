import { describe, expect, it } from 'vitest';

import { ALL_ACTORS, Actor } from '../src/actors/roles.ts';
import { surfaceDelta } from '../src/discovery/surface.ts';
import { outcomeOf } from '../src/journeys/index.ts';
import { accessMatrix } from '../src/suite/admin-access-matrix.ts';
import { conformanceSurface, coreSuite } from '../src/suite/index.ts';
import { adminSweep, shortcodeRender } from '../src/suite/rendered-surface.ts';
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

describe('coreSuite', () => {
  const baseline = {
    surface: { screens: [], blocks: [], shortcodes: [], restRoutes: [], caps: {} },
    snapshot: { options: [], tables: [], cron: [], userMeta: [] },
    logNoise: [],
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
      'frontend-renders',
      'lifecycle:acme',
      'shortcode-render:acme',
    ]);
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

  it('shortcodeRender skips when the plugin registered no shortcodes', async () => {
    const result = await shortcodeRender('acme', empty).run(nothing, nothing, nothing);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('no shortcodes');
    expect(outcomeOf(result)).toBe('skip');
  });
});

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { interpret } from '../src/manifest/interpret.ts';
import { parseManifest } from '../src/manifest/schema.ts';
import { CFG, FakeBrowser, FakePage, fakeAgent, landsOn } from './helpers/fakes.ts';

const valid = {
  version: 1,
  plugin: 'acme',
  gate: { screen: 'acme' },
  journeys: [
    {
      name: 'acme-settings-round-trip',
      actor: 'administrator',
      surface: 'both',
      settings: [
        { url: '/wp-admin/admin.php?page=acme', field: '#acme_title', value: 'Hello', readBack: '/' },
      ],
    },
    { name: 'acme-custom', actor: 'editor', surface: 'admin', module: 'tests/journeys/acme-custom.ts' },
  ],
};

/** `valid` with its first journey replaced by `journey`. */
function withJourney(journey: Record<string, unknown>) {
  return { ...valid, journeys: [journey] };
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(valid, 'wp-journeys.json').plugin).toBe('acme');
  });

  it('names the file and the problem when the version is missing', () => {
    expect(() => parseManifest({ plugin: 'acme', journeys: [] }, 'acme/wp-journeys.json'))
      .toThrow(/acme\/wp-journeys\.json: "version" must be 1/);
  });

  it('rejects an unknown version rather than guessing', () => {
    expect(() => parseManifest({ ...valid, version: 2 }, 'f.json')).toThrow(/"version" must be 1/);
  });

  it('rejects an unknown actor by name', () => {
    const bad = { ...valid, journeys: [{ ...valid.journeys[0], actor: 'superadmin' }] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/unknown actor "superadmin"/);
  });

  it('rejects an unknown surface', () => {
    const bad = { ...valid, journeys: [{ ...valid.journeys[0], surface: 'sideways' }] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/unknown surface "sideways"/);
  });

  it('rejects a journey with neither steps nor a module — it would silently do nothing', () => {
    const bad = { ...valid, journeys: [{ name: 'empty', actor: 'editor', surface: 'admin' }] };
    expect(() => parseManifest(bad, 'f.json'))
      .toThrow(/journey "empty" declares no screens, settings, shortcodes or module/);
  });

  it('rejects duplicate journey names', () => {
    const bad = { ...valid, journeys: [valid.journeys[0], valid.journeys[0]] };
    expect(() => parseManifest(bad, 'f.json')).toThrow(/duplicate journey name/);
  });

  it('rejects a non-object entirely', () => {
    expect(() => parseManifest(null, 'f.json')).toThrow(/f\.json: not a JSON object/);
  });

  it('rejects an EMPTY step list as declaring nothing — [] is not work', () => {
    // `screens: []` is an array, so an "is it an array" check reads it as work. The journey
    // would then visit nothing, assert nothing and report pass.
    expect(() => parseManifest(withJourney({ name: 'empty', actor: 'editor', surface: 'admin', screens: [] }), 'f.json'))
      .toThrow(/journey "empty" declares no screens, settings, shortcodes or module/);
  });

  it('rejects a manifest with no journeys at all', () => {
    expect(() => parseManifest({ ...valid, journeys: [] }, 'f.json')).toThrow(/f\.json: "journeys" must be a non-empty array/);
  });

  it('rejects a module combined with steps — the module would silently replace them', () => {
    const bad = withJourney({ ...valid.journeys[0], module: 'x.ts' });
    expect(() => parseManifest(bad, 'f.json'))
      .toThrow(/journey "acme-settings-round-trip": "module" cannot be combined with screens, settings or shortcodes/);
  });

  describe('unknown keys are refused, naming the key and where it is', () => {
    // A typo — `readback` for `readBack`, `screen` for `screens` — must not be quietly dropped.
    it('at the top level', () => {
      expect(() => parseManifest({ ...valid, gates: {} }, 'f.json')).toThrow(/f\.json: unknown key "gates"/);
    });

    it('on a journey', () => {
      const bad = withJourney({ ...valid.journeys[0], shortcode: ['acme'] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "acme-settings-round-trip": unknown key "shortcode"/);
    });

    it('on a setting', () => {
      const setting = { url: '/wp-admin/admin.php?page=acme', field: '#t', value: 'v', readback: '/' };
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', settings: [setting] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\]: unknown key "readback"/);
    });

    it('on a screen', () => {
      const screen = { url: '/wp-admin/admin.php?page=acme', allow: ['editor'], deny: [], denied: [] };
      const bad = withJourney({ name: 's', actor: 'editor', surface: 'admin', screens: [screen] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": screens\[0\]: unknown key "denied"/);
    });
  });

  describe('screens', () => {
    const screen = (over: Record<string, unknown>) => withJourney({
      name: 's', actor: 'editor', surface: 'admin',
      screens: [{ url: '/wp-admin/admin.php?page=acme', allow: [], deny: ['editor'], ...over }],
    });

    it('accepts a screen that denies the journey actor', () => {
      expect(parseManifest(screen({}), 'f.json').journeys[0]?.screens?.[0]?.deny).toEqual(['editor']);
    });

    it('rejects a screen that names the journey actor in NEITHER list — it would assert nothing', () => {
      // A screen block naming only other actors makes no assertion for this journey, and a
      // journey whose every screen is like that visits nothing and passes.
      expect(() => parseManifest(screen({ deny: ['subscriber'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\] lists its actor "editor" in neither "allow" nor "deny" — it would assert nothing/);
    });

    it('rejects a screen that names the journey actor in BOTH lists', () => {
      expect(() => parseManifest(screen({ allow: ['editor'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\] lists its actor "editor" in both "allow" and "deny"/);
    });

    it('rejects an unknown actor inside allow or deny', () => {
      expect(() => parseManifest(screen({ allow: ['superadmin'] }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.allow: unknown actor "superadmin"/);
    });

    it('rejects a screen without a url', () => {
      expect(() => parseManifest(screen({ url: '' }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.url must be a non-empty string/);
    });

    it('rejects a screen whose allow is not an array', () => {
      expect(() => parseManifest(screen({ allow: 'editor' }), 'f.json'))
        .toThrow(/journey "s": screens\[0\]\.allow must be an array of actors/);
    });
  });

  describe('settings', () => {
    it('rejects a setting missing any of its four fields', () => {
      const bad = withJourney({
        name: 's', actor: 'administrator', surface: 'both',
        settings: [{ url: '/wp-admin/admin.php?page=acme', field: '#t', value: 'v' }],
      });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\]\.readBack must be a non-empty string/);
    });

    it('rejects a setting that is not an object', () => {
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', settings: ['x'] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\] is not an object/);
    });
  });

  describe('shortcodes', () => {
    it('rejects a shortcode that is not a non-empty string', () => {
      const bad = withJourney({ name: 's', actor: 'administrator', surface: 'both', shortcodes: ['acme', ''] });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": shortcodes\[1\] must be a non-empty string/);
    });
  });

  describe('gate', () => {
    it('is optional', () => {
      const { gate: _gate, ...without } = valid;
      expect(parseManifest(without, 'f.json').gate).toBeUndefined();
    });

    it('must carry a non-empty screen slug when present', () => {
      expect(() => parseManifest({ ...valid, gate: { screen: '' } }, 'f.json'))
        .toThrow(/f\.json: "gate\.screen" must be a non-empty string/);
      expect(() => parseManifest({ ...valid, gate: 'acme' }, 'f.json'))
        .toThrow(/f\.json: "gate" must be an object/);
    });

    it('refuses an unknown key', () => {
      expect(() => parseManifest({ ...valid, gate: { screen: 'acme', slug: 'acme' } }, 'f.json'))
        .toThrow(/f\.json: "gate": unknown key "slug"/);
    });
  });

  it('rejects a journey that is not an object, by index', () => {
    expect(() => parseManifest({ ...valid, journeys: ['x'] }, 'f.json')).toThrow(/journeys\[0\] is not an object/);
  });

  it('rejects a journey with no name, by index', () => {
    expect(() => parseManifest(withJourney({ actor: 'editor', surface: 'admin', shortcodes: ['a'] }), 'f.json'))
      .toThrow(/journeys\[0\] has no "name"/);
  });

  it('rejects a non-string plugin', () => {
    expect(() => parseManifest({ ...valid, plugin: '' }, 'f.json')).toThrow(/"plugin" must be a non-empty string/);
  });

  it('rejects an empty module path', () => {
    expect(() => parseManifest(withJourney({ name: 'm', actor: 'editor', surface: 'admin', module: '' }), 'f.json'))
      .toThrow(/journey "m": "module" must be a non-empty string/);
  });
});

describe('interpret', () => {
  it('produces one Journey per manifest entry, preserving name, actor and surface', () => {
    const journeys = interpret(parseManifest(valid, 'f.json'));
    expect(journeys.map((j) => j.name)).toEqual(['acme-settings-round-trip', 'acme-custom']);
    expect(journeys[0]?.actor).toBe('administrator');
    expect(journeys[0]?.surface).toBe('both');
    expect(journeys[1]?.actor).toBe('editor');
  });

  it('produces runnable journeys', () => {
    for (const journey of interpret(parseManifest(valid, 'f.json'))) {
      expect(typeof journey.run).toBe('function');
    }
  });

  it('is pure: a module that does not exist on disk is not touched until run()', () => {
    // `valid` names tests/journeys/acme-custom.ts, which is not on disk. Resolving it at
    // interpret time would make the interpreter do I/O, and fail for a journey nobody ran.
    expect(() => interpret(parseManifest(valid, 'f.json'), '/nowhere')).not.toThrow();
  });

  /** A single-journey manifest, parsed and interpreted, with the fakes to run it against. */
  function arrange(journey: Record<string, unknown>, pluginDir?: string) {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent();
    const [run] = interpret(parseManifest(withJourney(journey), 'f.json'), pluginDir);
    if (!run) throw new Error('interpret produced no journey');
    return { page, browser, agent, calls, run: () => run.run(browser.asBrowser(), CFG, agent) };
  }

  const ADMIN_LANDING = landsOn('https://s.test/wp-admin/');
  const LOGIN_BOUNCE = landsOn('https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F');
  const SCREEN = '/wp-admin/admin.php?page=acme';

  describe('screens', () => {
    const denied = { name: 'd', actor: 'editor', surface: 'admin', screens: [{ url: SCREEN, allow: [], deny: ['editor'] }] };
    const allowed = { name: 'a', actor: 'editor', surface: 'admin', screens: [{ url: SCREEN, allow: ['editor'], deny: [] }] };

    it('passes an expected denial served as the login bounce, after a REAL login', async () => {
      const { page, run } = arrange(denied);
      page.navigations = [ADMIN_LANDING, LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN', SCREEN]);
    });

    it('fails an expected denial that the document actually served', async () => {
      const { page, run } = arrange(denied);
      page.navigations = [ADMIN_LANDING, landsOn(`https://s.test${SCREEN}`)];

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'response', status: 200, text: expect.stringContaining('expected a permission denial') },
      ]);
    });

    it('passes an allowed screen that served, and fails one that bounced to login', async () => {
      const ok = arrange(allowed);
      ok.page.navigations = [ADMIN_LANDING, landsOn(`https://s.test${SCREEN}`)];
      expect((await ok.run()).findings).toEqual([]);

      const bounced = arrange(allowed);
      bounced.page.navigations = [ADMIN_LANDING, LOGIN_BOUNCE];
      expect((await bounced.run()).findings).toMatchObject([
        { kind: 'response', text: expect.stringContaining('the actor is not authenticated') },
      ]);
    });

    it('declares the expectation per visit, so a denial never leaks onto the next screen', async () => {
      // The sentinel's expectation is one-shot. A journey that declared one denial up front
      // and then visited three screens would accept a login bounce on all three.
      const two = {
        name: 't', actor: 'editor', surface: 'admin',
        screens: [
          { url: SCREEN, allow: [], deny: ['editor'] },
          { url: '/wp-admin/edit.php', allow: ['editor'], deny: [] },
        ],
      };
      const { page, run } = arrange(two);
      page.navigations = [ADMIN_LANDING, LOGIN_BOUNCE, LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'response', url: expect.stringContaining('wp-login.php'), text: expect.stringContaining('not authenticated') },
      ]);
      expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN', SCREEN, '/wp-admin/edit.php']);
    });

    it('never satisfies a denial with an ANONYMOUS visitor: a refused login stops the journey', async () => {
      // The binding constraint, traced end to end. A refused token leaves the page on the mint
      // URL with a 200; the body would then visit the screen logged out and WordPress's login
      // bounce would satisfy the denial for entirely the wrong reason.
      const { page, run } = arrange(denied);
      page.navigations = [landsOn('https://s.test/?wpj_login=TOKEN'), LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings.at(-1)).toMatchObject({
        kind: 'assertion', text: expect.stringContaining('could not authenticate as editor'),
      });
      expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN']);
    });

    it('lets an anonymous journey assert a denial with no login at all', async () => {
      const anonymous = { name: 'n', actor: 'anonymous', surface: 'admin', screens: [{ url: SCREEN, allow: [], deny: ['anonymous'] }] };
      const { page, run, calls } = arrange(anonymous);
      page.navigations = [LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(calls.filter((c) => c.startsWith('mintLogin'))).toEqual([]);
    });
  });

  describe('settings', () => {
    const setting = { url: SCREEN, field: '#acme_title', value: 'Hello from wp-journeys', readBack: '/' };
    const journey = { name: 's', actor: 'administrator', surface: 'both', settings: [setting] };

    it('writes the field, submits once, and passes when the value reads back on the frontend', async () => {
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING];
      page.body = '<html><body><h1>Hello from wp-journeys</h1></body></html>';

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(result.entitiesCreated).toBe(1);
      expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN', SCREEN, '/']);
      expect(page.fills).toEqual([['#acme_title', 'Hello from wp-journeys']]);
      expect(page.keys).toEqual(['Enter']);
    });

    it('fails when the save answered cleanly but the value never reached the read-back URL', async () => {
      // A validation or capability failure redirects back to the form with a 2xx. Only the
      // read-back can tell that from success.
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING];

      const result = await run();

      expect(result.findings).toMatchObject([{
        kind: 'assertion',
        text: expect.stringContaining('read-back failed for "s": wrote "Hello from wp-journeys" to #acme_title'),
      }]);
      expect(result.findings[0]?.text).toContain('never appeared at /');
    });
  });

  describe('shortcodes', () => {
    const journey = { name: 'r', actor: 'administrator', surface: 'both', shortcodes: ['acme'] };

    it('renders through the agent and passes when the marker is present and the tag expanded', async () => {
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING];
      page.body = '<div data-wpj-render="1"><p>expanded</p></div>';

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN', '/?wpj_render=%5Bacme%5D']);
    });

    it('fails when the render marker is absent — the endpoint never ran, so nothing was asserted', async () => {
      // A refused guard serves the ordinary home page with a 200 (R5).
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING];
      page.body = '<html><body>home</body></html>';

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'assertion', text: expect.stringContaining('rendering [acme] produced no wp-journeys render marker') },
      ]);
    });

    it('fails when the tag came back verbatim — it never expanded', async () => {
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING];
      page.body = '<div data-wpj-render="1">[acme]</div>';

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'assertion', text: expect.stringContaining('the shortcode [acme] came back verbatim') },
      ]);
    });
  });

  describe('module (the TypeScript escape hatch)', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));

    it('delegates run() to the module default export, resolved against the plugin directory (R8)', async () => {
      const { run } = arrange(
        { name: 'echo', actor: 'editor', surface: 'admin', module: 'tests/fixtures/journeys/echo.ts' }, repo,
      );

      const result = await run();

      expect(result.findings).toEqual([{ kind: 'assertion', text: 'echo module ran' }]);
    });

    it('fails by name when the module cannot be loaded', async () => {
      const { run } = arrange({ name: 'gone', actor: 'editor', surface: 'admin', module: 'tests/fixtures/journeys/gone.ts' }, repo);

      await expect(run()).rejects.toThrow(/journey "gone": could not load module "tests\/fixtures\/journeys\/gone\.ts"/);
    });

    it('fails when the module default export is not a Journey', async () => {
      const { run } = arrange({ name: 'plain', actor: 'editor', surface: 'admin', module: 'tests/helpers/fakes.ts' }, repo);

      await expect(run()).rejects.toThrow(/journey "plain": module "tests\/helpers\/fakes\.ts" does not default-export a Journey/);
    });
  });
});

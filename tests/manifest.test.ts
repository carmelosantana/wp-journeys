import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errors } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTROL_SCREEN } from '../src/journeys/support.ts';
import { interpret } from '../src/manifest/interpret.ts';
import { loadManifest } from '../src/manifest/load.ts';
import { parseManifest } from '../src/manifest/schema.ts';
import { CFG, FakeBrowser, FakePage, fakeAgent, landsOn, response } from './helpers/fakes.ts';

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

  it('rejects a module combined with an EMPTY step list too — the rule is about the keys, not the count', () => {
    const bad = withJourney({ name: 'm', actor: 'editor', surface: 'admin', module: 'x.ts', screens: [] });
    expect(() => parseManifest(bad, 'f.json'))
      .toThrow(/journey "m": "module" cannot be combined with screens, settings or shortcodes/);
  });

  it('accepts "$schema" and "description" at the top level', () => {
    // Editors want `$schema` for completion, and JSON has no comments — these are the one
    // place the strictness would refuse a legitimate manifest.
    const annotated = { $schema: 'https://example.test/wp-journeys.schema.json', description: 'Acme journeys', ...valid };
    expect(parseManifest(annotated, 'f.json').plugin).toBe('acme');
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

    it('accepts an optional submit selector (first contact: Enter cannot submit a <textarea>)', () => {
      const manifest = parseManifest(withJourney({
        name: 's', actor: 'administrator', surface: 'both',
        settings: [{ url: '/wp-admin/x', field: '#t', value: 'v', readBack: '/', submit: '#submit' }],
      }), 'f.json');
      expect(manifest.journeys[0]?.settings?.[0]?.submit).toBe('#submit');
    });

    it('rejects an empty submit selector rather than falling back to Enter', () => {
      const bad = withJourney({
        name: 's', actor: 'administrator', surface: 'both',
        settings: [{ url: '/wp-admin/x', field: '#t', value: 'v', readBack: '/', submit: '' }],
      });
      expect(() => parseManifest(bad, 'f.json')).toThrow(/journey "s": settings\[0\]\.submit must be a non-empty string/);
    });

    it('leaves submit absent when the author did not write one', () => {
      const manifest = parseManifest(withJourney({
        name: 's', actor: 'administrator', surface: 'both',
        settings: [{ url: '/wp-admin/x', field: '#t', value: 'v', readBack: '/' }],
      }), 'f.json');
      expect(manifest.journeys[0]?.settings?.[0]).not.toHaveProperty('submit');
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
    const journeys = interpret(parseManifest(valid, 'f.json'), '/nowhere');
    expect(journeys.map((j) => j.name)).toEqual(['acme-settings-round-trip', 'acme-custom']);
    expect(journeys[0]?.actor).toBe('administrator');
    expect(journeys[0]?.surface).toBe('both');
    expect(journeys[1]?.actor).toBe('editor');
  });

  it('produces runnable journeys', () => {
    for (const journey of interpret(parseManifest(valid, 'f.json'), '/nowhere')) {
      expect(typeof journey.run).toBe('function');
    }
  });

  it('is pure: a module that does not exist on disk is not touched until run()', () => {
    // `valid` names tests/journeys/acme-custom.ts, which is not on disk. Resolving it at
    // interpret time would make the interpreter do I/O, and fail for a journey nobody ran.
    expect(() => interpret(parseManifest(valid, 'f.json'), '/nowhere')).not.toThrow();
  });

  /** A single-journey manifest, parsed and interpreted, with the fakes to run it against. */
  function arrange(journey: Record<string, unknown>, manifestDir = '/nowhere', nonce?: () => string) {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent();
    const [run] = interpret(parseManifest(withJourney(journey), 'f.json'), manifestDir, nonce);
    if (!run) throw new Error('interpret produced no journey');
    return { page, browser, agent, calls, run: () => run.run(browser.asBrowser(), CFG, agent) };
  }

  const ADMIN_LANDING = landsOn('https://s.test/wp-admin/');
  /** The control visit's answer (R67): profile.php served, which only a real session gets. */
  const CONTROL = landsOn(`https://s.test${CONTROL_SCREEN}`);
  const MINT = 'https://s.test/?wpj_login=TOKEN';
  const LOGIN_BOUNCE = landsOn('https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F');
  const SCREEN = '/wp-admin/admin.php?page=acme';

  describe('screens', () => {
    const denied = { name: 'd', actor: 'editor', surface: 'admin', screens: [{ url: SCREEN, allow: [], deny: ['editor'] }] };
    const allowed = { name: 'a', actor: 'editor', surface: 'admin', screens: [{ url: SCREEN, allow: ['editor'], deny: [] }] };

    it('passes an expected denial served as the login bounce, after a REAL login', async () => {
      const { page, run } = arrange(denied);
      page.navigations = [ADMIN_LANDING, CONTROL, LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, SCREEN]);
    });

    it('fails an expected denial that the document actually served', async () => {
      const { page, run } = arrange(denied);
      page.navigations = [ADMIN_LANDING, CONTROL, landsOn(`https://s.test${SCREEN}`)];

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'response', status: 200, text: expect.stringContaining('expected a permission denial') },
      ]);
    });

    it('passes an allowed screen that served, and fails one that bounced to login', async () => {
      const ok = arrange(allowed);
      ok.page.navigations = [ADMIN_LANDING, CONTROL, landsOn(`https://s.test${SCREEN}`)];
      expect((await ok.run()).findings).toEqual([]);

      const bounced = arrange(allowed);
      bounced.page.navigations = [ADMIN_LANDING, CONTROL, LOGIN_BOUNCE];
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
      page.navigations = [ADMIN_LANDING, CONTROL, LOGIN_BOUNCE, LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'response', url: expect.stringContaining('wp-login.php'), text: expect.stringContaining('not authenticated') },
      ]);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, SCREEN, '/wp-admin/edit.php']);
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
      expect(page.gotos).toEqual([MINT]);
    });

    it('never lets a deny-only journey pass while the run is ANONYMOUS: the control visit catches a sessionless mint (R67)', async () => {
      // runAsActor's guards catch a mint that bounces to login or that never leaves the token
      // URL. They cannot catch a mint that redirects AWAY to an ordinary 200 page without
      // establishing a session: the verdict is empty, the token is gone, and the body runs
      // logged out. Every deny screen is then satisfied by WordPress's login bounce, and the
      // shipped example's second journey is exactly this shape. One screen asserted as ALLOWED,
      // which only a real session can reach, makes that impossible.
      const { page, run } = arrange(denied);
      page.navigations = [landsOn('https://s.test/'), LOGIN_BOUNCE, LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'response', url: expect.stringContaining('wp-login.php'), text: expect.stringContaining('not authenticated') },
      ]);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, SCREEN]);
    });

    it('lets an anonymous journey assert a denial with no login and no control visit', async () => {
      // Anonymous has no session to prove, so a control visit would only ever bounce to login.
      const anonymous = { name: 'n', actor: 'anonymous', surface: 'admin', screens: [{ url: SCREEN, allow: [], deny: ['anonymous'] }] };
      const { page, run, calls } = arrange(anonymous);
      page.navigations = [LOGIN_BOUNCE];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.gotos).toEqual([SCREEN]);
      expect(calls.filter((c) => c.startsWith('mintLogin'))).toEqual([]);
    });
  });

  describe('settings', () => {
    const setting = { url: SCREEN, field: '#acme_title', value: 'Hello from wp-journeys', readBack: '/' };
    const journey = { name: 's', actor: 'administrator', surface: 'both', settings: [setting] };
    const nonce = () => 'wpj-fixed';
    const WRITTEN = 'Hello from wp-journeys wpj-fixed';

    it('writes the value plus a nonce, submits once, and passes only when the visible text CHANGED (R66)', async () => {
      // Absent before the write, present after: change detection. A state check alone passes
      // on every run after the first, whether or not the submit still works.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [
        ADMIN_LANDING, CONTROL,
        landsOn('https://s.test/'), landsOn(`https://s.test${SCREEN}`),
        (url) => { page.text = `Site title: ${WRITTEN}`; return response(200, url); },
      ];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(result.entitiesCreated).toBe(0);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, '/', SCREEN, '/']);
      expect(page.fills).toEqual([['#acme_title', WRITTEN]]);
      expect(page.keys).toEqual(['Enter']);
    });

    it('clicks the declared submit control ONCE instead of pressing Enter', async () => {
      const { page, run } = arrange(
        { ...journey, settings: [{ ...setting, submit: '#submit' }] }, undefined, nonce,
      );
      page.navigations = [
        ADMIN_LANDING, CONTROL,
        landsOn('https://s.test/'), landsOn(`https://s.test${SCREEN}`),
        (url) => { page.text = `Site title: ${WRITTEN}`; return response(200, url); },
      ];

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.clicks).toEqual(['#submit']);
      expect(page.keys).toEqual([]);
    });

    it('names the declared submit control, not Enter, when the value never reached the read-back', async () => {
      const { page, run } = arrange(
        { ...journey, settings: [{ ...setting, submit: '#submit' }] }, undefined, nonce,
      );
      page.navigations = [ADMIN_LANDING, CONTROL];

      const result = await run();

      expect(result.findings[0]?.text).toContain('clicking #submit');
      expect(result.findings[0]?.text).not.toContain('Enter submits');
    });

    it('fails when the save answered cleanly but the value never reached the read-back URL', async () => {
      // A validation or capability failure redirects back to the form with a 2xx; so does a
      // submit that never happened. Only the read-back can tell either from success.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [ADMIN_LANDING, CONTROL];

      const result = await run();

      expect(result.findings).toMatchObject([{
        kind: 'assertion',
        text: expect.stringContaining(`read-back failed for "s": wrote ${JSON.stringify(WRITTEN)} to #acme_title`),
      }]);
      expect(result.findings[0]?.text).toContain('never appeared at /');
      expect(result.findings[0]?.text).toContain('Enter');
    });

    it('fails, without writing, when what it is about to write is ALREADY visible (R66)', async () => {
      // Nothing can then be proven by its appearance afterwards — and a matcher that finds
      // everything would show up here first.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.text = `already: ${WRITTEN}`;

      const result = await run();

      expect(result.findings).toMatchObject([{
        kind: 'assertion',
        text: expect.stringContaining(`${JSON.stringify(WRITTEN)} was already visible at / before it was written`),
      }]);
      expect(page.fills).toEqual([]);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, '/']);
    });

    it('matches the visible text, not the HTML source (R66)', async () => {
      // Class names, script bodies, comments and head metadata are not the setting. A value in
      // the source but not the rendered text must not read back.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.body = `<html><head><title>${WRITTEN}</title></head><body><!-- ${WRITTEN} --><p>ok</p></body></html>`;

      const result = await run();

      expect(result.findings).toMatchObject([{ kind: 'assertion', text: expect.stringContaining('read-back failed') }]);
    });

    it('reads back through a theme that upper-cases the rendered text (R68a)', async () => {
      // innerText is RENDERED text: `text-transform: uppercase` on a title or heading returns
      // the value in a case that was never written. That is styling, not a failed save.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [
        ADMIN_LANDING, CONTROL, landsOn('https://s.test/'), landsOn(`https://s.test${SCREEN}`),
        (url) => { page.text = `SITE TITLE: ${WRITTEN.toUpperCase()}`; return response(200, url); },
      ];

      const result = await run();

      expect(result.findings).toEqual([]);
    });

    it('reads back a value the rendered text wraps across a line break (R68a)', async () => {
      // innerText inserts a newline where the rendered text wraps; a value straddling that
      // wrap is still the value.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [
        ADMIN_LANDING, CONTROL, landsOn('https://s.test/'), landsOn(`https://s.test${SCREEN}`),
        (url) => { page.text = 'Site title:\n  Hello from\nwp-journeys   wpj-fixed\n'; return response(200, url); },
      ];

      const result = await run();

      expect(result.findings).toEqual([]);
    });

    it('names the journey and the readBack URL when the page served no HTML body, with a short timeout (R68b)', async () => {
      // A feed, a REST route or anything XML/JSON has no <body>: the locator would wait out
      // Playwright's 30s default and then fail with a message about a locator, naming neither
      // the read-back nor the URL.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.textError = new errors.TimeoutError('locator.innerText: Timeout 5000ms exceeded.');

      const result = await run();

      expect(result.findings).toMatchObject([{
        kind: 'assertion',
        text: expect.stringContaining('journey "s": the read-back page / served no HTML body'),
      }]);
      expect(result.findings[0]?.text).toContain('a readBack must be an HTML page');
      expect(page.innerTextCalls).toHaveLength(1);
      expect(page.innerTextCalls[0]?.timeout).toBeGreaterThan(0);
      expect(page.innerTextCalls[0]?.timeout).toBeLessThanOrEqual(5_000);
    });

    it('does not call a page bodiless when reading it failed for another reason (T13 parked minor)', async () => {
      // A closed page, a crashed target, a navigation mid-read: none of them is a page without a
      // <body>, and saying so sends the operator after the wrong readBack URL.
      const { page, run } = arrange(journey, undefined, nonce);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.textError = new Error('locator.innerText: Target page, context or browser has been closed');

      const result = await run();

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.text).toContain('journey "s": could not read the visible text of the read-back page /');
      expect(result.findings[0]?.text).toContain('Target page, context or browser has been closed');
      expect(result.findings[0]?.text).not.toContain('no HTML body');
    });

    it('draws a fresh nonce for every write by default, so no earlier write can satisfy a later read-back', async () => {
      const two = {
        name: 'two', actor: 'administrator', surface: 'both',
        settings: [setting, { ...setting, field: '#acme_tagline' }],
      };
      const { page, run } = arrange(two);
      // The frontend shows everything written so far, like a real site.
      const persist = (url: string) => { page.text = page.fills.map(([, value]) => value).join(' '); return response(200, url); };
      page.navigations = [ADMIN_LANDING, CONTROL, persist, persist, persist, persist, persist, persist];

      const result = await run();

      expect(result.findings).toEqual([]);
      const written = page.fills.map(([, value]) => value);
      expect(written).toHaveLength(2);
      expect(written[0]).toMatch(/^Hello from wp-journeys wpj-[0-9a-f]{8}$/);
      expect(written[1]).toMatch(/^Hello from wp-journeys wpj-[0-9a-f]{8}$/);
      expect(written[0]).not.toBe(written[1]);
    });
  });

  describe('shortcodes', () => {
    const journey = { name: 'r', actor: 'administrator', surface: 'both', shortcodes: ['acme'] };

    it('renders through the agent and passes when the marker is present and the tag expanded', async () => {
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.body = '<div data-wpj-render="1" data-wpj-expanded="1"><p>expanded</p></div>';

      const result = await run();

      expect(result.findings).toEqual([]);
      expect(page.gotos).toEqual([MINT, CONTROL_SCREEN, '/?wpj_render=%5Bacme%5D']);
    });

    it('fails when the render marker is absent — the endpoint never ran, so nothing was asserted', async () => {
      // A refused guard serves the ordinary home page with a 200 (R5).
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.body = '<html><body>home</body></html>';

      const result = await run();

      expect(result.findings).toMatchObject([
        { kind: 'assertion', text: expect.stringContaining('rendering [acme] produced no wp-journeys render marker') },
      ]);
    });

    it('fails when the tag came back verbatim — it never expanded', async () => {
      const { page, run } = arrange(journey);
      page.navigations = [ADMIN_LANDING, CONTROL];
      page.body = '<div data-wpj-render="1" data-wpj-expanded="0">[acme]</div>';

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

    it('reports the result under the MANIFEST identity, validated, not the module\'s own', async () => {
      // The summary lists what the manifest named. echo.ts calls itself "echo"/administrator/both;
      // the entry says otherwise, and the entry wins. Its findings and count are the module's.
      const { run } = arrange({ name: 'custom', actor: 'editor', surface: 'admin', module: 'tests/fixtures/journeys/echo.ts' }, repo);

      const result = await run();

      expect(result).toEqual({
        name: 'custom', actor: 'editor', surface: 'admin', entitiesCreated: 3,
        findings: [{ kind: 'assertion', text: 'echo module ran' }],
      });
    });

    it('fails by name when the module result is not a JourneyResult, instead of reaching outcomeOf', async () => {
      const { run } = arrange({ name: 'bad', actor: 'editor', surface: 'admin', module: 'tests/fixtures/journeys/malformed.ts' }, repo);

      await expect(run()).rejects.toThrow(/journey "bad": module "tests\/fixtures\/journeys\/malformed\.ts" returned something that is not a JourneyResult/);
    });

    it('refuses a module path that resolves outside the plugin directory', async () => {
      // A manifest is data from the plugin under test. The hatch runs author code by design,
      // but only the author's own: not ../ into a sibling checkout, not an absolute path.
      for (const module of ['../outside.ts', '/etc/hostname', 'tests/../../outside.ts']) {
        const { run } = arrange({ name: 'esc', actor: 'editor', surface: 'admin', module }, repo);
        await expect(run()).rejects.toThrow(/journey "esc": module ".*" resolves outside the manifest directory/);
      }
    });

    it('wraps a throw from inside the module run() with the journey name and module path, keeping the cause (R68d)', async () => {
      // Third-party code: without the wrap the operator gets a stack from a file they have to
      // go and find, with neither the journey nor the module named.
      const { run } = arrange({ name: 'boom', actor: 'editor', surface: 'admin', module: 'tests/fixtures/journeys/throws.ts' }, repo);

      const error = await run().then(() => null, (thrown: unknown) => thrown as Error & { cause?: unknown });

      expect(error?.message).toMatch(/^journey "boom": module "tests\/fixtures\/journeys\/throws\.ts" threw — module exploded/);
      expect(error?.cause).toBeInstanceOf(Error);
      expect((error?.cause as Error).message).toBe('module exploded');
    });

    it('fails when the module default export is not a Journey', async () => {
      const { run } = arrange({ name: 'plain', actor: 'editor', surface: 'admin', module: 'tests/helpers/fakes.ts' }, repo);

      await expect(run()).rejects.toThrow(/journey "plain": module "tests\/helpers\/fakes\.ts" does not default-export a Journey/);
    });
  });
});

describe('loadManifest', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function pluginDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wpj-manifest-'));
    dirs.push(dir);
    return dir;
  }

  it('returns null when the plugin has no manifest — the zero-authoring case', async () => {
    expect(await loadManifest(await pluginDir())).toBeNull();
  });

  it('parses a manifest that is present', async () => {
    const dir = await pluginDir();
    await writeFile(join(dir, 'wp-journeys.json'), JSON.stringify(valid));

    const manifest = await loadManifest(dir);

    expect(manifest?.plugin).toBe('acme');
    expect(manifest?.journeys.map((j) => j.name)).toEqual(['acme-settings-round-trip', 'acme-custom']);
  });

  it('throws, naming the file, on invalid JSON — never null', async () => {
    const dir = await pluginDir();
    await writeFile(join(dir, 'wp-journeys.json'), '{ "version": 1, ');

    await expect(loadManifest(dir)).rejects.toThrow(new RegExp(`^${join(dir, 'wp-journeys.json')}: invalid JSON — `));
  });

  it('throws, naming the file, on a manifest that does not validate', async () => {
    const dir = await pluginDir();
    await writeFile(join(dir, 'wp-journeys.json'), JSON.stringify({ ...valid, version: 2 }));

    await expect(loadManifest(dir)).rejects.toThrow(`${join(dir, 'wp-journeys.json')}: "version" must be 1`);
  });

  it('throws when the manifest directory itself does not exist — that is not "no manifest"', async () => {
    // readFile answers ENOENT for a missing directory exactly as for a missing file, and a
    // mistyped plugin path would otherwise run the core suite against nothing, silently.
    const dir = join(await pluginDir(), 'missing');

    await expect(loadManifest(dir)).rejects.toThrow(`${dir}: manifest directory does not exist`);
  });

  it('throws when the manifest exists but cannot be read — only ENOENT is "absent"', async () => {
    // A directory named wp-journeys.json, or a file without read permission, is not the same
    // as no manifest: the author wrote one, and returning null would run none of it, silently.
    const dir = await pluginDir();
    await mkdir(join(dir, 'wp-journeys.json'));

    await expect(loadManifest(dir)).rejects.toThrow(`${join(dir, 'wp-journeys.json')}: could not be read`);
  });
});

describe('assets/wp-journeys.example.json', () => {
  it('is a manifest the schema accepts, so the shipped example cannot drift from it', async () => {
    const file = fileURLToPath(new URL('../assets/wp-journeys.example.json', import.meta.url));
    const manifest = parseManifest(JSON.parse(await readFile(file, 'utf8')), file);

    expect(interpret(manifest, '/nowhere').map((j) => `${j.name}:${j.actor}:${j.surface}`)).toEqual([
      'acme-settings-round-trip:administrator:both',
      'acme-editor-is-denied:editor:admin',
    ]);
  });
});

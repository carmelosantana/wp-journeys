/**
 * The lifecycle helper's contract, exercised against the REAL sentinel.
 *
 * Only the browser and the agent are faked: the sentinel is what decides whether a journey is
 * clean, so a test that stubbed it would prove nothing about the thing being wired up here.
 */
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import { runAsActor } from '../src/journeys/support.ts';
import type { Sentinel } from '../src/sentinel/sentinel.ts';
import { CFG, CLEAN, FakeBrowser, FakePage, fakeAgent, landsOn, response } from './helpers/fakes.ts';

describe('runAsActor', () => {
  it('runs an anonymous journey with no provisioning and no login', async () => {
    // The one actor with no login is the path a lifecycle helper that assumes one breaks.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent();

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'frontend-renders', Actor.ANONYMOUS, 'frontend',
      async (target, sentinel) => {
        await sentinel.visit(target, '/');
        return 0;
      },
    );

    expect(result).toEqual({
      name: 'frontend-renders', actor: Actor.ANONYMOUS, surface: 'frontend',
      entitiesCreated: 0, findings: [],
    });
    expect(page.gotos).toEqual(['/']);
    expect(calls.filter((c) => c.startsWith('ensureActor') || c.startsWith('mintLogin'))).toEqual([]);
    expect(browser.closed).toEqual([true]);
  });

  it('never lets a login token reach the result when the mint navigation itself throws', async () => {
    // Playwright quotes the URL it could not load, and at the login step that URL IS the token.
    const page = new FakePage();
    page.navigations = [(url) => { throw new Error(`page.goto: net::ERR_UNSAFE_PORT at ${url}`); }];
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent({ mintLogin: async () => ({ url: 'http://s.test:6000/?wpj_login=SECRETTOKENabc' }) });

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin', async () => 0,
    );

    expect(JSON.stringify(result)).not.toContain('SECRETTOKEN');
    expect(JSON.stringify(result)).toContain('could not authenticate as editor');
    expect(JSON.stringify(result)).toContain('ERR_UNSAFE_PORT');
  });

  it('fails a journey whose page threw an uncaught JavaScript error', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'frontend-renders', Actor.ANONYMOUS, 'frontend',
      async (target, sentinel) => {
        await sentinel.visit(target, '/');
        page.throwUncaught('undefinedPluginGlobal is not defined', 'ReferenceError');
        return 0;
      },
    );

    expect(result.findings).toMatchObject([
      { kind: 'pageerror', text: expect.stringContaining('ReferenceError: undefinedPluginGlobal is not defined') },
    ]);
  });

  it('authenticates a user-backed actor with the id ensureActor returned, before the body', async () => {
    // mintLogin refuses any user the runner did not create, so the id MUST come from
    // ensureActor — a hardcoded or real-site id is refused by design (R36).
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent({ ensureActor: async () => ({ userId: 7 }) });
    // The mint 302s into wp-admin; that landing is what says the session was established.
    page.navigations = [landsOn('https://s.test/wp-admin/')];

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async (target, sentinel) => {
        await sentinel.visit(target, '/wp-admin/');
        return 3;
      },
    );

    expect(calls).toContain('ensureActor("editor")');
    expect(calls).toContain('mintLogin(7)');
    expect(page.gotos).toEqual(['https://s.test/?wpj_login=TOKEN', '/wp-admin/']);
    expect(result.findings).toEqual([]);
    expect(result.entitiesCreated).toBe(3);
  });

  it('visits the minted URL THROUGH the sentinel, so a broken login is a finding', async () => {
    // A mint that lands on wp-login.php means the session was never established. Without the
    // sentinel on that navigation the journey would fail three steps later, for no clear reason.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [() => response(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F')];

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async () => 0,
    );

    expect(result.findings).toMatchObject([
      { kind: 'response', text: expect.stringContaining('the actor is not authenticated') },
      { kind: 'assertion', text: expect.stringContaining('could not authenticate as editor') },
    ]);
  });

  it('skips the body when the minted login never reached wp-admin (R50)', async () => {
    // sentinel.visit RECORDS a bad landing and returns normally — it does not throw. So without
    // an explicit check the body runs as an ANONYMOUS visitor under the named actor's label, and
    // for a denial journey an unauthenticated body satisfies the expected denial for entirely
    // the wrong reason.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [landsOn('https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F')];
    let bodyRan = false;

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(false);
    expect(result.findings.at(-1)).toMatchObject({
      kind: 'assertion', text: expect.stringContaining('could not authenticate as editor'),
    });
  });

  it('runs the body when a VALID session landed somewhere other than wp-admin (R52)', async () => {
    // Real sites bounce low-privilege roles straight back out of wp-admin — WooCommerce's
    // wc_prevent_admin_access sends a subscriber to My Account, and hiding the dashboard from
    // non-admins is a common pattern. The session is real; only the landing is elsewhere.
    // Reading that as a failed login skips the body and reports a false red, and the denial
    // journeys this suite is built on are exactly where it bites.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [landsOn('https://s.test/my-account/')];
    let bodyRan = false;

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.SUBSCRIBER, 'admin',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('skips the body when the token was REFUSED and the page never left the mint URL (R54)', async () => {
    // wpj_consume_login returns silently on a malformed, unknown, expired or already-spent
    // token. WordPress then renders the ordinary home page AT the token URL with HTTP 200 —
    // not a login page, not a 5xx, so no classifier reports it. The body would then sweep as an
    // ANONYMOUS visitor, and for subscriber, contributor, author and editor every screen
    // expects a denial, which a logged-out visitor satisfies through the login redirect. All
    // four would report `pass` having asserted nothing about permissions at all.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [landsOn('https://s.test/?wpj_login=TOKEN')];
    let bodyRan = false;

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.SUBSCRIBER, 'admin',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(false);
    expect(result.findings.at(-1)).toMatchObject({
      kind: 'assertion', text: expect.stringContaining('could not authenticate as subscriber'),
    });
    // The landing IS the token URL, so a finding built from it must still be redacted (R51).
    expect(JSON.stringify(result.findings)).not.toContain('TOKEN');
  });

  it('skips the body when the mint itself failed to serve, not only when it bounced to login', async () => {
    // A 502 on the mint URL leaves the page ON the mint URL: not the login page, and not a
    // session either. Checking only for wp-login.php would let the body run unauthenticated.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();
    page.navigations = [() => response(502, 'https://s.test/?wpj_login=TOKEN')];
    let bodyRan = false;

    await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(false);
  });

  it('never lets a minted login token reach a finding (R51)', async () => {
    // Findings go into JourneyResult, the run summary, and whatever CI keeps. A live token in
    // there is a credential that outlives the run.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent({
      mintLogin: async () => ({ url: 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd' }),
    });
    page.navigations = [() => response(502, 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd')];

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async () => 0,
    );

    const serialised = JSON.stringify(result.findings);
    expect(serialised).not.toContain('SECRETTOKEN');
    expect(serialised).toContain('wpj_login=<REDACTED>');
  });

  it('carries what the body noted onto the result, even when the body then throws', async () => {
    // A note is how a row SAYS what it did not check (R74, R75, R78) — losing it on a throw
    // would hide that exactly when the row is being read most closely.
    const page = new FakePage();
    const { agent } = fakeAgent();

    const result = await runAsActor(
      new FakeBrowser(page).asBrowser(), CFG, agent, 'noted', Actor.ANONYMOUS, 'frontend',
      async (_target, _sentinel, note) => {
        note('first');
        note('second');
        throw new Error('then it broke');
      },
    );

    expect(result.notes).toEqual(['first', 'second']);
    expect(result.findings).toEqual([{ kind: 'assertion', text: 'then it broke' }]);
  });

  it('records a thrown body as an assertion finding rather than aborting the run', async () => {
    // One failing journey must never take the rest of the run down with it (R3).
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'lifecycle', Actor.ANONYMOUS, 'admin',
      async () => {
        throw new Error('acme left state behind after uninstall: options=acme_version');
      },
    );

    expect(result.findings).toEqual([
      { kind: 'assertion', text: 'acme left state behind after uninstall: options=acme_version' },
    ]);
    expect(browser.closed).toEqual([true]);
  });

  it('still drains the sentinel when the body throws, so what it saw is not lost', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'lifecycle', Actor.ANONYMOUS, 'admin',
      async (target, sentinel) => {
        page.emit('response', response(500, 'https://s.test/wp-admin/admin-ajax.php'));
        await sentinel.visit(target, '/wp-admin/');
        throw new Error('the screen never rendered');
      },
    );

    expect(result.findings.map((f) => f.kind)).toEqual(['response', 'assertion']);
  });

  it('records a failed login as a finding naming the actor, and never runs the body', async () => {
    // A login that failed must be loud. Running the body anyway would report an anonymous
    // visitor's denials as the editor's, which is a false result rather than a lost one.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent({
      mintLogin: async () => { throw new Error('agent returned HTTP 403 for "mintLogin"'); },
    });
    let bodyRan = false;

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'admin-sweep', Actor.EDITOR, 'admin',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(false);
    expect(result.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringContaining('could not authenticate as editor') },
    ]);
    expect(browser.closed).toEqual([true]);
  });

  it('installs a fresh sentinel per journey, so one journey cannot dedupe away another’s 5xx', async () => {
    // drain() de-duplicates over the sentinel's LIFETIME on status + url. A sentinel shared by
    // two journeys therefore drops the second journey's genuine 5xx on a URL the first already
    // reported — a false green, which is exactly what R44 makes structurally impossible.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent, calls } = fakeAgent();
    const body = async (target: Page, sentinel: Sentinel) => {
      await sentinel.visit(target, '/wp-admin/');
      return 0;
    };
    page.navigations = [
      () => response(502, 'https://s.test/wp-admin/'),
      () => response(502, 'https://s.test/wp-admin/'),
    ];

    const first = await runAsActor(browser.asBrowser(), CFG, agent, 'a', Actor.ANONYMOUS, 'admin', body);
    const second = await runAsActor(browser.asBrowser(), CFG, agent, 'b', Actor.ANONYMOUS, 'admin', body);

    expect(first.findings).toMatchObject([{ kind: 'response', status: 502 }]);
    expect(second.findings).toMatchObject([{ kind: 'response', status: 502 }]);
    // Two baselines means two sentinels; one would baseline once.
    expect(calls.filter((c) => c === 'logDelta("end")')).toHaveLength(2);
  });

  it('reports a sentinel that could not be drained, instead of an empty finding list', async () => {
    // An undrainable sentinel is a LOST signal. Returning [] would render as ok.
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    let first = true;
    const { agent } = fakeAgent({
      logDelta: async () => {
        if (first) { first = false; return CLEAN; }
        throw new Error('agent unreachable');
      },
    });

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'frontend-renders', Actor.ANONYMOUS, 'frontend',
      async () => 0,
    );

    expect(result.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringContaining('could not be drained') },
    ]);
    expect(browser.closed).toEqual([true]);
  });

  it('reports a sentinel that could not be installed at all', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent({
      logDelta: async () => { throw new Error('agent unreachable'); },
    });
    let bodyRan = false;

    const result = await runAsActor(
      browser.asBrowser(), CFG, agent, 'frontend-renders', Actor.ANONYMOUS, 'frontend',
      async () => { bodyRan = true; return 0; },
    );

    expect(bodyRan).toBe(false);
    expect(result.findings).toMatchObject([
      { kind: 'assertion', text: expect.stringContaining('agent unreachable') },
    ]);
    expect(browser.closed).toEqual([true]);
  });

  it('gives each journey an isolated context bound to the configured base URL', async () => {
    const page = new FakePage();
    const browser = new FakeBrowser(page);
    const { agent } = fakeAgent();

    await runAsActor(browser.asBrowser(), CFG, agent, 'a', Actor.ANONYMOUS, 'frontend', async () => 0);

    expect(browser.options).toEqual([{ baseURL: CFG.baseUrl, ignoreHTTPSErrors: true }]);
  });
});

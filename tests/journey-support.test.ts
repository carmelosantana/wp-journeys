/**
 * The lifecycle helper's contract, exercised against the REAL sentinel.
 *
 * Only the browser and the agent are faked: the sentinel is what decides whether a journey is
 * clean, so a test that stubbed it would prove nothing about the thing being wired up here.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { Actor } from '../src/actors/roles.ts';
import type { AgentClient, LogDelta } from '../src/agent/client.ts';
import type { Config } from '../src/config.ts';
import { runAsActor } from '../src/journeys/support.ts';

const CFG: Config = { baseUrl: 'https://s.test/', secret: 'x'.repeat(16) };

/** A response as the sentinel reads one: status and final URL, both synchronous. */
function response(status: number, url: string): never {
  return { status: () => status, url: () => url } as never;
}

/** A navigation that settles on `url`: the mint 302s into wp-admin, so that is its landing. */
function landsOn(url: string): () => never {
  return () => response(200, url);
}

/** The slice of Playwright's Page the sentinel and the helper touch. */
class FakePage {
  readonly gotos: string[] = [];
  /** What each successive goto does; a 200 on the requested URL once the queue runs out. */
  navigations: Array<(url: string) => unknown> = [];
  body = '<html><body>ok</body></html>';
  private readonly handlers: Record<string, Array<(arg: never) => unknown>> = {};

  on(event: string, handler: (arg: never) => unknown): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers[event] ?? []) void handler(arg as never);
  }

  /** Where the page SETTLED, after redirects — how a login that failed becomes visible. */
  current = 'https://s.test/';

  async goto(url: string): Promise<unknown> {
    this.gotos.push(url);
    const step = this.navigations.shift();
    const landed = step ? step(url) : response(200, url);
    const settled = landed as { url?: () => string } | null;
    if (settled && typeof settled.url === 'function') this.current = settled.url();
    return landed;
  }

  url(): string {
    return this.current;
  }

  async content(): Promise<string> {
    return this.body;
  }

  async waitForLoadState(): Promise<void> {}

  asPage(): Page {
    return this as unknown as Page;
  }
}

/** A browser whose contexts hand out ONE page, so a test can drive it before the run starts. */
class FakeBrowser {
  readonly options: unknown[] = [];
  readonly closed: boolean[] = [];

  constructor(readonly page: FakePage) {}

  async newContext(options: unknown): Promise<BrowserContext> {
    this.options.push(options);
    const at = this.closed.push(false) - 1;
    const context = {
      newPage: async (): Promise<Page> => this.page.asPage(),
      close: async (): Promise<void> => {
        this.closed[at] = true;
      },
    };
    return context as unknown as BrowserContext;
  }

  asBrowser(): Browser {
    return this as unknown as Browser;
  }
}

const CLEAN: LogDelta = { offset: 100, lines: [], available: true };

/**
 * An agent that records what it was asked for. Any method a test did not arrange throws, so a
 * helper that calls something it should not — minting a login for the anonymous actor, say —
 * fails loudly instead of quietly working.
 */
function fakeAgent(over: Partial<AgentClient> = {}) {
  const calls: string[] = [];
  const base: Partial<AgentClient> = {
    logDelta: async () => CLEAN,
    ensureActor: async () => ({ userId: 42 }),
    mintLogin: async () => ({ url: 'https://s.test/?wpj_login=TOKEN' }),
  };
  const arranged = { ...base, ...over } as Record<string, unknown>;
  const agent = new Proxy({}, {
    get(_target, property: string) {
      const method = arranged[property];
      if (typeof method !== 'function') {
        throw new Error(`runAsActor must not call agent.${property}()`);
      }
      return (...args: unknown[]) => {
        calls.push(`${property}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
        return (method as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as AgentClient;
  return { agent, calls };
}

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
    const body = async (target: Page, sentinel: { visit(p: Page, u: string): Promise<void> }) => {
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

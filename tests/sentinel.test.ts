import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import type { AgentClient, LogDelta } from '../src/agent/client.ts';
import { installSentinel } from '../src/sentinel/sentinel.ts';

type Handler = (arg: never) => unknown;

/** A response as the sentinel reads one: status and final URL, both synchronous. */
function response(status: number, url: string): never {
  return { status: () => status, url: () => url } as never;
}

/** A console message as the sentinel reads one. */
function consoleMessage(type: string, text: string, url = 'https://s.test/app.js'): never {
  return { type: () => type, text: () => text, location: () => ({ url }) } as never;
}

/**
 * A failed request. `response()` is a PROMISE in Playwright, which is the whole point of the
 * async handler — comparing the promise itself to null makes every failure look benign.
 */
function failedRequest(url: string, errorText: string, had: unknown = null): never {
  return { url: () => url, failure: () => ({ errorText }), response: async () => had } as never;
}

/**
 * The slice of Playwright's Page the sentinel touches. `emit` does NOT await its handlers,
 * exactly as Playwright's emitter does not — so a handler that needs a round trip must be
 * waited for by `drain()`, not by luck.
 */
class FakePage {
  readonly handlers: Record<string, Handler[]> = {};
  readonly gotos: string[] = [];
  readonly loadStates: string[] = [];
  /** What each successive goto does; a 200 on the requested URL once the queue runs out. */
  navigations: Array<() => unknown> = [];
  body = '<html><body>ok</body></html>';
  current = 'https://s.test/';

  on(event: string, handler: Handler): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers[event] ?? []) void handler(arg as never);
  }

  async goto(url: string): Promise<unknown> {
    this.gotos.push(url);
    const step = this.navigations.shift();
    return step ? step() : response(200, url);
  }

  url(): string {
    return this.current;
  }

  async content(): Promise<string> {
    return this.body;
  }

  async waitForLoadState(state: string): Promise<void> {
    this.loadStates.push(state);
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

/** Only `logDelta` is exercised; any other call is a bug worth hearing about. */
function fakeAgent(deltas: LogDelta[]) {
  const calls: Array<number | 'end'> = [];
  const agent = new Proxy({}, {
    get(_target, property: string) {
      if (property !== 'logDelta') {
        throw new Error(`the sentinel must not call agent.${property}()`);
      }
      return async (offset: number | 'end') => {
        calls.push(offset);
        return deltas.shift() ?? { offset: 4096, lines: [], available: true };
      };
    },
  }) as AgentClient;
  return { agent, calls };
}

const CLEAN: LogDelta = { offset: 100, lines: [], available: true };

/** A page plus a sentinel already baselined on a healthy log. */
async function setup(deltas: LogDelta[] = []) {
  const page = new FakePage();
  const { agent, calls } = fakeAgent([CLEAN, ...deltas]);
  const sentinel = await installSentinel(page.asPage(), agent);
  return { page, sentinel, calls };
}

describe('installSentinel', () => {
  it('baselines with a size-only logDelta("end"), never logDelta(0)', async () => {
    // logDelta(0) would pull the entire debug.log back over HTTP just to learn a length, and
    // on a long-lived dev site that is megabytes read to discover a starting offset (R33).
    const { calls } = await setup();
    expect(calls).toEqual(['end']);
  });

  it('reports nothing for a clean visit', async () => {
    const { page, sentinel } = await setup([CLEAN]);

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    expect(await sentinel.drain()).toEqual([]);
    expect(page.loadStates).toEqual(['networkidle']);
  });

  it('returns a copy, so a caller cannot edit what the sentinel has seen', async () => {
    const { page, sentinel } = await setup();
    page.emit('response', response(500, 'https://s.test/x'));

    const first = await sentinel.drain();
    first.length = 0;

    expect(await sentinel.drain()).toHaveLength(1);
  });
});

describe('sentinel.visit', () => {
  it('asserts the main document status, which nothing else in the browser surfaces', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => response(502, 'https://s.test/wp-admin/')];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    expect(await sentinel.drain()).toMatchObject([{ kind: 'response', status: 502 }]);
  });

  it('classifies against the response FINAL url, so a login redirect is visible', async () => {
    const { page, sentinel } = await setup();
    const landed = 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F';
    page.navigations = [() => response(200, landed)];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    const [finding] = await sentinel.drain();
    expect(finding?.url).toBe(landed);
    expect(finding?.text).toContain('the actor is not authenticated');
  });

  it('passes a denial served as a login redirect once the journey declares it', async () => {
    const { page, sentinel } = await setup();
    sentinel.expect({ denyExpected: true });
    page.navigations = [() => response(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F')];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    expect(await sentinel.drain()).toEqual([]);
  });

  it('reports a 5xx main document once, not twice', async () => {
    // The listener and visit() both see the document. De-duplicated on status + url (R1).
    const { page, sentinel } = await setup();
    page.navigations = [() => {
      page.emit('response', response(500, 'https://s.test/wp-admin/'));
      return response(500, 'https://s.test/wp-admin/');
    }];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    expect(await sentinel.drain()).toHaveLength(1);
  });

  it('retries once on a benign network fault, which this runner provokes itself', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [
      () => { throw new Error('page.goto: net::ERR_NETWORK_CHANGED at https://s.test/wp-admin/'); },
      () => response(200, 'https://s.test/wp-admin/'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    expect(page.gotos).toHaveLength(2);
    expect(await sentinel.drain()).toEqual([]);
  });

  it('does not retry a real navigation failure, and does not swallow it', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [
      () => { throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://s.test/wp-admin/'); },
    ];

    await expect(sentinel.visit(page.asPage(), 'https://s.test/wp-admin/'))
      .rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(page.gotos).toHaveLength(1);
  });

  it('flags a navigation that produced no response instead of silently asserting nothing', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => null];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    const [finding] = await sentinel.drain();
    expect(finding?.text).toContain('produced no response');
    expect(finding?.url).toBe('https://s.test/wp-admin/');
  });

  it('redacts a minted login token from the finding it builds for a responseless navigation', async () => {
    // This finding is built from the REQUESTED url, which at the login step IS the token URL —
    // and findings flow into JourneyResult, the run summary and whatever CI keeps (R51).
    const { page, sentinel } = await setup();
    page.navigations = [() => null];

    await sentinel.visit(page.asPage(), 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd');

    const findings = await sentinel.drain();
    expect(JSON.stringify(findings)).not.toContain('SECRETTOKEN');
    expect(findings[0]?.url).toBe('https://s.test/?wpj_login=<REDACTED>');
  });

  it('refuses a page it was not installed on, whose three live listeners are not attached', async () => {
    const { sentinel } = await setup();
    const stranger = new FakePage();

    await expect(sentinel.visit(stranger.asPage(), 'https://s.test/wp-admin/'))
      .rejects.toThrow(/installed on/);
    expect(stranger.gotos).toEqual([]);
  });
});

describe('the live listeners', () => {
  it('ignores a subresource 404 and flags a subresource 5xx', async () => {
    const { page, sentinel } = await setup();
    page.emit('response', response(404, 'https://s.test/favicon.ico'));
    page.emit('response', response(500, 'https://s.test/wp-admin/admin-ajax.php'));

    expect((await sentinel.drain()).map((f) => f.url))
      .toEqual(['https://s.test/wp-admin/admin-ajax.php']);
  });

  it('records a console error with the location that produced it', async () => {
    const { page, sentinel } = await setup();
    page.emit('console', consoleMessage('error', 'Uncaught TypeError: x is not a function'));
    page.emit('console', consoleMessage('warning', 'a deprecation notice'));

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'console', url: 'https://s.test/app.js' },
    ]);
  });

  it('redacts a login token from a navigation error it rethrows', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => { throw new Error('page.goto: net::ERR_UNSAFE_PORT at http://s.test:6000/?wpj_login=SECRETTOKENabc'); }];

    const error = await sentinel.visit(page.asPage(), 'http://s.test:6000/?wpj_login=SECRETTOKENabc').catch((e: unknown) => e);

    expect(String(error)).toContain('ERR_UNSAFE_PORT');
    expect(String(error)).not.toContain('SECRETTOKEN');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain('SECRETTOKEN');
    expect((error as Error).cause).toBeUndefined();
  });

  it('records an uncaught exception, which Playwright reports ONLY as pageerror', async () => {
    const { page, sentinel } = await setup();
    page.current = 'https://s.test/wp-admin/admin.php?page=acme';
    const thrown = new Error('undefinedPluginGlobal is not defined');
    thrown.name = 'ReferenceError';
    page.emit('pageerror', thrown);

    expect(await sentinel.drain()).toEqual([{
      kind: 'pageerror', url: 'https://s.test/wp-admin/admin.php?page=acme',
      text: 'uncaught JavaScript error at https://s.test/wp-admin/admin.php?page=acme: ReferenceError: undefinedPluginGlobal is not defined',
    }]);
  });

  it('records an unhandled promise rejection as a pageerror', async () => {
    const { page, sentinel } = await setup();
    page.emit('pageerror', new Error('acme: settings request rejected'));

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'pageerror', text: expect.stringContaining('acme: settings request rejected') },
    ]);
  });

  it('keeps two different page errors on one page as two findings', async () => {
    const { page, sentinel } = await setup();
    page.emit('pageerror', new Error('first'));
    page.emit('pageerror', new Error('second'));

    expect((await sentinel.drain()).map((f) => f.kind)).toEqual(['pageerror', 'pageerror']);
  });

  it('redacts a login token and the secret out of a page error', async () => {
    const secret = 'q'.repeat(24);
    const page = new FakePage();
    const { agent } = fakeAgent([CLEAN]);
    const sentinel = await installSentinel(page.asPage(), agent, { secret });
    page.current = 'https://s.test/?wpj_login=SECRETTOKENabc';
    page.emit('pageerror', new Error(`boom ${secret} at https://s.test/?wpj_login=SECRETTOKENabc`));

    const text = JSON.stringify(await sentinel.drain());
    expect(text).toContain('pageerror');
    expect(text).not.toContain('SECRETTOKEN');
    expect(text).not.toContain(secret);
  });

  it('awaits request.response(), which is a promise — comparing it to null hides every failure', async () => {
    // `request.response() !== null` is always true: a Promise is never null. That one slip
    // turns the requestfailed signal off entirely while leaving it looking wired up.
    const { page, sentinel } = await setup();
    page.emit('requestfailed', failedRequest('https://s.test/app.js', 'net::ERR_CONNECTION_REFUSED'));

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'requestfailed', url: 'https://s.test/app.js' },
    ]);
  });

  it('ignores an abort that did receive a response — a benign body-drain', async () => {
    const { page, sentinel } = await setup();
    page.emit('requestfailed', failedRequest('https://s.test/x', 'net::ERR_ABORTED', response(200, '/x')));

    expect(await sentinel.drain()).toEqual([]);
  });

  it('says so when a failed request could not be inspected at all', async () => {
    const { page, sentinel } = await setup();
    page.emit('requestfailed', {
      url: () => 'https://s.test/x',
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
      response: async () => { throw new Error('Target page closed'); },
    });

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'requestfailed', url: 'https://s.test/x' },
    ]);
    expect((await sentinel.drain())[0]?.text).toContain('could not be classified');
  });

  it('redacts a minted token from the could-not-be-classified finding, in url AND text (R65)', async () => {
    // At the login step the failed request IS `?wpj_login=<token>`, and a Playwright rejection
    // commonly quotes the URL it was on. `classifyRequestFailed` redacts; this catch path wrote
    // both the url and the error into the finding raw, so a `request.response()` rejection there
    // put a live credential into the run summary and into any CI log that captures it.
    const token = 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd';
    const { page, sentinel } = await setup();
    page.emit('requestfailed', {
      url: () => token,
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
      response: async () => { throw new Error(`Target page closed at ${token}`); },
    });

    const findings = await sentinel.drain();

    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain('SECRETTOKEN');
    expect(findings[0]?.url).toBe('https://s.test/?wpj_login=<REDACTED>');
    expect(findings[0]?.text).toContain('could not be classified');
  });
});

describe('sentinel.drain', () => {
  it('scans the rendered body for a diagnostic that came back as HTTP 200', async () => {
    const { page, sentinel } = await setup();
    page.current = 'https://s.test/wp-admin/';
    page.body = '<br />\n<b>Warning</b>:  Undefined variable $x in <b>/acme.php</b> on line <b>7</b><br />';

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'bodyscan', url: 'https://s.test/wp-admin/' },
    ]);
  });

  it('says so when the body could not be read, rather than quietly scanning nothing', async () => {
    const { page, sentinel } = await setup();
    page.content = async () => { throw new Error('Target page closed'); };

    const findings = await sentinel.drain();

    expect(findings).toMatchObject([{ kind: 'bodyscan' }]);
    expect(findings[0]?.text).toContain('could not be read');
  });

  it('redacts a minted token quoted by the unreadable-body ERROR, not just by the url (R51)', async () => {
    // A Playwright navigation error commonly quotes the URL it was on, and at the login step
    // that is the minted-token URL. This finding redacted its `url` field but interpolated the
    // raw error into its text, writing the credential into the summary and into CI logs.
    const { page, sentinel } = await setup();
    page.current = 'https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd';
    page.content = async () => {
      throw new Error('page.content: Target closed at https://s.test/?wpj_login=SECRETTOKENabcdef0123456789abcd');
    };

    const findings = await sentinel.drain();

    expect(JSON.stringify(findings)).not.toContain('SECRETTOKEN');
    expect(findings[0]?.text).toContain('<REDACTED>');
  });

  it('still reads the log after an unreadable body — one lost signal must not lose the rest', async () => {
    const { page, sentinel } = await setup([
      { offset: 200, lines: ['[15-Sep-2026 22:40:00 UTC] PHP Warning:  boom in /x.php on line 1'], available: true },
    ]);
    page.content = async () => { throw new Error('Target page closed'); };

    expect((await sentinel.drain()).map((f) => f.kind)).toEqual(['bodyscan', 'phplog']);
  });

  it('classifies the debug.log lines written during the window', async () => {
    const { sentinel, calls } = await setup([{
      offset: 260,
      lines: [
        '[15-Sep-2026 22:40:00 UTC] PHP Warning:  boom in /x.php on line 1',
        '[15-Sep-2026 22:40:00 UTC] Automatic updates starting...',
      ],
      available: true,
    }]);

    expect((await sentinel.drain()).map((f) => f.text))
      .toEqual(['PHP Warning: boom in /x.php on line 1']);
    expect(calls).toEqual(['end', 100]);
  });

  it('advances the offset, so the next window is not the previous one again', async () => {
    const { sentinel, calls } = await setup([
      { offset: 260, lines: [], available: true },
      { offset: 300, lines: [], available: true },
    ]);

    await sentinel.drain();
    await sentinel.drain();

    expect(calls).toEqual(['end', 100, 260]);
  });

  it('reports a lost log signal and re-baselines with "end", never feeding the echoed offset back', async () => {
    // A lost read only echoes the offset it was sent, so feeding it forward would re-read an
    // old window and attribute its contents to the wrong visit.
    const { sentinel, calls } = await setup([
      { offset: 100, lines: [], available: false, reason: 'WP_DEBUG_LOG is off' },
      { offset: 4000, lines: [], available: true },
      { offset: 4100, lines: ['[15-Sep-2026 22:40:00 UTC] PHP Warning:  boom in /x.php on line 1'], available: true },
    ]);

    const lost = await sentinel.drain();
    const recovered = await sentinel.drain();

    expect(lost).toMatchObject([{ kind: 'phplog' }]);
    expect(lost[0]?.text).toContain('WP_DEBUG_LOG is off');
    expect(calls).toEqual(['end', 100, 'end', 4000]);
    expect(recovered.map((f) => f.text)).toContain('PHP Warning: boom in /x.php on line 1');
  });

  it('reports every window it cannot read, so a persistently lost log never reads as clean', async () => {
    const { sentinel, calls } = await setup([
      { offset: 100, lines: [], available: false, reason: 'debug.log is not readable' },
      { offset: 0, lines: [], available: false, reason: 'debug.log is not readable' },
    ]);

    expect(await sentinel.drain()).toHaveLength(1);
    expect(await sentinel.drain()).toHaveLength(2);
    expect(calls).toEqual(['end', 100, 'end', 'end']);
  });

  it('reports the window as unread when the INSTALL baseline itself was lost', async () => {
    const page = new FakePage();
    const { agent, calls } = fakeAgent([
      { offset: 0, lines: [], available: false, reason: 'debug.log is not readable' },
      { offset: 900, lines: [], available: true },
    ]);
    const sentinel = await installSentinel(page.asPage(), agent);

    const findings = await sentinel.drain();

    expect(findings).toMatchObject([{ kind: 'phplog' }]);
    expect(findings[0]?.text).toContain('debug.log is not readable');
    // No usable baseline existed, so nothing may be read from an offset: take a fresh one.
    expect(calls).toEqual(['end', 'end']);
  });
});

/** A PHP warning printed into a page that still answers HTTP 200. */
const PRINTED_WARNING = '<br />\n<b>Warning</b>:  boom in <b>/acme.php</b> on line <b>1</b><br />';

/** A navigation that lands on `url`, rendering `body`. */
function lands(page: FakePage, url: string, body = '<html>clean</html>') {
  return () => {
    page.current = url;
    page.body = body;
    return response(200, url);
  };
}

describe('the expectation is one-shot (R40)', () => {
  it('goes strict again on the next visit, so a later denial is not swallowed', async () => {
    // A sticky expectation is a silent pass: once a journey declares denyExpected for ONE
    // screen, every later screen would accept a 403 as satisfying a denial nobody asked for,
    // and a genuine permission regression would report nothing at all.
    const { page, sentinel } = await setup();
    sentinel.expect({ denyExpected: true });
    page.navigations = [
      () => response(403, 'https://s.test/wp-admin/declared'),
      () => response(403, 'https://s.test/wp-admin/later'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/declared');
    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/later');

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'response', status: 403, url: 'https://s.test/wp-admin/later' },
    ]);
  });

  it('is consumed even when the declared navigation throws, so it cannot leak onward', async () => {
    const { page, sentinel } = await setup();
    sentinel.expect({ denyExpected: true });
    page.navigations = [
      () => { throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://s.test/a'); },
      () => response(403, 'https://s.test/b'),
    ];

    await expect(sentinel.visit(page.asPage(), 'https://s.test/a')).rejects.toThrow();
    await sentinel.visit(page.asPage(), 'https://s.test/b');

    expect(await sentinel.drain()).toMatchObject([{ kind: 'response', status: 403 }]);
  });
});

describe('body cover across a whole journey (R41)', () => {
  it('scans every screen it visits, not only the one showing when drain() is called', async () => {
    // The body scan is the FALLBACK for exactly the case where the log signal is lost. Scanning
    // only the final screen would silently exclude most of the journey from that fallback.
    const { page, sentinel } = await setup();
    page.navigations = [
      lands(page, 'https://s.test/first', PRINTED_WARNING),
      lands(page, 'https://s.test/second'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/first');
    await sentinel.visit(page.asPage(), 'https://s.test/second');

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'bodyscan', url: 'https://s.test/first' },
    ]);
  });

  it('still scans the final state at drain(), which no visit() covers', async () => {
    // A page that goes bad AFTER it loaded — a submit handler printing a notice — is only
    // visible at drain time.
    const { page, sentinel } = await setup();
    page.navigations = [lands(page, 'https://s.test/only')];

    await sentinel.visit(page.asPage(), 'https://s.test/only');
    page.body = PRINTED_WARNING;

    expect(await sentinel.drain()).toMatchObject([{ kind: 'bodyscan' }]);
  });

  it('reports one defect once, though both visit() and drain() see the same screen', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [lands(page, 'https://s.test/only', PRINTED_WARNING)];

    await sentinel.visit(page.asPage(), 'https://s.test/only');

    expect(await sentinel.drain()).toHaveLength(1);
  });

  it('reports BOTH diagnostics when ONE render prints two of them (R64)', async () => {
    // `scanBody` used to return only the first match. On a site whose per-request noise renders
    // early, that noise was the one match — correctly subtracted as noise — and a genuine defect
    // further down the same render never became a finding at all. Where display-only settings
    // leave bodyscan as the only signal, nothing backstops that: a lost signal reading as ok.
    const both =
      '<br />\n<b>Warning</b>:  boom in <b>/acme.php</b> on line <b>1</b><br />\n'
      + '<p>content</p>\n'
      + '<br />\n<b>Warning</b>:  Undefined array key "id" in <b>/other.php</b> on line <b>99</b><br />';
    const { page, sentinel } = await setup();
    page.navigations = [lands(page, 'https://s.test/only', both)];

    await sentinel.visit(page.asPage(), 'https://s.test/only');

    expect((await sentinel.drain()).map((f) => f.text)).toEqual([
      expect.stringContaining('boom in /acme.php on line 1'),
      expect.stringContaining('Undefined array key "id" in /other.php on line 99'),
    ]);
  });

  it('keeps a diagnostic a screen prints LATER as its own finding (R63)', async () => {
    // `collapseKey` de-duplicates a bodyscan on its TEXT. While that text was built from the
    // severity and the URL alone, two genuinely different defects on one screen produced the
    // same string and the second was discarded — a silent pass of exactly the kind the
    // de-duplication was written to avoid. The same impoverished text is what let the baseline
    // noise key swallow real defects, so one fix settles both.
    const other = '<br />\n<b>Warning</b>:  Undefined array key "id" in <b>/other.php</b> on line <b>99</b><br />';
    const { page, sentinel } = await setup();
    page.navigations = [lands(page, 'https://s.test/only', PRINTED_WARNING)];

    await sentinel.visit(page.asPage(), 'https://s.test/only');
    // The same screen prints a second, different diagnostic after it loaded.
    page.body = other;

    const findings = await sentinel.drain();

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.text)).toEqual([
      expect.stringContaining('boom in /acme.php on line 1'),
      expect.stringContaining('Undefined array key "id" in /other.php on line 99'),
    ]);
  });
});

describe('navigation wording wins the de-duplication (R42)', () => {
  it('keeps the document verdict, not the subresource echo that always arrives first', async () => {
    // Playwright emits `response` as soon as status and headers arrive, necessarily before
    // goto() resolves — so keep-the-first ALWAYS discarded the richer navigation text.
    const { page, sentinel } = await setup();
    page.navigations = [() => {
      page.emit('response', response(502, 'https://s.test/wp-admin/'));
      return response(502, 'https://s.test/wp-admin/');
    }];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/');

    const findings = await sentinel.drain();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toContain('the journey required a document it could act on');
  });

  it('keeps the expected-denial verdict over the plain 5xx echo', async () => {
    const { page, sentinel } = await setup();
    sentinel.expect({ denyExpected: true });
    page.navigations = [() => {
      page.emit('response', response(500, 'https://s.test/wp-admin/acme'));
      return response(500, 'https://s.test/wp-admin/acme');
    }];

    await sentinel.visit(page.asPage(), 'https://s.test/wp-admin/acme');

    const findings = await sentinel.drain();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toContain('expected a permission denial');
  });

  it('still reports a subresource 5xx the navigation never saw', async () => {
    const { page, sentinel } = await setup();
    page.emit('response', response(500, 'https://s.test/wp-admin/admin-ajax.php'));

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'response', status: 500, url: 'https://s.test/wp-admin/admin-ajax.php' },
    ]);
  });
});

describe('a retried navigation (R43)', () => {
  it('discards what the abandoned attempt observed', async () => {
    // Dedupe absorbs a duplicated 5xx but nothing absorbs console noise from an attempt that
    // never completed, and that noise would fail a journey that is actually fine.
    const { page, sentinel } = await setup();
    page.navigations = [
      () => {
        page.emit('console', consoleMessage('error', 'Uncaught TypeError: from the abandoned attempt'));
        throw new Error('page.goto: net::ERR_NETWORK_CHANGED at https://s.test/x');
      },
      () => response(200, 'https://s.test/x'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/x');

    expect(await sentinel.drain()).toEqual([]);
  });

  it('keeps what was observed BEFORE the visit began', async () => {
    const { page, sentinel } = await setup();
    page.emit('console', consoleMessage('error', 'Uncaught TypeError: from an earlier step'));
    page.navigations = [
      () => { throw new Error('page.goto: net::ERR_NETWORK_CHANGED at https://s.test/x'); },
      () => response(200, 'https://s.test/x'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/x');

    expect(await sentinel.drain()).toMatchObject([{ kind: 'console' }]);
  });

  it('keeps an EARLIER screen’s async finding that only lands during the failed attempt (R46)', async () => {
    // The test above pins only the synchronous case: a console error is pushed at event time,
    // so it is already on the list when the mark is taken. The requestfailed listener is not
    // like that — it queues inspect() and the finding lands when request.response() resolves,
    // which commonly happens during the NEXT goto. Taking the mark before settling puts that
    // finding above the truncation point, so the retry throws away a real defect from a screen
    // the abandoned attempt never touched.
    const { page, sentinel } = await setup();
    page.emit('requestfailed', failedRequest('https://s.test/previous-screen.js', 'net::ERR_CONNECTION_REFUSED'));
    page.navigations = [
      () => { throw new Error('page.goto: net::ERR_NETWORK_CHANGED at https://s.test/next'); },
      () => response(200, 'https://s.test/next'),
    ];

    await sentinel.visit(page.asPage(), 'https://s.test/next');

    expect(await sentinel.drain()).toMatchObject([
      { kind: 'requestfailed', url: 'https://s.test/previous-screen.js' },
    ]);
  });
});

describe('a navigation with no response to assert', () => {
  it('does not wait for networkidle, which would only burn the full timeout', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => null];

    await sentinel.visit(page.asPage(), 'https://s.test/x');

    expect(page.loadStates).toEqual([]);
  });
});

describe('sentinel.lastDocument (R86)', () => {
  it('reports the status and FINAL url of the document the last visit landed on', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => response(403, 'https://s.test/wp-login.php?redirect_to=x')];
    sentinel.expect({ denyExpected: true });

    await sentinel.visit(page.asPage(), '/wp-admin/options-general.php');

    expect(sentinel.lastDocument()).toEqual({ status: 403, url: 'https://s.test/wp-login.php?redirect_to=x' });
  });

  it('is null before any visit, and after a visit that produced no response — never a stale one', async () => {
    const { page, sentinel } = await setup();
    expect(sentinel.lastDocument()).toBeNull();

    await sentinel.visit(page.asPage(), 'https://s.test/a');
    expect(sentinel.lastDocument()).toMatchObject({ status: 200 });

    page.navigations = [() => null];
    await sentinel.visit(page.asPage(), 'https://s.test/b');
    expect(sentinel.lastDocument()).toBeNull();
  });

  it('never carries a minted login token', async () => {
    const { page, sentinel } = await setup();
    page.navigations = [() => response(200, 'https://s.test/?wpj_login=SECRET-TOKEN')];

    await sentinel.visit(page.asPage(), 'https://s.test/?wpj_login=SECRET-TOKEN');

    expect(JSON.stringify(sentinel.lastDocument())).not.toContain('SECRET-TOKEN');
  });
});

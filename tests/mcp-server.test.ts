/**
 * The MCP server: the protocol (R91), driven through injectable streams, and each tool's
 * behaviour (R84–R92), driven in-process against the same browser and agent fakes the journey
 * tests use. The sentinel is REAL, as it is everywhere else.
 */
import { Readable, Writable } from 'node:stream';

import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import type { AgentClient, LogDelta } from '../src/agent/client.ts';
import type { RawRegistries } from '../src/discovery/types.ts';
import { PROTOCOL_VERSION, createMcpServer, serve, type McpDeps, type Rpc } from '../src/mcp/server.ts';
import { TOOLS, describeTools } from '../src/mcp/tools.ts';
import { CLEAN, FakeBrowser, FakePage, fakeAgent, landsOn, response } from './helpers/fakes.ts';

/** A test value standing in for the shared secret. Nothing real. */
const SECRET = 'fixture-secret-not-real-0123456789';
const ENV = { WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: SECRET, WPJ_WP: 'wp' };
const TOKEN = 'TOKEN-abc123';
const MINT = `https://s.test/?wpj_login=${TOKEN}`;

const RAW: RawRegistries = {
  menu: [['Acme', 'manage_options', 'acme']], submenu: {}, blocks: ['acme/box'], shortcodes: ['acme'],
  routes: { '/acme/v1/x': { methods: ['GET'], guarded: true } }, roles: { administrator: ['manage_options'] },
  pluginPages: ['acme'],
};

interface Harness {
  deps: McpDeps;
  page: FakePage;
  browser: FakeBrowser;
  calls: string[];
  launches: () => number;
  shell: string[];
}

function harness(
  over: { env?: NodeJS.ProcessEnv; agent?: Partial<AgentClient>; fetchImpl?: typeof fetch } = {},
): Harness {
  const page = new FakePage();
  const browser = new FakeBrowser(page);
  const { agent, calls } = fakeAgent({
    mintLogin: async () => ({ url: MINT }),
    status: async () => ({ ok: true, wp: '7.1', php: '8.4.25', debugLog: true, pluginActive: false }),
    discover: async () => RAW,
    snapshot: async () => ({ options: [], tables: [], cron: [], userMeta: [] }),
    ...over.agent,
  });
  let launched = 0;
  const shell: string[] = [];
  const deps: McpDeps = {
    env: over.env ?? ENV,
    createAgent: () => agent,
    launchBrowser: async () => { launched += 1; return browser.asBrowser() as Browser; },
    runShell: async (command) => { shell.push(command); },
    fetchImpl: over.fetchImpl ?? ((async () => new Response('<html><body>home</body></html>')) as typeof fetch),
  };
  return { deps, page, browser, calls, launches: () => launched, shell };
}

let nextId = 1;

/** Call one tool and return its text and isError. */
async function call(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
  const reply = await server.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  const result = reply?.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError };
}

/** Drive `serve` over in-memory streams and parse every frame it wrote. */
async function converse(lines: string[], deps: McpDeps): Promise<{ frames: Rpc[]; raw: string }> {
  const input = Readable.from(lines.map((line) => `${line}\n`));
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); },
  });
  await serve({ input, output }, deps);
  const raw = chunks.join('');
  return { frames: raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Rpc), raw };
}

describe('the protocol (R91)', () => {
  it('answers initialize, ping and tools/list, with the table as the listing', async () => {
    const { deps } = harness();
    const { frames } = await converse([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    ], deps);

    expect(frames[0]).toMatchObject({
      id: 1, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'wp-journeys' } },
    });
    expect(frames[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(frames[2]).toEqual({ jsonrpc: '2.0', id: 3, result: { tools: describeTools() } });
  });

  it('routes every tool in the table, and nothing else', () => {
    const server = createMcpServer(harness().deps);
    expect(server.toolNames().sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it('never answers, and never runs, a notification', async () => {
    const h = harness();
    const { frames } = await converse([
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'login_as', arguments: { actor: 'anonymous' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ], h.deps);

    expect(frames).toEqual([]);
    expect(h.launches()).toBe(0);
  });

  it('answers in order, one request at a time, including two in one chunk', async () => {
    const { deps } = harness();
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'status' } })}\n`
        + `${JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'ping' })}\n`,
    ]);
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _e, done) { chunks.push(String(chunk)); done(); } });

    await serve({ input, output }, deps);

    expect(chunks.join('').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Rpc).id)).toEqual(['a', 'b']);
  });

  it('reports a parse error, a non-object, an unknown method and an unknown tool as JSON-RPC errors', async () => {
    const { deps } = harness();
    const { frames } = await converse([
      '{not json',
      '[1,2]',
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: [] } }),
    ], deps);

    expect(frames.map((f) => [f.id, f.error?.code])).toEqual([
      [null, -32700], [null, -32600], [4, -32601], [5, -32602], [6, -32602],
    ]);
  });

  it('turns a handler rejection into an isError result, not a protocol error', async () => {
    const server = createMcpServer(harness({ agent: { status: async () => { throw new Error('agent went away'); } } }).deps);

    const { text, isError } = await call(server, 'status');

    expect(isError).toBe(true);
    expect(text).toContain('agent went away');
  });

  it('writes nothing but JSON-RPC frames to its output (R90)', async () => {
    const { deps } = harness();
    const { raw } = await converse([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'login_as', arguments: { actor: 'anonymous' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate', arguments: { path: '/' } } }),
    ], deps);

    for (const line of raw.split('\n').filter(Boolean)) {
      expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0');
    }
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('lifecycle of the server (R85, R90)', () => {
  it('launches the browser lazily, on the first tool that needs it', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);

    await call(server, 'status');
    await call(server, 'discover_surface');
    expect(h.launches()).toBe(0);

    await call(server, 'login_as', { actor: 'anonymous' });
    await call(server, 'login_as', { actor: 'anonymous' });
    expect(h.launches()).toBe(1);
    await server.shutdown();
  });

  it('when input ends: drains nothing, closes the context, then the browser', async () => {
    const h = harness();
    const { frames } = await converse([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'login_as', arguments: { actor: 'anonymous' } } }),
    ], h.deps);
    expect(frames).toHaveLength(1);

    // One logDelta('end') for the sentinel's baseline; a drain would have asked for more.
    expect(h.calls.filter((c) => c.startsWith('logDelta'))).toEqual(['logDelta("end")']);
    expect(h.browser.closed).toEqual([true]);
    expect(h.browser.browserClosed).toBe(1);
  });

  it('closes nothing it never opened', async () => {
    const h = harness();
    await converse([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })], h.deps);
    expect(h.launches()).toBe(0);
    expect(h.browser.browserClosed).toBe(0);
  });
});

describe('configuration (R89)', () => {
  it('starts with a broken configuration, and every tool that needs it says why', async () => {
    const h = harness({ env: { WPJ_BASE_URL: 'https://example.com/', WPJ_AGENT_SECRET: SECRET } });
    const server = createMcpServer(h.deps);

    for (const [name, args] of [
      ['status', {}], ['discover_surface', {}], ['login_as', { actor: 'editor' }],
      ['run_journey', { name: 'frontend-renders', plugin: 'acme' }],
    ] as const) {
      const { text, isError } = await call(server, name, args);
      expect(isError, name).toBe(true);
      expect(text, name).toMatch(/refusing a non-local target: example\.com/);
      expect(text, name).not.toContain(SECRET);
    }
  });

  it('names a missing secret without ever printing one', async () => {
    const server = createMcpServer(harness({ env: { WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: 'short' } }).deps);
    const { text, isError } = await call(server, 'status');
    expect(isError).toBe(true);
    expect(text).toContain('WPJ_AGENT_SECRET must be at least 16 characters');
    expect(text).not.toContain('short');
  });

  it('never lets the secret out, even when an error quotes it', async () => {
    const server = createMcpServer(harness({
      agent: { status: async () => { throw new Error(`upstream echoed X-WPJ-Secret: ${SECRET}`); } },
    }).deps);

    const { text } = await call(server, 'status');

    expect(text).not.toContain(SECRET);
    expect(text).toContain('upstream echoed');
  });
});

describe('status and discover_surface (R92)', () => {
  it('reports the agent status and an available log signal', async () => {
    const server = createMcpServer(harness().deps);
    const { text, isError } = await call(server, 'status');
    expect(isError).toBe(false);
    expect(text).toContain('WordPress 7.1');
    expect(text).toContain('PHP 8.4.25');
    expect(text).toMatch(/debug\.log signal: available/);
  });

  it('says plainly when the log signal is unavailable, and why', async () => {
    const lost: LogDelta = { offset: 0, lines: [], available: false, reason: 'WP_DEBUG_LOG is off' };
    const server = createMcpServer(harness({ agent: { logDelta: async () => lost } }).deps);

    const { text } = await call(server, 'status');

    expect(text).toMatch(/debug\.log signal: UNAVAILABLE \(WP_DEBUG_LOG is off\)/);
    expect(text).not.toMatch(/signal: available/);
  });

  it('returns what the site currently registers, through the existing projection', async () => {
    const server = createMcpServer(harness().deps);
    const { text, isError } = await call(server, 'discover_surface');
    expect(isError).toBe(false);
    const surface = JSON.parse(text) as { shortcodes: string[]; blocks: string[]; restRoutes: unknown[]; screens: Array<{ url: string }> };
    expect(surface.shortcodes).toEqual(['acme']);
    expect(surface.blocks).toEqual(['acme/box']);
    expect(surface.restRoutes).toEqual([{ route: '/acme/v1/x', methods: ['GET'], guarded: true }]);
    expect(surface.screens[0]?.url).toBe('/wp-admin/admin.php?page=acme');
  });
});

describe('login_as (R84, R85, R87)', () => {
  it('opens an authenticated session and never returns the minted URL', async () => {
    const h = harness();
    h.page.navigations = [landsOn('https://s.test/wp-admin/')];
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'login_as', { actor: 'subscriber' });

    expect(isError).toBe(false);
    expect(text).toMatch(/subscriber/);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('wpj_login');
    expect(h.calls).toContain('ensureActor("subscriber")');
    await server.shutdown();
  });

  it('refuses an actor outside the six', async () => {
    const server = createMcpServer(harness().deps);
    const { text, isError } = await call(server, 'login_as', { actor: 'root' });
    expect(isError).toBe(true);
    expect(text).toMatch(/actor must be one of anonymous, subscriber/);
  });

  it('drains the previous session BEFORE closing it, and returns its findings labelled as that actor\'s', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.navigations = [() => response(502, `https://s.test/?leak=1&wpj_login=${TOKEN}`)];
    await call(server, 'navigate', { path: '/' });
    h.page.navigations = [landsOn('https://s.test/wp-admin/')];

    const { text, isError } = await call(server, 'login_as', { actor: 'editor' });

    expect(isError).toBe(false);
    expect(text).toMatch(/previous session \(anonymous\)[^\n]*1 finding/);
    expect(text).toMatch(/\[response\] navigation to .* returned HTTP 502/);
    expect(text).not.toContain(TOKEN);
    expect(h.browser.closed).toEqual([true, false]);
    await server.shutdown();
  });

  it('says a previous session was clean only when it was', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });

    const { text } = await call(server, 'login_as', { actor: 'anonymous' });

    expect(text).toMatch(/previous session \(anonymous\)[^\n]*no findings/);
    await server.shutdown();
  });

  it('refuses a session whose login failed, holds none afterwards, and still reports the previous findings', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.navigations = [
      () => response(500, 'https://s.test/'),
      landsOn(MINT), // a refused token: the page never left the mint URL (R54)
    ];
    await call(server, 'navigate', { path: '/' });

    const { text, isError } = await call(server, 'login_as', { actor: 'author' });

    expect(isError).toBe(true);
    expect(text).toMatch(/could not open a session as author/);
    expect(text).toMatch(/the minted token was refused/);
    expect(text).toMatch(/previous session \(anonymous\)[^\n]*1 finding/);
    expect(text).not.toContain(TOKEN);
    expect((await call(server, 'navigate', { path: '/' })).text).toMatch(/call login_as first/);
  });

  it('keeps the previous session\'s findings when opening the next one THROWS (C1)', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.navigations = [() => response(502, 'https://s.test/')];
    await call(server, 'navigate', { path: '/' });
    h.browser.newContextError = new Error('Target page, context or browser has been closed');

    const { text, isError } = await call(server, 'login_as', { actor: 'editor' });

    expect(isError).toBe(true);
    expect(text).toMatch(/could not open a session as editor: Target page, context or browser has been closed/);
    expect(text).toMatch(/previous session \(anonymous\)[^\n]*1 finding/);
    expect(text).toMatch(/\[response\] navigation to .* returned HTTP 502/);
  });

  it('relaunches a browser that disconnected, instead of failing every later call (C1)', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    expect(h.launches()).toBe(1);

    h.browser.disconnect();
    const { isError } = await call(server, 'login_as', { actor: 'anonymous' });

    expect(isError).toBe(false);
    expect(h.launches()).toBe(2);
    await server.shutdown();
  });

  it('relaunches a cached browser that reports itself disconnected, even without the event (C1)', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    // Silence the event: only isConnected() says so.
    (h.browser as unknown as { connected: boolean }).connected = false;

    await call(server, 'login_as', { actor: 'anonymous' });

    expect(h.launches()).toBe(2);
    await server.shutdown();
  });

  it('refuses a session whose sentinel could not be installed — no unwatched page', async () => {
    const server = createMcpServer(harness({ agent: { logDelta: async () => { throw new Error('agent unreachable'); } } }).deps);

    const { text, isError } = await call(server, 'login_as', { actor: 'anonymous' });

    expect(isError).toBe(true);
    expect(text).toMatch(/sentinel could not be installed/);
    expect((await call(server, 'read_page')).isError).toBe(true);
  });
});

describe('navigate, read_page and drain_sentinel with no session (R85)', () => {
  it('each says to call login_as first', async () => {
    const server = createMcpServer(harness().deps);
    for (const [name, args] of [['navigate', { path: '/' }], ['read_page', {}], ['drain_sentinel', {}]] as const) {
      const { text, isError } = await call(server, name, args);
      expect(isError, name).toBe(true);
      expect(text, name).toMatch(/call login_as first/);
    }
  });
});

describe('navigate (R86)', () => {
  async function anonymous() {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    return { h, server };
  }

  it('refuses anything but a path starting with exactly one slash, without navigating', async () => {
    const { h, server } = await anonymous();
    for (const path of ['//evil.example/', 'https://evil.example/', 'wp-admin/', '/\\evil.example/', 42]) {
      const { text, isError } = await call(server, 'navigate', { path });
      expect(isError, String(path)).toBe(true);
      expect(text, String(path)).toMatch(/path must start with exactly one "\/"/);
    }
    expect(h.page.gotos).toEqual([]);
    await server.shutdown();
  });

  it('refuses a non-boolean expect_denied', async () => {
    const { server } = await anonymous();
    const { isError, text } = await call(server, 'navigate', { path: '/', expect_denied: 'yes' });
    expect(isError).toBe(true);
    expect(text).toMatch(/expect_denied must be a boolean/);
    await server.shutdown();
  });

  it('returns the status, the final URL and a clean verdict for a served page', async () => {
    const { h, server } = await anonymous();
    h.page.navigations = [() => response(200, 'https://s.test/hello/')];

    const { text, isError } = await call(server, 'navigate', { path: '/hello' });

    expect(isError).toBe(false);
    expect(text).toContain('HTTP 200 https://s.test/hello/');
    expect(text).toMatch(/verdict: clean/);
    expect(h.page.gotos).toEqual(['/hello']);
    await server.shutdown();
  });

  it('passes an expected denial only when asked for, and for that visit only', async () => {
    const { h, server } = await anonymous();
    const bounce = () => response(200, 'https://s.test/wp-login.php?redirect_to=%2Fwp-admin%2F');
    h.page.navigations = [bounce, bounce];

    const denied = await call(server, 'navigate', { path: '/wp-admin/options-general.php', expect_denied: true });
    const strict = await call(server, 'navigate', { path: '/wp-admin/options-general.php' });

    expect(denied.isError).toBe(false);
    expect(denied.text).toMatch(/verdict: clean/);
    expect(denied.text).toMatch(/expected: denied/);
    // One-shot (R40): the second visit declared nothing, so the bounce is a finding.
    expect(strict.isError).toBe(true);
    expect(strict.text).toMatch(/verdict: 1 finding/);
    expect(strict.text).toMatch(/not authenticated/);
    await server.shutdown();
  });

  it('fails an expected denial that was served instead', async () => {
    const { h, server } = await anonymous();
    h.page.navigations = [() => response(200, 'https://s.test/wp-admin/options-general.php')];

    const { text, isError } = await call(server, 'navigate', { path: '/wp-admin/options-general.php', expect_denied: true });

    expect(isError).toBe(true);
    expect(text).toMatch(/\[response\]/);
    await server.shutdown();
  });

  it('never returns a token, in the final URL or in the verdict', async () => {
    const { h, server } = await anonymous();
    h.page.navigations = [() => response(500, `https://s.test/?wpj_login=${TOKEN}`)];

    const { text } = await call(server, 'navigate', { path: `/?wpj_login=${TOKEN}` });

    expect(text).toContain('HTTP 500');
    expect(text).not.toContain(TOKEN);
    await server.shutdown();
  });

  it('says so when the navigation produced no response', async () => {
    const { h, server } = await anonymous();
    h.page.navigations = [() => null];

    const { text, isError } = await call(server, 'navigate', { path: '/' });

    expect(isError).toBe(true);
    expect(text).toMatch(/no response/);
    await server.shutdown();
  });
});

describe('read_page (R87)', () => {
  it('returns the visible text and the page URL, with any token redacted from both', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.current = `https://s.test/?wpj_login=${TOKEN}`;
    h.page.text = `Welcome. You arrived from https://s.test/?wpj_login=${TOKEN}&x=1`;

    const { text, isError } = await call(server, 'read_page');

    expect(isError).toBe(false);
    expect(text).toContain('Welcome. You arrived from https://s.test/?wpj_login=<REDACTED>&x=1');
    expect(text).toContain('https://s.test/?wpj_login=<REDACTED>');
    expect(text).not.toContain(TOKEN);
    await server.shutdown();
  });

  it('reports a page whose text could not be read as an error, redacted', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.textError = new Error(`locator timed out on https://s.test/?wpj_login=${TOKEN}`);

    const { text, isError } = await call(server, 'read_page');

    expect(isError).toBe(true);
    expect(text).not.toContain(TOKEN);
    await server.shutdown();
  });
});

describe('drain_sentinel', () => {
  it('reports clean when nothing was observed', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });

    const { text, isError } = await call(server, 'drain_sentinel');

    expect(isError).toBe(false);
    expect(text).toMatch(/clean: no findings/);
    await server.shutdown();
  });

  it('reports every finding so far, the PHP log included, redacted, and not as clean', async () => {
    let reads = 0;
    const h = harness({
      agent: {
        logDelta: async (offset) => {
          reads += 1;
          if (offset === 'end') return CLEAN;
          return { offset: 200, available: true, lines: [
            `[16-Sep-2026 10:00:00 UTC] PHP Warning:  Undefined variable $x in /wp-content/plugins/acme/a.php on line 3 ?wpj_login=${TOKEN}`,
          ] };
        },
      },
    });
    const server = createMcpServer(h.deps);
    await call(server, 'login_as', { actor: 'anonymous' });
    h.page.emit('response', response(503, `https://s.test/x.js?wpj_login=${TOKEN}`));

    const { text, isError } = await call(server, 'drain_sentinel');

    expect(isError).toBe(true);
    expect(text).toMatch(/2 findings/);
    expect(text).toMatch(/\[response\] HTTP 503/);
    expect(text).toMatch(/\[phplog\] PHP Warning/);
    expect(text).not.toContain(TOKEN);
    expect(reads).toBeGreaterThan(1);
    await server.shutdown();
  });
});

describe('run_journey (R88)', () => {
  it('refuses lifecycle BEFORE touching the site, pointing to wpj run', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'lifecycle:acme', plugin: 'acme' });

    expect(isError).toBe(true);
    expect(text).toMatch(/uninstalls the plugin under test/);
    expect(text).toMatch(/wpj run --plugin acme/);
    expect(h.shell).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.launches()).toBe(0);
  });

  it('refuses an unknown journey, naming what exists, before touching the site', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'nope', plugin: 'acme' });

    expect(isError).toBe(true);
    expect(text).toMatch(/no journey named "nope"/);
    expect(text).toContain('frontend-renders');
    expect(h.shell).toEqual([]);
  });

  it('refuses a plugin slug the CLI would refuse, before any shell sees it', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme;id' });

    expect(isError).toBe(true);
    expect(text).toMatch(/is not a plugin slug/);
    expect(h.shell).toEqual([]);
  });

  it('refuses when WPJ_WP is not set, as wpj run does', async () => {
    const h = harness({ env: { WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: SECRET } });
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme' });

    expect(isError).toBe(true);
    expect(text).toMatch(/WPJ_WP is not set/);
  });

  it('reports a manifest problem through the CLI\'s own loader', async () => {
    const h = harness({ env: { ...ENV, WPJ_MANIFEST_DIR: '' } });
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme' });

    expect(isError).toBe(true);
    expect(text).toMatch(/WPJ_MANIFEST_DIR is set but empty/);
  });

  it('captures the baseline as wpj run does, then renders a pass as the summary row', async () => {
    const h = harness();
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme' });

    expect(isError).toBe(false);
    expect(h.shell).toEqual(['wp plugin deactivate acme', 'wp plugin activate acme']);
    expect(text).toMatch(/^outcome: pass$/m);
    expect(text).toMatch(/^ {2}ok +frontend-renders \(anonymous\/frontend\)/m);
    expect(h.page.gotos).toEqual(['/']);
  });

  it('renders a skip as a skip, never a pass, and a skip is not an error', async () => {
    const h = harness({ agent: { discover: async () => ({ ...RAW, menu: [], pluginPages: [] }) } });
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'admin-sweep:acme:subscriber', plugin: 'acme' });

    expect(isError).toBe(false);
    expect(text).toMatch(/^outcome: skip$/m);
    expect(text).toMatch(/^ {2}skip +admin-sweep:acme:subscriber .* skipped \(acme added no admin screens to sweep\)$/m);
    expect(text).not.toMatch(/\bok\b/);
    expect(text).not.toMatch(/pass/);
  });

  it('marks a failed journey as an error, with its findings', async () => {
    const h = harness();
    h.page.navigations = [() => response(502, 'https://s.test/')];
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme' });

    expect(isError).toBe(true);
    expect(text).toMatch(/^outcome: fail$/m);
    expect(text).toMatch(/FAIL\(1\) +frontend-renders/);
    expect(text).toMatch(/HTTP 502/);
  });

  it('subtracts the baseline\'s per-request noise before deciding, as wpj run does (R45)', async () => {
    const noise = '[16-Sep-2026 10:00:00 UTC] PHP Deprecated:  Creation of dynamic property Acme::$x is deprecated in /wp-content/themes/t/functions.php on line 1';
    let offset = 0;
    const h = harness({
      agent: {
        // Every window that is read carries the site's own per-request deprecation.
        logDelta: async (at) => {
          if (at === 'end') return { offset, lines: [], available: true };
          offset += 1;
          return { offset, lines: [noise], available: true };
        },
      },
    });
    const server = createMcpServer(h.deps);

    const { text, isError } = await call(server, 'run_journey', { name: 'frontend-renders', plugin: 'acme' });

    expect(text).toMatch(/^outcome: pass$/m);
    expect(isError).toBe(false);
  });
});

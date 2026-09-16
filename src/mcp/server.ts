/**
 * The runner as MCP tools over stdio: a THIN ADAPTER. Every judgement it reports was made by the
 * runner's own modules — the session primitive, the sentinel, the run builder, `outcomeOf` and
 * the summary renderer. Logic that exists only here is a bug.
 *
 * Three rules are enforced at this boundary, because this is where text leaves the process:
 *  - stdout carries JSON-RPC frames and nothing else (R90);
 *  - no minted login token and no shared secret ever leaves in a tool result (R87, R89) — every
 *    tool's text, success or error, goes through one outbound filter;
 *  - a lost or skipped signal never reads as ok: switching actor drains the previous session
 *    first (R85), and a skipped journey is rendered as the summary renders it (R88).
 *
 * The protocol half mirrors wp-harness's `src/mcp/protocol.ts` (JSON-RPC 2.0 over
 * newline-delimited stdio, MCP 2025-06-18, tools only), re-implemented here because this is a
 * separate package with no runtime dependencies.
 */
import { Console } from 'node:console';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { Browser } from '@playwright/test';

import { ALL_ACTORS, isAnonymous, type Actor } from '../actors/roles.ts';
import { createAgentClient } from '../agent/client.ts';
import { signRenderDoor } from '../agent/render.ts';
import type { AgentClient } from '../agent/client.ts';
import { loadConfig, SECRET_VAR } from '../config.ts';
import type { Config } from '../config.ts';
import { projectSurface } from '../discovery/surface.ts';
import { messageOf } from '../errors.ts';
import { outcomeOf, register } from '../journeys/index.ts';
import { openActorSession, type ActorSession } from '../journeys/support.ts';
import { BODY_TIMEOUT_MS } from '../manifest/interpret.ts';
import { plural, renderFinding, renderJourney } from '../report/summary.ts';
import { launchChromium } from '../runner/browser.ts';
import { manifestPlan, parseArgs, prepareSuite, runSuite, siteActions, suiteShape, WP_VAR } from '../runner/cli.ts';
import type { Finding } from '../sentinel/phplog.ts';
import { isSitePath } from '../site-path.ts';
import { outboundText } from '../outbound.ts';
import { VERSION } from '../version.ts';
import { describeTools } from './tools.ts';

// ── protocol ─────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '2025-06-18';

export interface Rpc {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** What a tool resolves with. `isError` is what an MCP client hands the model as "this failed". */
interface ToolResult {
  text: string;
  isError?: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── dependencies ─────────────────────────────────────────────────────────────────────────────

export interface McpDeps {
  env: NodeJS.ProcessEnv;
  createAgent: (baseUrl: string, secret: string) => AgentClient;
  /** Called at most once, by the first tool that needs a browser (R90). */
  launchBrowser: () => Promise<Browser>;
  /** How `run_journey` runs the operator's wp-cli command; the CLI's own shell when omitted. */
  runShell?: (command: string) => Promise<void>;
  /** The baseline's front-end probe; global fetch when omitted. */
  fetchImpl?: typeof fetch;
}

function defaultDeps(): McpDeps {
  return { env: process.env, createAgent: createAgentClient, launchBrowser: () => launchChromium() };
}

// ── rendering (formats the runner already has) ───────────────────────────────────────────────

function findingLines(findings: readonly Finding[]): string[] {
  return findings.map(renderFinding);
}

/** What retiring a held session produced: its labelled lines, and how many findings they carry. */
interface Retired {
  lines: string[];
  findings: number;
}

const NOTHING_RETIRED: Retired = { lines: [], findings: 0 };

/**
 * A result with a retired session's lines attached (R85). A result that CARRIES findings is an
 * error to a client that reads only `isError` (R95d) — never ok while findings exist — and when
 * the call itself succeeded, the text says that is the only reason.
 */
function carrying(previous: Retired, result: ToolResult): ToolResult {
  if (previous.findings === 0) {
    return { ...result, text: [result.text, ...previous.lines].join('\n') };
  }
  const why = result.isError
    ? []
    : ["this call succeeded; isError is set because it carries the previous session's findings"];
  return { isError: true, text: [result.text, ...why, ...previous.lines].join('\n') };
}

/** No session to act on: said the same way by every tool that needs one (R85). */
const NO_SESSION: ToolResult = {
  text: 'no browser session is open — call login_as first', isError: true,
};

// ── the server ───────────────────────────────────────────────────────────────────────────────

export function createMcpServer(deps: McpDeps) {
  let browser: Promise<Browser> | null = null;
  let current: ActorSession | null = null;

  /**
   * Everything that leaves as tool text. Tokens are redacted (R87); the secret is removed
   * outright (R89) — nothing the runner writes quotes it, and this makes that a guarantee
   * rather than a property of today's messages.
   */
  function outbound(text: string): string {
    return outboundText(text, deps.env[SECRET_VAR]);
  }

  /** The loader `wpj run` uses; its message is the tool's error when configuration is broken (R89). */
  function configured(): { cfg: Config; agent: AgentClient } {
    const cfg = loadConfig(deps.env);
    return { cfg, agent: deps.createAgent(cfg.baseUrl, cfg.secret) };
  }

  /**
   * The browser, launched on first use (R90). Neither a failed launch nor a browser that has gone
   * away is remembered (C1): a crashed browser would otherwise fail every later call for good.
   */
  async function launched(): Promise<Browser> {
    if (browser !== null) {
      const held = await browser;
      if (held.isConnected()) return held;
      browser = null;
      // Best effort (R95f): whatever is left of its process should not outlive the server.
      held.close().catch(() => {});
    }
    const launching: Promise<Browser> = deps.launchBrowser().then(
      (fresh) => {
        fresh.on('disconnected', () => { if (browser === launching) browser = null; });
        return fresh;
      },
      (error: unknown) => {
        browser = null;
        throw error;
      },
    );
    browser = launching;
    return launching;
  }

  /**
   * Drain the held session, THEN close it, and say what it saw (R85). Never silent: a clean
   * session says so, and so does one whose context would not close.
   */
  async function retire(): Promise<Retired> {
    if (current === null) return NOTHING_RETIRED;
    const session = current;
    current = null;
    const findings = await session.drain();
    const lines = findings.length === 0
      ? [`previous session (${session.actor}) drained before closing: no findings`]
      : [`previous session (${session.actor}) drained before closing: ${plural(findings.length, 'finding')} — NOT clean`,
        ...findingLines(findings)];
    try {
      await session.close();
    } catch (error) {
      lines.push(`previous session (${session.actor})'s browser context could not be closed: ${messageOf(error)}`);
    }
    return { lines, findings: findings.length };
  }

  /** One journey, run as `wpj run` would run it (R88). The caller has already retired any session. */
  async function runOneJourney(args: Record<string, unknown>): Promise<ToolResult> {
    const { name, plugin } = args;
    if (typeof name !== 'string' || name === '') throw new Error('name must be a non-empty string');
    if (typeof plugin !== 'string') throw new Error('plugin must be a string');
    // The CLI's own slug rule, applied the CLI's own way: the slug reaches a shell.
    const parsed = parseArgs(['run', '--plugin', plugin]);
    if (!parsed.ok) throw new Error(parsed.reason);

    const { cfg, agent } = configured();
    const wp = deps.env[WP_VAR];
    if (!wp) throw new Error(`${WP_VAR} is not set — the runner needs a wp-cli command to toggle the plugin.`);

    // Everything below that refuses does so BEFORE the baseline touches the site.
    const plan = await manifestPlan(deps.env, plugin);
    const shape = suiteShape(plugin, plan);
    if (!Object.hasOwn(shape, name)) {
      throw new Error(`no journey named ${JSON.stringify(name)} for ${plugin} — known: ${Object.keys(shape).join(', ')}`);
    }
    const refusal = `${name} uninstalls the plugin under test, which a tool call must not do as a side effect — `
      + `run it with \`wpj run --plugin ${plugin}\``;
    if (shape[name]!.uninstallsPlugin) throw new Error(refusal);

    const actions = siteActions(wp, plugin, deps.runShell);
    const prepared = await prepareSuite(agent, cfg, plugin, plan, {
      ...actions,
      // Unreachable for any journey that declares it uninstalls; a hard stop for one that does not.
      uninstall: async () => { throw new Error(refusal); },
    }, deps.fetchImpl);
    const journey = prepared.suite[name];
    if (journey === undefined || journey.uninstallsPlugin) throw new Error(refusal);

    const [result] = await runSuite(register(journey), await launched(), cfg, agent, prepared.baseline);
    const outcome = outcomeOf(result!);
    return { isError: outcome === 'fail', text: `outcome: ${outcome}\n${renderJourney(result!)}` };
  }

  const handlers: Record<string, Handler> = {
    async status() {
      const { agent } = configured();
      const status = await agent.status();
      const log = await agent.logDelta('end');
      return {
        text: [
          `WordPress ${status.wp}`,
          `PHP ${status.php}`,
          `WP_DEBUG_LOG ${status.debugLog ? 'on' : 'off'}`,
          log.available
            ? 'debug.log signal: available'
            : `debug.log signal: UNAVAILABLE (${log.reason ?? 'no reason given'}) — PHP diagnostics will NOT be read`,
        ].join('\n'),
      };
    },

    async discover_surface() {
      const { agent } = configured();
      return { text: JSON.stringify(projectSurface(await agent.discover()), null, 2) };
    },

    async login_as(args) {
      const actor = args.actor;
      if (typeof actor !== 'string' || !(ALL_ACTORS as readonly string[]).includes(actor)) {
        throw new Error(`actor must be one of ${ALL_ACTORS.join(', ')}`);
      }
      const { cfg, agent } = configured();
      const target = await launched();
      const previous = await retire();

      let opened;
      try {
        opened = await openActorSession(target, cfg, agent, actor as Actor);
      } catch (error) {
        // The previous session is already drained and closed: its findings exist only here now,
        // so a throw must not take them with it (C1, R85).
        return carrying(previous, { isError: true, text: `could not open a session as ${actor}: ${messageOf(error)}` });
      }
      if (!opened.ok) {
        return carrying(previous, {
          isError: true,
          text: [`could not open a session as ${actor}:`, ...findingLines(opened.findings)].join('\n'),
        });
      }
      current = opened.session;
      const how = isAnonymous(actor as Actor) ? 'anonymous: no login' : 'authenticated';
      return carrying(previous, { text: `session open as ${actor} (${how}), sentinel armed` });
    },

    async navigate(args) {
      const { path } = args;
      if (typeof path !== 'string' || !isSitePath(path)) {
        throw new Error(`path must start with exactly one "/" and stay on the target site, got ${JSON.stringify(path)}`);
      }
      const expectDenied = args.expect_denied ?? false;
      if (typeof expectDenied !== 'boolean') throw new Error('expect_denied must be a boolean');
      if (current === null) return NO_SESSION;

      // A render-door path is signed here, as the manifest's readBack is: a client cannot sign it.
      const target = signRenderDoor(path, loadConfig(deps.env).secret);
      // One-shot (R40): declared before EVERY visit, exactly as the journeys do.
      current.sentinel.expect({ denyExpected: expectDenied });
      const verdict = await current.sentinel.visit(current.page, target);
      const landed = current.sentinel.lastDocument();
      return {
        isError: verdict.length > 0,
        text: [
          landed === null ? `no response for ${path}` : `HTTP ${landed.status} ${landed.url}`,
          `expected: ${expectDenied ? 'denied' : 'served'}`,
          verdict.length === 0
            ? 'verdict: clean — the document was what was expected'
            : `verdict: ${plural(verdict.length, 'finding')}`,
          ...findingLines(verdict),
        ].join('\n'),
      };
    },

    async read_page() {
      if (current === null) return NO_SESSION;
      const text = await current.page.locator('body').innerText({ timeout: BODY_TIMEOUT_MS });
      return { text: `${current.page.url()}\n\n${text}` };
    },

    async drain_sentinel() {
      if (current === null) return NO_SESSION;
      const findings = await current.drain();
      return {
        isError: findings.length > 0,
        text: findings.length === 0
          ? `clean: no findings for this ${current.actor} session`
          : [`${plural(findings.length, 'finding')} for this ${current.actor} session:`, ...findingLines(findings)].join('\n'),
      };
    },

    async run_journey(args) {
      // A held session is retired FIRST (M4): its sentinel's log window would otherwise take in
      // the baseline and the run, and attribute their lines to the held actor — unsubtracted.
      // Its findings travel with this result, whatever the result is (R85).
      const previous = await retire();
      let result: ToolResult;
      try {
        result = await runOneJourney(args);
      } catch (error) {
        result = { isError: true, text: messageOf(error) };
      }
      return carrying(previous, result);
    },
  };

  /** A tool's result, always through the outbound filter; a rejection is an `isError` result (R91). */
  async function callTool(handler: Handler, args: Record<string, unknown>): Promise<Rpc['result']> {
    let result: ToolResult;
    try {
      result = await handler(args);
    } catch (error) {
      result = { text: messageOf(error), isError: true };
    }
    return { content: [{ type: 'text', text: outbound(result.text) }], isError: result.isError ?? false };
  }

  async function handle(msg: Rpc): Promise<Rpc | null> {
    // A notification is never answered and never run (R91).
    if (msg.id === undefined) return null;
    const reply = (result: unknown): Rpc => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    const fail = (code: number, message: string): Rpc => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'wp-journeys', version: VERSION } });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: describeTools() });
      case 'tools/call': {
        const p = isPlainObject(msg.params) ? msg.params : {};
        const handler = typeof p.name === 'string' && Object.hasOwn(handlers, p.name) ? handlers[p.name] : undefined;
        if (!handler) return fail(INVALID_PARAMS, `unknown tool ${String(p.name)}`);
        const args = p.arguments ?? {};
        if (!isPlainObject(args)) return fail(INVALID_PARAMS, 'arguments must be an object');
        return reply(await callTool(handler, args));
      }
      default:
        return fail(METHOD_NOT_FOUND, `method not found: ${String(msg.method)}`);
    }
  }

  /**
   * The client is gone: nobody to report to, so nothing is drained (R85). The context closes,
   * then the browser.
   */
  async function shutdown(): Promise<void> {
    const session = current;
    current = null;
    try {
      if (session !== null) await session.close();
    } finally {
      // Even when the context would not close (M7): an orphaned browser outlives the server.
      if (browser !== null) {
        const open = browser;
        browser = null;
        await (await open).close();
      }
    }
  }

  return { handle, shutdown, toolNames: () => Object.keys(handlers) };
}

/**
 * While serving on the real stdout, nothing but frames may reach it (I1, R90) — and code the
 * server does not own runs inside it: an escape-hatch journey module, and whatever that pulls in.
 *
 * So frames are written through a private reference to stdout's own `write`, and every other
 * route to stdout is pointed at stderr: the global `console` is replaced, and `process.stdout.write`
 * itself is swapped, which also catches a `console.log` captured before serving began (the global
 * console writes through that same stream method). Restored when serving ends.
 *
 * The limit: a write straight to file descriptor 1 (`fs.writeSync(1, …)`, a child process that
 * inherits stdout) bypasses both, and nothing short of owning the descriptor can stop it.
 */
function divertStdout(): { writeFrame: (text: string) => void; restore: () => void } {
  const { stdout, stderr } = process;
  const originalWrite = stdout.write;
  const originalConsole = globalThis.console;
  const writeFrame = (text: string): void => { originalWrite.call(stdout, text); };
  stdout.write = stderr.write.bind(stderr) as typeof stdout.write;
  globalThis.console = new Console(stderr, stderr);
  return {
    writeFrame,
    restore: () => {
      stdout.write = originalWrite;
      globalThis.console = originalConsole;
    },
  };
}

/**
 * Serve until `input` ends. One JSON message per line in, one per line out, handled one at a
 * time in arrival order. `output` receives nothing but replies (R90).
 */
export async function serve(
  streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
  deps: McpDeps = defaultDeps(),
): Promise<void> {
  const server = createMcpServer(deps);
  const diverted = streams.output === process.stdout ? divertStdout() : null;
  const write = diverted?.writeFrame ?? ((text: string) => { streams.output.write(text); });
  const send = (msg: Rpc) => { write(`${JSON.stringify(msg)}\n`); };
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
        continue;
      }
      if (!isPlainObject(parsed)) {
        send({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request: expected a JSON-RPC object' } });
        continue;
      }
      const response = await server.handle(parsed as unknown as Rpc);
      if (response) send(response);
    }
  } finally {
    try {
      await server.shutdown();
    } catch (error) {
      // Diagnostics go to stderr, never to the protocol stream (R90).
      process.stderr.write(`wpj mcp: shutdown failed: ${outboundText(messageOf(error), deps.env[SECRET_VAR])}\n`);
    } finally {
      diverted?.restore();
    }
  }
}

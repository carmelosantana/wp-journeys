/**
 * Task 15's live proof: drive `wpj mcp` over real stdio against the scratch site, as an MCP
 * client would, and assert what comes back.
 *
 *   initialize → login_as subscriber → navigate /wp-admin/profile.php (must be SERVED: the
 *   control that proves the session is real, R54) → navigate /wp-admin/options-general.php with
 *   expect_denied: true (must be DENIED, and that denial is the pass) → drain_sentinel
 *
 * A proof that cannot go red must fail loudly (R53): every step's `isError`, status and verdict
 * is asserted, and any failed assertion exits non-zero.
 *
 * It prints nothing secret. The server already redacts tokens and the secret from every tool
 * result (R87, R89); this script checks the RAW protocol stream for both anyway, and refuses to
 * print a stream that carries either.
 *
 * Usage (wpjtest only — login_as provisions nothing new there, but it is still a live site):
 *   set -a; . ./.env; set +a
 *   node scripts/prove-mcp-session.ts
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** The ONE site this may drive. */
const TARGET_HOST = 'wpjtest.wp.test';

const base = process.env.WPJ_BASE_URL ?? '';
let host = '';
try {
  host = new URL(base).hostname;
} catch {
  // reported below
}
if (host !== TARGET_HOST) {
  process.stderr.write(`refusing: WPJ_BASE_URL must point at ${TARGET_HOST} (got host ${JSON.stringify(host)})\n`);
  process.exit(2);
}
const secret = process.env.WPJ_AGENT_SECRET ?? '';

interface Frame {
  id?: number;
  result?: { content?: Array<{ text: string }>; isError?: boolean; [key: string]: unknown };
  error?: { code: number; message: string };
}

const wpj = fileURLToPath(new URL('../bin/wpj.js', import.meta.url));
const child = spawn(process.execPath, [wpj, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const frames = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

let nextId = 1;
const failures: string[] = [];

/** Never print a frame that carries a live token or the secret — say so instead. */
function leakIn(raw: string): string | null {
  if (secret.length > 0 && raw.includes(secret)) return 'the shared secret';
  // Plain and percent-encoded (a token inside `redirect_to`).
  if (/(?:[?&]|%3F|%26)wpj_login(?:=|%3D)(?!<REDACTED>)/i.test(raw)) return 'an unredacted login token';
  return null;
}

async function request(method: string, params?: unknown): Promise<Frame> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const next = await frames.next();
  if (next.done) throw new Error(`the server closed its output before answering ${method}`);
  const raw = next.value;
  const leak = leakIn(raw);
  if (leak) throw new Error(`the reply to ${method} carried ${leak} — not printed`);
  const frame = JSON.parse(raw) as Frame;
  if (frame.id !== id) throw new Error(`expected a reply to id ${id}, got ${String(frame.id)}`);
  return frame;
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const frame = await request('tools/call', { name, arguments: args });
  if (frame.error) throw new Error(`${name}: JSON-RPC error ${frame.error.code} ${frame.error.message}`);
  const text = (frame.result?.content ?? []).map((c) => c.text).join('\n');
  const isError = frame.result?.isError === true;
  process.stdout.write(`\n── ${name} ${JSON.stringify(args)} → isError=${isError}\n${text}\n`);
  return { text, isError };
}

function check(ok: boolean, what: string): void {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${what}\n`);
  if (!ok) failures.push(what);
}

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prove-mcp-session', version: '0' } });
  process.stdout.write(`── initialize → ${JSON.stringify(init.result)}\n`);
  check((init.result as { serverInfo?: { name?: string } }).serverInfo?.name === 'wp-journeys', 'initialize names the wp-journeys server');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const login = await tool('login_as', { actor: 'subscriber' });
  check(!login.isError, 'login_as subscriber opened a session');
  check(/session open as subscriber \(authenticated\)/.test(login.text), 'the session is an authenticated one');

  const control = await tool('navigate', { path: '/wp-admin/profile.php' });
  check(!control.isError && /^HTTP 200 /m.test(control.text) && /verdict: clean/.test(control.text),
    'control: the subscriber is SERVED profile.php, so the session is real (R54)');

  const denied = await tool('navigate', { path: '/wp-admin/options-general.php', expect_denied: true });
  check(!denied.isError, 'navigate with expect_denied: true is not an error');
  check(/^HTTP 403 /m.test(denied.text), 'the subscriber was refused options-general.php with HTTP 403');
  check(/expected: denied/.test(denied.text) && /verdict: clean/.test(denied.text),
    'the denial was expected, so the verdict is clean — a pass for the right reason');

  const drained = await tool('drain_sentinel');
  check(!drained.isError && /clean: no findings/.test(drained.text), 'drain_sentinel reports the session clean');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  // Input ends: the server drains nothing, closes the context and the browser, and exits.
  child.stdin.end();
}

const code = await new Promise<number | null>((resolve) => { child.on('close', resolve); });
check(code === 0, `wpj mcp exited 0 when its input ended (got ${String(code)})`);

if (failures.length > 0) {
  process.stdout.write(`\nPROOF FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nPROOF PASSED\n');

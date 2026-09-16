/**
 * `serve()` on the REAL process.stdout, with a tool that writes to stdout every way author code
 * could: console.log/info/debug, a console.log captured before serving started, and a direct
 * process.stdout.write. Spawned by tests/mcp-server.test.ts, which asserts stdout carries only
 * JSON-RPC frames.
 */
import type { AgentClient } from '../../src/agent/client.ts';
import { serve } from '../../src/mcp/server.ts';

const early = console.log;

const agent = {
  status: async () => {
    console.log('noise: console.log');
    console.info('noise: console.info');
    console.debug('noise: console.debug');
    early('noise: captured console.log');
    process.stdout.write('noise: process.stdout.write\n');
    return { ok: true, wp: '7.1', php: '8.4', debugLog: true };
  },
  logDelta: async () => ({ offset: 1, lines: [], available: true }),
} as unknown as AgentClient;

await serve(undefined, {
  env: { WPJ_BASE_URL: 'https://s.test/', WPJ_AGENT_SECRET: 'fixture-secret-not-real-0123456789' },
  createAgent: () => agent,
  launchBrowser: () => Promise.reject(new Error('no browser in this fixture')),
});
process.stdout.write('after serve: stdout is restored\n');

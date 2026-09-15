import { describe, expect, it } from 'vitest';

import { createAgentClient } from '../src/agent/client.ts';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    fakeFetch.lastUrl = String(url);
    fakeFetch.lastInit = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}
fakeFetch.lastUrl = '';
fakeFetch.lastInit = undefined as RequestInit | undefined;

describe('createAgentClient', () => {
  it('posts to the agent route with the shared secret header', async () => {
    const f = fakeFetch(200, { ok: true, wp: '6.8.1', php: '8.4.25', debugLog: true });
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    const status = await client.status();

    expect(status.wp).toBe('6.8.1');
    expect(status.debugLog).toBe(true);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/wp-json/wp-journeys/v1/agent');
    const headers = fakeFetch.lastInit?.headers as Record<string, string>;
    expect(headers['X-WPJ-Secret']).toBe('s3cret');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'status', args: {} });
  });

  it('turns the agent refusal into a named error rather than a generic HTTP failure', async () => {
    const f = fakeFetch(403, { code: 'wpj_refused', message: 'WP_DEBUG is off' });
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    await expect(client.status()).rejects.toThrow(
      'wp-journeys agent refused the request: WP_DEBUG is off',
    );
  });
});

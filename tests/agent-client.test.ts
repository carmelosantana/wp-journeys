import { describe, expect, it } from 'vitest';

import { createAgentClient } from '../src/agent/client.ts';

function fakeRawFetch(status: number, text: string, contentType: string): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    fakeFetch.lastUrl = String(url);
    fakeFetch.lastInit = init;
    return new Response(text, { status, headers: { 'content-type': contentType } });
  }) as unknown as typeof fetch;
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return fakeRawFetch(status, JSON.stringify(body), 'application/json');
}
fakeFetch.lastUrl = '';
fakeFetch.lastInit = undefined as RequestInit | undefined;

const STATUS_BODY = { ok: true, wp: '6.8.1', php: '8.4.25', debugLog: true };

/** The URL the client requests for a given base URL. */
async function requestedUrl(baseUrl: string): Promise<string> {
  await createAgentClient(baseUrl, 's3cret', fakeFetch(200, STATUS_BODY)).status();
  return fakeFetch.lastUrl;
}

describe('createAgentClient', () => {
  it('posts to the agent route with the shared secret header', async () => {
    const f = fakeFetch(200, STATUS_BODY);
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    const status = await client.status();

    expect(status.wp).toBe('6.8.1');
    expect(status.debugLog).toBe(true);
    // ?rest_route= works on plain permalinks (WordPress's default), where /wp-json/ is unrouted.
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    const headers = fakeFetch.lastInit?.headers as Record<string, string>;
    expect(headers['X-WPJ-Secret']).toBe('s3cret');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'status', args: {} });
  });

  it('keeps the path of a WordPress installed in a subdirectory', async () => {
    expect(await requestedUrl('https://example.test/sub')).toBe(
      'https://example.test/sub/?rest_route=%2Fwp-journeys%2Fv1%2Fagent',
    );
  });

  it('requests the same URL whether or not the base URL ends in a slash', async () => {
    expect(await requestedUrl('https://example.test/sub/')).toBe(
      await requestedUrl('https://example.test/sub'),
    );
    expect(await requestedUrl('https://wpjtest.wp.test/')).toBe(
      await requestedUrl('https://wpjtest.wp.test'),
    );
  });

  it('turns a non-JSON reply into a named error rather than a raw parse failure', async () => {
    const f = fakeRawFetch(200, '<!DOCTYPE html><html><title>wpjtest</title></html>', 'text/html');
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    await expect(client.status()).rejects.toThrow(
      'wp-journeys agent at https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent did not return JSON (HTTP 200)',
    );
  });

  it('asks the agent to discover and returns the raw registries untouched', async () => {
    const registries = { menu: [], submenu: {}, blocks: ['core/paragraph'], shortcodes: [], routes: {}, roles: {} };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, registries));

    expect(await client.discover()).toEqual(registries);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'discover', args: {} });
  });

  it('turns the agent refusal into a named error rather than a generic HTTP failure', async () => {
    const f = fakeFetch(403, { code: 'wpj_refused', message: 'WP_DEBUG is off' });
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    await expect(client.status()).rejects.toThrow(
      'wp-journeys agent refused the request: WP_DEBUG is off',
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  AGENT_TIMEOUT_MS, AgentBadResponseError, AgentRefusedError, AgentTimeoutError, createAgentClient,
} from '../src/agent/client.ts';

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

describe('createAgentClient, on the way out (redirects and timeouts)', () => {
  it('never follows a redirect, so the secret header cannot be carried to another origin', async () => {
    const f = fakeFetch(200, STATUS_BODY);
    await createAgentClient('https://wpjtest.wp.test', 's3cret-long-enough-0123', f).status();
    expect(fakeFetch.lastInit?.redirect).toBe('manual');
    await createAgentClient('https://wpjtest.wp.test', 's3cret-long-enough-0123', f).discover();
    expect(fakeFetch.lastInit?.redirect).toBe('manual');
  });

  it('bounds every request with a timeout signal', async () => {
    const f = fakeFetch(200, STATUS_BODY);
    await createAgentClient('https://wpjtest.wp.test', 's3cret-long-enough-0123', f).status();
    expect(fakeFetch.lastInit?.signal).toBeInstanceOf(AbortSignal);
    expect(AGENT_TIMEOUT_MS).toBe(30_000);
  });

  it('turns a 301 into a named error naming where it pointed, without the secret', async () => {
    const secret = 'redirect-secret-value-0123456789';
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      fakeFetch.lastInit = init;
      return new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/landing?x=1' } });
    }) as unknown as typeof fetch;
    const client = createAgentClient('https://wpjtest.wp.test', secret, f);

    const error = await client.status().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentBadResponseError);
    expect((error as Error).message).toMatch(/redirected \(HTTP 301\) to https:\/\/elsewhere\.example/);
    expect((error as Error).message).toMatch(/WPJ_BASE_URL is probably wrong/);
    expect((error as Error).message).not.toContain('landing');
    expect((error as Error).message).not.toContain(secret);
  });

  it('names a relative redirect by the origin it resolves to', async () => {
    const f = (async () => new Response(null, { status: 302, headers: { location: '/wp-login.php' } })) as unknown as typeof fetch;
    await expect(createAgentClient('https://wpjtest.wp.test/', 'x'.repeat(16), f).status())
      .rejects.toThrow(/redirected \(HTTP 302\) to https:\/\/wpjtest\.wp\.test/);
  });

  it('turns an abort into a named, loud timeout error', async () => {
    const f = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as unknown as typeof fetch;
    const error = await createAgentClient('https://wpjtest.wp.test', 'x'.repeat(16), f).logDelta('end').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect((error as Error).message).toMatch(/did not answer "logDelta" within 30 s/);
  });

  it('treats a plain AbortError the same way', async () => {
    const f = (async () => { throw new DOMException('This operation was aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(createAgentClient('https://wpjtest.wp.test', 'x'.repeat(16), f).discover()).rejects.toBeInstanceOf(AgentTimeoutError);
  });
});

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

  it('discovers through admin-post.php, where is_admin() is true, and returns the registries untouched', async () => {
    const registries = { menu: [], submenu: {}, blocks: ['core/paragraph'], shortcodes: [], routes: {}, roles: {} };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, registries));

    expect(await client.discover()).toEqual(registries);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/wp-admin/admin-post.php?action=wpj_discover');
    expect(fakeFetch.lastInit?.method).toBe('POST');
    const headers = fakeFetch.lastInit?.headers as Record<string, string>;
    expect(headers['X-WPJ-Secret']).toBe('s3cret');
  });

  it('keeps the path of a subdirectory install for discovery, with or without a trailing slash', async () => {
    for (const base of ['https://example.test/sub', 'https://example.test/sub/']) {
      await createAgentClient(base, 's3cret', fakeFetch(200, {})).discover();
      expect(fakeFetch.lastUrl).toBe('https://example.test/sub/wp-admin/admin-post.php?action=wpj_discover');
    }
  });

  it('raises the named refusal error when discovery is refused', async () => {
    const refusal = { code: 'wpj_refused', message: 'shared secret mismatch', data: { status: 403 } };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(403, refusal));

    const error = await client.discover().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentRefusedError);
    expect((error as Error).message).toBe('wp-journeys agent refused the request: shared secret mismatch');
  });

  it('raises the named bad-response error when discovery answers with something other than JSON', async () => {
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeRawFetch(400, '<html></html>', 'text/html'));

    const error = await client.discover().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentBadResponseError);
    expect((error as Error).message).toBe(
      'wp-journeys agent at https://wpjtest.wp.test/wp-admin/admin-post.php?action=wpj_discover did not return JSON (HTTP 400) — is the agent mounted and the base URL right?',
    );
  });

  it('snapshots through the REST route and returns the names untouched', async () => {
    const snapshot = { options: ['siteurl'], tables: ['wp_options'], cron: ['wp_version_check'], userMeta: ['nickname'] };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, snapshot));

    expect(await client.snapshot()).toEqual(snapshot);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'snapshot', args: {} });
  });

  it('asks the status about the plugin under test when given its slug (R75)', async () => {
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, { ok: true, pluginActive: true }));

    await client.status('acme');

    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'status', args: { plugin: 'acme' } });
  });

  it('asks the snapshot about the plugin under test when given its slug (R79)', async () => {
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, { pluginActive: false }));

    await client.snapshot('acme');

    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'snapshot', args: { plugin: 'acme' } });
  });

  it('reads the debug.log delta through the REST route, sending the offset', async () => {
    const delta = { offset: 512, lines: ['[15-Sep-2026 22:40:00 UTC] PHP Notice:  x in /x.php on line 1'], available: true };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, delta));

    expect(await client.logDelta(382)).toEqual(delta);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'logDelta', args: { offset: 382 } });
  });

  it('asks for a size-only baseline with offset "end"', async () => {
    const baseline = { offset: 545, lines: [], available: true };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, baseline));

    expect(await client.logDelta('end')).toEqual(baseline);
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({ action: 'logDelta', args: { offset: 'end' } });
  });

  it('refuses an offset that is neither "end" nor a non-negative integer, before any request', async () => {
    // JSON turns NaN and Infinity into null, and PHP clamps a negative to 0: either way the
    // whole log would come back as one delta.
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, { offset: 0, lines: [], available: true }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      fakeFetch.lastUrl = '';
      await expect(client.logDelta(bad), String(bad)).rejects.toThrow(
        `logDelta offset must be 'end' or a non-negative integer, got ${String(bad)}`,
      );
      expect(fakeFetch.lastUrl, String(bad)).toBe('');
    }
  });

  it('passes a lost log signal through as lost, never as an empty clean delta', async () => {
    const lost = { offset: 0, lines: [], available: false, reason: 'WP_DEBUG_LOG is off' };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, lost));

    expect(await client.logDelta(0)).toEqual(lost);
  });

  it('turns the agent refusal into a named error rather than a generic HTTP failure', async () => {
    const f = fakeFetch(403, { code: 'wpj_refused', message: 'WP_DEBUG is off' });
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', f);

    await expect(client.status()).rejects.toThrow(
      'wp-journeys agent refused the request: WP_DEBUG is off',
    );
  });

  it('provisions an actor through the REST route, sending the role', async () => {
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, { userId: 7 }));

    expect(await client.ensureActor('editor')).toEqual({ userId: 7 });
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({
      action: 'ensureActor',
      args: { role: 'editor' },
    });
  });

  it('mints a login through the REST route, sending the user id', async () => {
    const minted = { url: 'https://wpjtest.wp.test/?wpj_login=TOKEN' };
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, minted));

    expect(await client.mintLogin(7)).toEqual(minted);
    expect(fakeFetch.lastUrl).toBe('https://wpjtest.wp.test/?rest_route=%2Fwp-journeys%2Fv1%2Fagent');
    expect(JSON.parse(String(fakeFetch.lastInit?.body))).toEqual({
      action: 'mintLogin',
      args: { userId: 7 },
    });
  });

  it('refuses a user id that is not a positive integer, before any request', async () => {
    // PHP casts 2.9 to 2, so a fractional id would quietly mint a session for a DIFFERENT
    // actor: a journey running as the wrong user, with nothing to show that it did.
    const client = createAgentClient('https://wpjtest.wp.test', 's3cret', fakeFetch(200, { url: 'x' }));
    for (const bad of [0, -1, 2.9, Number.NaN]) {
      fakeFetch.lastUrl = '';
      await expect(client.mintLogin(bad), String(bad)).rejects.toThrow(
        `mintLogin needs a positive integer user id, got ${String(bad)}`,
      );
      expect(fakeFetch.lastUrl, String(bad)).toBe('');
    }
  });
});

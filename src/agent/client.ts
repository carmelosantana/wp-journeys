/**
 * The typed client for the companion mu-plugin's single REST route.
 *
 * Every capability the runner needs from inside WordPress — discovery, the log delta, the
 * state snapshot, login minting — arrives through this one route, so there is exactly one
 * seam to secure and exactly one code path whether or not wp-cli is available.
 */

import type { RawRegistries } from '../discovery/types.ts';

/** What the agent reports about the site it is running in. */
export interface AgentStatus {
  ok: true;
  wp: string;
  php: string;
  debugLog: boolean;
}

/** The agent's callable surface. Later tasks widen this interface. */
export interface AgentClient {
  status(): Promise<AgentStatus>;
  discover(): Promise<RawRegistries>;
}

/** The agent refused to serve (its guard said no). Distinct from a transport failure. */
export class AgentRefusedError extends Error {}

/** Whatever answered was not the agent: the reply was not JSON (wrong URL, agent not mounted). */
export class AgentBadResponseError extends Error {}

const ROUTE = '/wp-journeys/v1/agent';

/**
 * The agent's URL for a site's base URL.
 *
 * Addressed as `?rest_route=` rather than `/wp-json/`, because plain permalinks — WordPress's
 * default — leave `/wp-json/` unrouted (it serves the home page). The base path is kept, so a
 * WordPress in a subdirectory works, and normalised to end in exactly one `/`: POSTing to `/sub`
 * can earn a 301 to `/sub/`, which fetch follows as a GET.
 */
function agentUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/*$/, '/');
  url.hash = '';
  url.searchParams.set('rest_route', ROUTE);
  return url.toString();
}

export function createAgentClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): AgentClient {
  const endpoint = agentUrl(baseUrl);

  async function call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WPJ-Secret': secret },
      body: JSON.stringify({ action, args }),
    });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AgentBadResponseError(
        `wp-journeys agent at ${endpoint} did not return JSON (HTTP ${response.status}) — is the agent mounted and the base URL right?`,
      );
    }
    if (response.status === 403 && payload.code === 'wpj_refused') {
      throw new AgentRefusedError(
        `wp-journeys agent refused the request: ${String(payload.message)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`wp-journeys agent returned HTTP ${response.status} for "${action}"`);
    }
    return payload as T;
  }

  return {
    status: () => call<AgentStatus>('status'),
    discover: () => call<RawRegistries>('discover'),
  };
}

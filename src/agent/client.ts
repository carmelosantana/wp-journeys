/**
 * The typed client for the companion mu-plugin.
 *
 * Every capability the runner needs from inside WordPress — discovery, the log delta, the
 * state snapshot, login minting — arrives through the agent, behind one guard and one shared
 * secret, whether or not wp-cli is available. Two doors lead in: the REST route for most
 * actions, and admin-post.php for discovery, which must run where `is_admin()` is true.
 */

import type { Snapshot } from '../discovery/snapshot.ts';
import type { RawRegistries } from '../discovery/types.ts';

/** What the agent reports about the site it is running in. */
export interface AgentStatus {
  ok: true;
  wp: string;
  php: string;
  debugLog: boolean;
}

/**
 * Complete debug.log lines written since a prior offset. `available: false` means the signal
 * is LOST, not clean: its `offset` only echoes the one sent, so after a lost read the runner
 * must re-baseline with `logDelta('end')` rather than feed that offset back.
 */
export interface LogDelta {
  offset: number;
  lines: string[];
  available: boolean;
  reason?: string;
}

/** The agent's callable surface. Later tasks widen this interface. */
export interface AgentClient {
  status(): Promise<AgentStatus>;
  discover(): Promise<RawRegistries>;
  snapshot(): Promise<Snapshot>;
  /** The delta since `offset`, or with `'end'` a size-only baseline that returns no lines. */
  logDelta(offset: number | 'end'): Promise<LogDelta>;
}

/** The agent refused to serve (its guard said no). Distinct from a transport failure. */
export class AgentRefusedError extends Error {}

/** Whatever answered was not the agent: the reply was not JSON (wrong URL, agent not mounted). */
export class AgentBadResponseError extends Error {}

const ROUTE = '/wp-journeys/v1/agent';

/**
 * A site's base URL normalised to end in exactly one `/`, so relative paths resolve inside it.
 * The base path is kept, so a WordPress in a subdirectory works; POSTing to `/sub` can earn a
 * 301 to `/sub/`, which fetch follows as a GET.
 */
function siteBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/*$/, '/');
  url.hash = '';
  return url;
}

/**
 * The agent's REST URL. Addressed as `?rest_route=` rather than `/wp-json/`, because plain
 * permalinks — WordPress's default — leave `/wp-json/` unrouted (it serves the home page).
 */
function agentUrl(baseUrl: string): string {
  const url = siteBase(baseUrl);
  url.searchParams.set('rest_route', ROUTE);
  return url.toString();
}

/**
 * Discovery's URL. admin-post.php defines WP_ADMIN, so plugins that register their menus only
 * when `is_admin()` do so; a REST request would miss them. Not admin-ajax.php: many plugins
 * also skip menu registration under DOING_AJAX.
 */
function discoverUrl(baseUrl: string): string {
  const url = new URL('wp-admin/admin-post.php', siteBase(baseUrl));
  url.searchParams.set('action', 'wpj_discover');
  return url.toString();
}

export function createAgentClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): AgentClient {
  const endpoint = agentUrl(baseUrl);
  const discoverEndpoint = discoverUrl(baseUrl);

  /** One request path for both doors: the same secret header and the same named errors. */
  async function post<T>(url: string, body: unknown, label: string): Promise<T> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WPJ-Secret': secret },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AgentBadResponseError(
        `wp-journeys agent at ${url} did not return JSON (HTTP ${response.status}) — is the agent mounted and the base URL right?`,
      );
    }
    if (response.status === 403 && payload.code === 'wpj_refused') {
      throw new AgentRefusedError(
        `wp-journeys agent refused the request: ${String(payload.message)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`wp-journeys agent returned HTTP ${response.status} for "${label}"`);
    }
    return payload as T;
  }

  function call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return post<T>(endpoint, { action, args }, action);
  }

  return {
    status: () => call<AgentStatus>('status'),
    discover: () => post<RawRegistries>(discoverEndpoint, {}, 'discover'),
    snapshot: () => call<Snapshot>('snapshot'),
    logDelta: async (offset: number | 'end') => {
      // JSON sends NaN and Infinity as null and PHP clamps a negative to 0: either would read
      // the whole log as one delta, so refuse before the request.
      if (offset !== 'end' && !(Number.isInteger(offset) && offset >= 0)) {
        throw new RangeError(`logDelta offset must be 'end' or a non-negative integer, got ${String(offset)}`);
      }
      return call<LogDelta>('logDelta', { offset });
    },
  };
}

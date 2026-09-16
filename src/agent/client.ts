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
  /** Present only when the status was asked about a plugin: whether it is in active_plugins. */
  pluginActive?: boolean;
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
  status(plugin?: string): Promise<AgentStatus>;
  discover(): Promise<RawRegistries>;
  /**
   * Name-only state. Given the plugin under test's slug, it also says whether that plugin is
   * active (`pluginActive`).
   */
  snapshot(plugin?: string): Promise<Snapshot>;
  /** The delta since `offset`, or with `'end'` a size-only baseline that returns no lines. */
  logDelta(offset: number | 'end'): Promise<LogDelta>;
  /**
   * Create, or find, the runner's own WordPress user for a role, and return its id.
   * Idempotent: the same role always answers with the same user.
   */
  ensureActor(role: string): Promise<{ userId: number }>;
  /**
   * A single-use, five-minute URL that authenticates a browser as one of the runner's actors.
   * The agent mints one only for users it created, never for a real person's account.
   */
  mintLogin(userId: number): Promise<{ url: string }>;
}

/** The agent refused to serve (its guard said no). Distinct from a transport failure. */
export class AgentRefusedError extends Error {}

/** Whatever answered was not the agent: the reply was not JSON (wrong URL, agent not mounted). */
export class AgentBadResponseError extends Error {}

/** The agent did not answer in time, or the request was aborted. Never read as an empty answer. */
export class AgentTimeoutError extends Error {}

/** How long one agent request may take before it is a named failure rather than a hang. */
export const AGENT_TIMEOUT_MS = 30_000;

/** Whether a fetch rejection is an abort — the timeout signal's, or any other. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The origin a 3xx pointed at, resolved against the URL that answered. Only the origin: the
 * path and query of wherever the site bounced to are not the operator's business here.
 */
export function redirectOrigin(location: string | null, from: string): string {
  if (location === null || location === '') return '<no Location header>';
  try {
    return new URL(location, from).origin;
  } catch {
    return '<an unparseable Location header>';
  }
}

const ROUTE = '/wp-journeys/v1/agent';

/**
 * A site's base URL normalised to end in exactly one `/`, so relative paths resolve inside it.
 * The base path is kept, so a WordPress in a subdirectory works; POSTing to `/sub` can earn a
 * 301 to `/sub/`, which the client refuses rather than follows.
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

  /**
   * One request path for both doors: the same secret header and the same named errors.
   *
   * Redirects are NEVER followed. A followed redirect re-sends the secret header to wherever the
   * site pointed — another origin included — and a POST followed as a GET answers something
   * that is not the agent. A 3xx here means the base URL is not the site's canonical address.
   * Every request is bounded too: an agent that never answers is a named failure, not a hang.
   */
  async function post<T>(url: string, body: unknown, label: string): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WPJ-Secret': secret },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
    } catch (error) {
      if (isAbort(error)) {
        throw new AgentTimeoutError(
          `wp-journeys agent at ${new URL(url).origin} did not answer "${label}" within ${AGENT_TIMEOUT_MS / 1000} s — is the site up?`,
        );
      }
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AgentBadResponseError(
        `wp-journeys agent at ${url} redirected (HTTP ${response.status}) to ${redirectOrigin(response.headers.get('location'), url)} `
          + '— the request was not followed, so the secret was not sent there. WPJ_BASE_URL is probably wrong: '
          + 'set it to the site\'s canonical address (scheme, host and path exactly as WordPress reports them).',
      );
    }
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
    status: (plugin?: string) => call<AgentStatus>('status', plugin === undefined ? {} : { plugin }),
    discover: () => post<RawRegistries>(discoverEndpoint, {}, 'discover'),
    snapshot: (plugin?: string) => call<Snapshot>('snapshot', plugin === undefined ? {} : { plugin }),
    logDelta: async (offset: number | 'end') => {
      // JSON sends NaN and Infinity as null and PHP clamps a negative to 0: either would read
      // the whole log as one delta, so refuse before the request.
      if (offset !== 'end' && !(Number.isInteger(offset) && offset >= 0)) {
        throw new RangeError(`logDelta offset must be 'end' or a non-negative integer, got ${String(offset)}`);
      }
      return call<LogDelta>('logDelta', { offset });
    },
    ensureActor: (role: string) => call<{ userId: number }>('ensureActor', { role }),
    mintLogin: async (userId: number) => {
      // PHP casts a float to an int, so 2.9 would mint a session as user 2 — a different
      // actor, with nothing in the result to show the runner drove the wrong one.
      if (!(Number.isInteger(userId) && userId > 0)) {
        throw new RangeError(`mintLogin needs a positive integer user id, got ${String(userId)}`);
      }
      return call<{ url: string }>('mintLogin', { userId });
    },
  };
}

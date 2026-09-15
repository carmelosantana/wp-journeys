/**
 * The typed client for the companion mu-plugin's single REST route.
 *
 * Every capability the runner needs from inside WordPress — discovery, the log delta, the
 * state snapshot, login minting — arrives through this one route, so there is exactly one
 * seam to secure and exactly one code path whether or not wp-cli is available.
 */

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
}

/** The agent refused to serve (its guard said no). Distinct from a transport failure. */
export class AgentRefusedError extends Error {}

const ROUTE = '/wp-json/wp-journeys/v1/agent';

export function createAgentClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): AgentClient {
  async function call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetchImpl(new URL(ROUTE, baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WPJ-Secret': secret },
      body: JSON.stringify({ action, args }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
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
  };
}

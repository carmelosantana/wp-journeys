/**
 * Runtime configuration, read from the environment.
 *
 * The local-only guard is deliberate and mirrors the agent's own: the runner creates users,
 * activates and deactivates plugins, and reads a debug log. Pointing it at a real site would
 * be destructive, so a non-local host is refused here as well as in PHP — two independent
 * gates, because one of them will eventually be wrong.
 */
export interface Config {
  baseUrl: string;
  secret: string;
}

/**
 * The variables this module reads, named once. Exported so the README and the skills can be
 * checked against the names the code actually reads (tests/skills-content.test.ts).
 */
export const BASE_URL_VAR = 'WPJ_BASE_URL';
export const SECRET_VAR = 'WPJ_AGENT_SECRET';

/** Hostnames the runner will drive. Anything else is refused. */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    // URL keeps the brackets on an IPv6 host, so this is the shape `[::1]` arrives in.
    hostname === '[::1]' ||
    // `.test` already covers the harness's own `.wp.test` suffix.
    hostname.endsWith('.test') ||
    hostname.endsWith('.localhost')
  );
}

/** The shortest shared secret the runner accepts — and so the shortest `redactSecret` scrubs. */
export const MIN_SECRET_LENGTH = 16;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = env[BASE_URL_VAR];
  if (!baseUrl) {
    throw new Error(`${BASE_URL_VAR} is not set — the runner has no target.`);
  }
  const { hostname } = new URL(baseUrl);
  if (!isLocalHost(hostname)) {
    throw new Error(
      `refusing a non-local target: ${hostname}. wp-journeys creates users, toggles plugins and reads debug.log; it is for development sites only.`,
    );
  }
  const secret = env[SECRET_VAR] ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${SECRET_VAR} must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return { baseUrl, secret };
}

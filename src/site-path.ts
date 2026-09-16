/**
 * Whether a string is a path on the TARGET site, and nothing that could leave it (R86).
 *
 * Shared by every place a caller hands the runner a site-relative path to navigate to — the
 * manifest's gate screen and the MCP server's `navigate` — so the rule has one definition.
 *
 * "Starts with a slash" is not enough: `//host/` is protocol-relative, browsers read `/\host/`
 * the same way, and the URL parser strips tabs and newlines anywhere, so `/\t/host/` becomes
 * `//host/` on the way in. The resolved origin is therefore checked as well as the spelling.
 */
const PROBE_BASE = 'https://target.invalid/';

export function isSitePath(path: string): boolean {
  if (!/^\/(?![/\\])/.test(path)) return false;
  try {
    return new URL(path, PROBE_BASE).origin === new URL(PROBE_BASE).origin;
  } catch {
    return false;
  }
}

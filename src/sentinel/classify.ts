/**
 * The pure classifiers. Every "is this a defect?" decision lives here, with no browser and
 * no I/O, so the sentinel's judgement is unit-testable in full.
 */
import type { Finding } from './phplog.ts';

export type { Finding, SignalKind } from './phplog.ts';
export { classifyPhpLogLine } from './phplog.ts';

/** What the journey said it expected of the document being classified. */
export interface Expectation {
  /**
   * True when the journey is asserting that this actor must be DENIED. A 403 — or WordPress's
   * login redirect — then satisfies the assertion, and a 200 on the screen itself violates it.
   * This is not "ignore all 4xx": with `false`, an unexpected denial is still a finding.
   */
  denyExpected: boolean;
}

/**
 * Faults that mean "the machine's network moved", not "the app is broken".
 *
 * `ERR_NETWORK_CHANGED` fires whenever any process runs wp-cli against the same site — and
 * this runner does exactly that DURING a run (the baseline capture toggles the plugin, and the
 * lifecycle journey uninstalls it with a page open). Flagging it would make the suite fail at
 * random, and a suite that fails at random stops being read.
 */
const BENIGN_NETWORK = /net::(ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED)/;

/**
 * Subresource policy: lenient, and deliberately expectation-free (R1).
 *
 * This runs for EVERY response on the page, so it cannot know what the journey expected of any
 * one of them. Applying `denyExpected` here would read each 2xx asset on a correctly-denied
 * 403 page — a stylesheet, a favicon — as "expected a denial but got HTTP 200", failing every
 * unpermitted-actor journey. Only a 5xx is unambiguous from a subresource. The document's own
 * status is `classifyNavigation`'s job, where the expectation actually applies.
 */
export function classifyResponse(status: number, url: string): Finding | null {
  if (status >= 500) {
    return { kind: 'response', status, url, text: `HTTP ${status} response from ${url}` };
  }
  return null;
}

/**
 * WordPress does not deny a logged-out request for an admin screen with a 403: it 302s to
 * `wp-login.php`, which answers 200. A denial test that only accepts 401/403 could therefore
 * never pass. The same page is also how a FAILED login presents — an actor that should be
 * authenticated and lands here would otherwise sail through as a clean 2xx.
 *
 * Decided on the PATHNAME, so `/wp-login.php?redirect_to=…` and `/sub/wp-login.php` match while
 * `/wp-login.php.bak` and `/?x=wp-login.php` do not. The base is only there so a relative URL
 * parses; it never affects the answer.
 */
function isLoginPage(url: string): boolean {
  try {
    return new URL(url, 'http://wp-journeys.invalid/').pathname.endsWith('/wp-login.php');
  } catch {
    return false;
  }
}

/**
 * Main-document policy: strict.
 *
 * Nothing surfaces a bad navigation status for you. Chrome logs a console entry for a failed
 * SUBRESOURCE but not for the document's own status, so a 502 from a stopped container renders
 * an error page, screenshots beautifully, and passes every content assertion. A 404 from a
 * mistyped admin URL does the same. Anything the journey navigated to must therefore be 2xx —
 * or the denial it explicitly expected.
 *
 * Pass the response's FINAL url, not the requested one, or the login redirect is invisible.
 */
export function classifyNavigation(status: number, url: string, expect: Expectation): Finding | null {
  const login = isLoginPage(url);
  if (expect.denyExpected) {
    if (status === 401 || status === 403 || login) return null;
    return {
      kind: 'response', status, url,
      text: `expected a permission denial at ${url} but the document returned HTTP ${status}`,
    };
  }
  if (login) {
    return {
      kind: 'response', status, url,
      text: `redirected to the login page at ${url} — the actor is not authenticated`,
    };
  }
  if (status >= 200 && status < 300) return null;
  return {
    kind: 'response', status, url,
    text: `navigation to ${url} returned HTTP ${status} — the journey required a document it could act on`,
  };
}

/**
 * Chromium emits a console error for EVERY non-2xx resource load. Below 500 that is a
 * downstream echo of a status the subresource policy already saw — and which is deliberately
 * benign there — so suppress it, or every expected denial double-reports.
 */
export function classifyConsole(type: string, text = '', url = ''): Finding | null {
  if (type !== 'error') return null;
  // Environment noise arrives here too, as "Failed to load resource: net::ERR_NETWORK_CHANGED"
  // — which carries no status code, so the echo rule below would not catch it.
  if (BENIGN_NETWORK.test(text)) return null;
  const echo = text.match(/Failed to load resource: the server responded with a status of (\d{3})\b/);
  if (echo && Number(echo[1]) < 500) return null;
  return { kind: 'console', url: url || undefined, text: `console.error: ${text || '<empty>'}` };
}

/**
 * A `requestfailed` that ALSO received a response is a benign body-drain abort, not a
 * failure. Only a truly responseless request is flagged.
 */
export function classifyRequestFailed(url = '', failure = '', hasResponse = false): Finding | null {
  if (hasResponse) return null;
  if (BENIGN_NETWORK.test(failure)) return null;
  return {
    kind: 'requestfailed', url: url || undefined,
    text: `request failed: ${failure || 'unknown failure'} for ${url || '<unknown url>'}`,
  };
}

/**
 * Catch a PHP diagnostic that was PRINTED into the response instead of logged — which is
 * how `WP_DEBUG_DISPLAY` behaves, and how a plugin corrupts JSON or breaks headers.
 */
const SEVERITY = 'Warning|Notice|Deprecated|Fatal error|Parse error|Recoverable fatal error';

/**
 * Anchored on PHP's two OUTPUT FORMATS rather than on how long the message is.
 *
 * A length bound between the severity and `in ... on line` misses WordPress's
 * `_doing_it_wrong()` — whose message runs to ~345 characters because it appends a docs link
 * and a "(This message was added in version X.)" sentence. Merely widening the bound trades one
 * bug for another: prose that says "Warning:" would then match an unrelated "on line" later in
 * the page. Matching the format is what distinguishes them.
 *
 *   html_errors=1  <b>Warning</b>:  msg in <b>/path.php</b> on line <b>42</b>
 *   html_errors=0  Warning: msg in /path.php on line 42
 *   fatals         Fatal error: Uncaught Error: ...
 *
 * The file position may be `Unknown` or `Command line code` instead of a path: PHP reports no
 * file for a shutdown/stream-open fatal, and wp-cli's `eval` has none. `Unknown` is the case
 * that renders a broken page with NO other on-page signal, so it must be caught. It stays safe
 * against prose ("filed in Unknown Artist; see the note on line 3") only because the position
 * must be IMMEDIATELY followed by `on line <digits>` — never relax that adjacency.
 */
const BODY_DIAGNOSTIC = new RegExp(
  `<b>(?:${SEVERITY})<\\/b>:[\\s\\S]*?<b>[^<]*<\\/b> on line <b>\\d+<\\/b>` +
    `|^(?:${SEVERITY}): [\\s\\S]*? in (?:\\/[^\\s]+|Unknown|Command line code) on line \\d+` +
    `|(?:${SEVERITY}): Uncaught `,
  'm',
);

export function scanBody(body: string, url: string): Finding | null {
  if (!body) return null;
  const hit = BODY_DIAGNOSTIC.exec(body);
  if (!hit) return null;
  const severity = new RegExp(`(${SEVERITY})`).exec(hit[0])?.[1] ?? 'diagnostic';
  return {
    kind: 'bodyscan', url,
    text: `PHP ${severity} printed into the response body at ${url}`,
  };
}

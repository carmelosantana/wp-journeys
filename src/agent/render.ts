/**
 * The agent's render doors, as the runner drives them: `?wpj_render=[tag]` expands one shortcode
 * on the front end and prints it inside a marker, and `?wpj_render_block=<name>` does the same
 * for one block. Pure, and shared by every journey that renders — the discovered-surface suite,
 * the manifest interpreter and the MCP server — so all are held to one proof.
 *
 * THE DOORS ARE SIGNED. A navigation cannot carry the secret header, so each door URL carries
 * `wpj_exp` and `wpj_sig`: an HMAC-SHA256 over the door, the payload and the expiry, keyed by the
 * shared secret. It stops anyone who can merely reach the site — or a cross-site page steering a
 * logged-in admin's browser — from running shortcode and block callbacks. It is stateless rather
 * than single-use because `sentinel.visit` retries a navigation once, and a spent token would
 * turn that retry into a false red.
 *
 * A signed URL may appear in a finding or a log line. That is deliberate and low-risk: the
 * signature is bound to one payload and expires within minutes, so a replay renders only what
 * the printed URL already names. It is NOT redacted the way a login token is, because a login
 * token is a session, and this is not. Never pass it through `page.route` headers either:
 * Playwright re-sends those across redirects, including cross-origin ones.
 */
import { createHmac } from 'node:crypto';

/** The shortcode door's query parameter, which is also its name inside the signature. */
const SHORTCODE_DOOR = 'wpj_render';
/** The block door's query parameter, likewise. */
const BLOCK_DOOR = 'wpj_render_block';
type RenderDoor = typeof SHORTCODE_DOOR | typeof BLOCK_DOOR;

/**
 * How long a signed URL lives, in seconds. The agent refuses anything more than 600 s ahead of
 * its own clock, so half that leaves room for the two clocks to disagree in either direction.
 */
export const RENDER_SIGNATURE_TTL = 300;

/** The hex HMAC the agent's `wpj_render_signature()` computes over the same three values. */
export function renderSignature(door: RenderDoor, payload: string, exp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${door}\n${payload}\n${exp}`).digest('hex');
}

/** `&wpj_exp=…&wpj_sig=…` for one door and payload, expiring `RENDER_SIGNATURE_TTL` after `now`. */
function signatureQuery(door: RenderDoor, payload: string, secret: string, now: number): string {
  const exp = String(Math.floor(now) + RENDER_SIGNATURE_TTL);
  return `wpj_exp=${exp}&wpj_sig=${renderSignature(door, payload, exp, secret)}`;
}

/** The current unix time in seconds, which is what the agent compares `wpj_exp` against. */
function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** The frontend URL that renders `[tag]` through the agent's render endpoint, signed. */
export function shortcodeRenderUrl(tag: string, secret: string, now: number = unixNow()): string {
  const payload = `[${tag}]`;
  return `/?${SHORTCODE_DOOR}=${encodeURIComponent(payload)}&${signatureQuery(SHORTCODE_DOOR, payload, secret, now)}`;
}

/** Where a site path is only resolved, never visited. */
const PROBE_BASE = 'https://target.invalid';

/**
 * Sign any site path that opens a render door, and return every other path unchanged.
 *
 * Manifest authors write `readBack: "/?wpj_render=%5Bacme%5D"`, and an MCP client navigates to
 * whatever path it likes; neither can compute a signature. So the runner signs on their behalf,
 * over the DECODED payload, which is what the agent reads from `$_GET`. A stale `wpj_exp` or
 * `wpj_sig` already on the path is replaced, never sent twice.
 *
 * @param now unix seconds; the clock when omitted
 */
export function signRenderDoor(path: string, secret: string, now: number = unixNow()): string {
  const url = new URL(path, PROBE_BASE);
  const params = url.searchParams;
  const doors = ([SHORTCODE_DOOR, BLOCK_DOOR] as const).filter((door) => params.has(door));
  if (doors.length === 0) return path;
  if (doors.length > 1) {
    throw new Error(`${path} opens both render doors at once, which no single signature can cover — render one thing per path`);
  }
  const door = doors[0]!;
  const query = signatureQuery(door, params.get(door) ?? '', secret, now);

  if (!params.has('wpj_exp') && !params.has('wpj_sig')) {
    // Appended to the path as written, so everything the author wrote reaches the site as-is.
    const hash = path.indexOf('#');
    const head = hash === -1 ? path : path.slice(0, hash);
    const tail = hash === -1 ? '' : path.slice(hash);
    return `${head}&${query}${tail}`;
  }
  params.delete('wpj_exp');
  params.delete('wpj_sig');
  const rest = params.toString();
  return `${url.pathname}?${rest}&${query}${url.hash}`;
}

/**
 * Why a render of `[tag]` proved nothing, or `null` when it expanded.
 *
 * The render itself is not the assertion (R5). If the agent's guard refused, `?wpj_render=`
 * serves the ordinary home page with a perfectly good 200 and the journey would pass having
 * rendered nothing at all. So each tag is proven twice over:
 *  - `[data-wpj-render]` is present, which only the agent's endpoint emits — the proof it ran;
 *  - the marker's `data-wpj-expanded="1"`, which the AGENT sets when `do_shortcode()` changed
 *    its input — the proof the shortcode EXPANDED. WordPress returns an unregistered shortcode
 *    verbatim.
 *
 * Expansion used to be judged here, by the literal `[tag]` being absent from the page. First
 * contact broke that: Alpaca Bot's `[alpacabot_agent]` expands to a notice that QUOTES its own
 * tag, and was reported as never having expanded. Only the agent can tell an unchanged string
 * from output that happens to mention the tag, so the runner now asks it — and a marker that
 * does not answer fails, rather than falling back to the guess.
 */
export function shortcodeRenderDefect(html: string, tag: string): string | null {
  const marker = /<div data-wpj-render="1"([^>]*)>/.exec(html);
  if (!marker) {
    return `rendering [${tag}] produced no wp-journeys render marker — the agent's render `
      + 'endpoint did not run, so nothing about this shortcode was actually asserted';
  }
  const expanded = /\sdata-wpj-expanded="([01])"/.exec(marker[1] ?? '')?.[1];
  if (expanded === undefined) {
    return `the render marker does not say whether [${tag}] expanded — the wp-journeys agent on the `
      + 'site is older than this runner; remount it';
  }
  if (expanded === '0') {
    return `the shortcode [${tag}] came back verbatim — WordPress returns an unregistered `
      + 'shortcode unchanged, so it never expanded';
  }
  return null;
}

/** The frontend URL that renders one block through the agent's block door (R57), signed. */
export function blockRenderUrl(name: string, secret: string, now: number = unixNow()): string {
  return `/?${BLOCK_DOOR}=${encodeURIComponent(name)}&${signatureQuery(BLOCK_DOOR, name, secret, now)}`;
}

/** What one block render proved: a defect, or registration plus whether the block is dynamic. */
export interface BlockRenderVerdict {
  defect: string | null;
  /** Whether the block has a server render. Meaningless when `defect` is set. */
  dynamic: boolean;
}

/**
 * What a render of the block `name` proved.
 *
 * The marker proves the endpoint ran, and `data-wpj-registered` proves the block exists —
 * `render_block` answers an unregistered name with an empty string, which would otherwise read as
 * a clean render. `data-wpj-dynamic` says whether there was a server render to exercise at all
 * (R78): a STATIC block's frontend output is its saved post content, which the door cannot
 * produce, so for it registration is all that was checked, and the caller must say so.
 */
export function blockRenderVerdict(html: string, name: string): BlockRenderVerdict {
  const refuse = (defect: string): BlockRenderVerdict => ({ defect, dynamic: false });
  const marker = /<div data-wpj-render-block="1"([^>]*)>/.exec(html);
  if (!marker) {
    return refuse(`rendering the block ${name} produced no wp-journeys render marker — the agent's block `
      + 'endpoint did not run, so nothing about this block was actually asserted');
  }
  const attributes = marker[1] ?? '';
  const registered = /\sdata-wpj-registered="([01])"/.exec(attributes)?.[1];
  if (registered === undefined) {
    return refuse(`the render marker does not say whether ${name} is registered — the wp-journeys agent on `
      + 'the site is older than this runner; remount it');
  }
  if (registered === '0') {
    return refuse(`the block ${name} is not registered at render time — render_block answers an unknown block `
      + 'with nothing, so it was discovered but cannot be rendered');
  }
  const dynamic = /\sdata-wpj-dynamic="([01])"/.exec(attributes)?.[1];
  if (dynamic === undefined) {
    return refuse(`the render marker does not say whether ${name} is dynamic — the wp-journeys agent on `
      + 'the site is older than this runner; remount it');
  }
  return { defect: null, dynamic: dynamic === '1' };
}

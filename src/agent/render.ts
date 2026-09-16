/**
 * The agent's render door, as the runner drives it: `?wpj_render=[tag]` expands one shortcode
 * on the front end and prints it inside a marker. Pure, and shared by every journey that
 * renders a shortcode — the discovered-surface suite and the manifest interpreter — so both
 * are held to one proof and neither depends on the other.
 */

/** The frontend URL that renders `[tag]` through the agent's render endpoint. */
export function shortcodeRenderUrl(tag: string): string {
  return `/?wpj_render=${encodeURIComponent(`[${tag}]`)}`;
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

/** The frontend URL that renders one block through the agent's block door (R57). */
export function blockRenderUrl(name: string): string {
  return `/?wpj_render_block=${encodeURIComponent(name)}`;
}

/**
 * Why a render of the block `name` proved nothing, or `null` when it rendered.
 *
 * The same two-part proof as a shortcode, adapted to what `render_block` can say: the marker
 * proves the endpoint ran, and `data-wpj-registered` proves the block exists — `render_block`
 * answers an unregistered name with an empty string, which would otherwise read as a clean
 * render. A STATIC block passes on registration alone: its markup lives in post content, so
 * the server has nothing to render for it, and the journey asserts only that the render path
 * (the `render_block` filters, block supports) ran without a diagnostic.
 */
export function blockRenderDefect(html: string, name: string): string | null {
  const marker = /<div data-wpj-render-block="1"([^>]*)>/.exec(html);
  if (!marker) {
    return `rendering the block ${name} produced no wp-journeys render marker — the agent's block `
      + 'endpoint did not run, so nothing about this block was actually asserted';
  }
  const registered = /\sdata-wpj-registered="([01])"/.exec(marker[1] ?? '')?.[1];
  if (registered === undefined) {
    return `the render marker does not say whether ${name} is registered — the wp-journeys agent on `
      + 'the site is older than this runner; remount it';
  }
  if (registered === '0') {
    return `the block ${name} is not registered at render time — render_block answers an unknown block `
      + 'with nothing, so it was discovered but cannot be rendered';
  }
  return null;
}
